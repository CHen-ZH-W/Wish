import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../../core/tools/authorization.js";
import { ToolExecutionError } from "../../../core/tools/executor.js";
import type {
  ToolDefinition,
  ToolInputParseResult,
} from "../../../core/tools/tool.js";
import {
  PERMISSION_PROFILES,
  type PermissionProfile,
} from "../../../permissions/index.js";
import { formatModelReference } from "../../../models/config.js";
import {
  SubagentError,
} from "../../errors.js";
import type {
  SubagentRecord,
  Subagents,
  SpawnSubagentRequest,
} from "../../types.js";
import type { WishToolExecutionContext } from "../../../composition/tool-context.js";
import type { RunContinuation } from "../../../core/runtime/continuation.js";

export const SUBAGENT_TOOL_NAMES = Object.freeze([
  "spawn_agent",
  "list_agents",
  "capture_agent",
  "send_agent",
  "stop_agent",
  "collect_agent",
] as const);

export interface SpawnAgentToolInput {
  readonly task: string;
  readonly role?: string;
  readonly model?: string;
  readonly permissionProfile?: PermissionProfile;
  readonly availableTools?: readonly string[];
}

export interface ListAgentsToolInput {
  readonly status?: SubagentRecord["status"];
}

export interface AgentIdToolInput {
  readonly id: string;
}

export interface CaptureAgentToolInput extends AgentIdToolInput {
  readonly lines?: number;
}

export interface SendAgentToolInput extends AgentIdToolInput {
  readonly text: string;
  readonly enter?: boolean;
}

export interface AgentToolOutput {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly agent?: SubagentRecord;
  readonly agents?: readonly SubagentRecord[];
}

export interface SubagentToolOptions {
  readonly subagents: Subagents;
  /** Optional host dispatch port; the Tool never owns scheduling state. */
  readonly dispatch?: (request: SpawnSubagentRequest, context: WishToolExecutionContext, grant: ToolAuthorizationGrant) => Promise<SubagentRecord | AgentToolOutput>;
  readonly completionObserver?: SubagentToolCompletionObserver;
}

/** Optional bridge supplied by the host composition; Tool definitions do not own Runtime state. */
export interface SubagentToolCompletionObserver {
  watch(input: {
    readonly record: SubagentRecord;
    readonly continuation: RunContinuation;
    readonly signal?: AbortSignal;
  }): void;
}

const SPAWN_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    task: { type: "string", minLength: 1, description: "Bounded task for the child Agent" },
    role: { type: "string", minLength: 1, description: "Short role label, for example reviewer or tester" },
    model: { type: "string", minLength: 1, description: "Optional provider/model reference" },
    permissionProfile: { type: "string", enum: PERMISSION_PROFILES },
    availableTools: {
      type: "array",
      items: { type: "string", minLength: 1 },
      maxItems: 64,
      description: "Optional child Tool allow-list; cannot exceed the host ceiling",
    },
  },
  required: ["task"],
  additionalProperties: false,
});

const LIST_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["starting", "running", "exited", "stopped", "failed", "lost"],
    },
  },
  additionalProperties: false,
});

const ID_SCHEMA = JSON.stringify({
  type: "object",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
  additionalProperties: false,
});

const CAPTURE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    lines: { type: "integer", minimum: 1 },
  },
  required: ["id"],
  additionalProperties: false,
});

const SEND_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    text: { type: "string" },
    enter: { type: "boolean", description: "Send Enter after the literal text; defaults to true" },
  },
  required: ["id", "text"],
  additionalProperties: false,
});

export function createSubagentTools(
  options: SubagentToolOptions,
): readonly ToolDefinition<string, any, AgentToolOutput, WishToolExecutionContext>[] {
  const subagents = options.subagents;
  return Object.freeze([
    {
      name: "spawn_agent",
      description:
        "Start one bounded child Agent in a transparent terminal execution. Returns the child id plus copyable attach and capture commands; use list_agents or collect_agent after context compaction.",
      inputSchemaJson: SPAWN_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseSpawn,
      resolveCapabilities(input: SpawnAgentToolInput) {
        return controlCapability(`subagents.spawn:${input.role ?? "worker"}`);
      },
      async execute(input: SpawnAgentToolInput, context, grant, signal) {
        assertCapability(grant, "spawn_agent", "runtime.control", `subagents.spawn:${input.role ?? "worker"}`);
        try {
          const request: SpawnSubagentRequest = {
            parentAgentId: context.permissions.subject.agentId,
            parentSessionId: context.permissions.subject.sessionId,
            parentRunId: context.permissions.subject.runId,
            workspaceRoot: context.workspace.root,
            task: input.task,
            allowedCapabilities: context.permissions.delegation?.allowedCapabilities ?? context.permissions.ceiling.allowedCapabilities,
            ...(input.role === undefined ? {} : { role: input.role }),
            ...(input.model !== undefined
              ? { model: input.model }
              : context.modelContext === undefined
                ? {}
                : { model: formatModelReference(context.modelContext.ref) }),
            ...(context.modelContext?.configuration === undefined
              ? {}
              : { modelsConfiguration: context.modelContext.configuration }),
            ...(input.permissionProfile === undefined ? {} : { permissionProfile: input.permissionProfile }),
            ...(input.availableTools === undefined ? {} : { availableTools: input.availableTools }),
            ...(signal === undefined ? {} : { signal }),
          };
          const record = await (options.dispatch ? options.dispatch(request, context, grant!) : subagents.spawn(request));
          if ("content" in record) return record;
          if (context.runContinuation !== undefined) {
            options.completionObserver?.watch({
              record,
              continuation: context.runContinuation,
              ...(signal === undefined ? {} : { signal }),
            });
          }
          return subagentRecordOutput("Started", record);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "list_agents",
      description:
        "List child Agents owned by the current parent Run and reconcile their execution status.",
      inputSchemaJson: LIST_SCHEMA,
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
      parse: parseList,
      resolveCapabilities() { return readCapability("subagents.list"); },
      async execute(input: ListAgentsToolInput, context, grant, signal) {
        assertCapability(grant, "list_agents", "runtime.read", "subagents.list");
        try {
          const listed = await subagents.list({
            parentAgentId: context.permissions.subject.agentId,
            parentSessionId: context.permissions.subject.sessionId,
            parentRunId: context.permissions.subject.runId,
            workspaceRoot: context.workspace.root,
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(signal === undefined ? {} : { signal }),
          });
          const agents = Object.freeze([...listed]);
          const text = agents.length === 0
            ? "No child Agents for the current Run."
            : agents.map(formatRecord).join("\n\n");
          return Object.freeze({
            content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
            agents,
          });
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    readTool("capture_agent", CAPTURE_SCHEMA, parseCapture, async (input, context, signal) => {
      const output = await subagents.capture({
        id: input.id,
        ...owner(context),
        ...(input.lines === undefined ? {} : { lines: input.lines }),
        ...(signal === undefined ? {} : { signal }),
      });
      return Object.freeze({
        content: Object.freeze([Object.freeze({ type: "text" as const, text: output })]),
      });
    }, "Capture the latest bounded terminal output from a child Agent."),
    {
      name: "send_agent",
      description:
        "Send literal input to a running child Agent terminal. This is visible to an attached operator.",
      inputSchemaJson: SEND_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseSend,
      resolveCapabilities(input: SendAgentToolInput) {
        return controlCapability(`subagents.send:${input.id}`);
      },
      async execute(input: SendAgentToolInput, context, grant, signal) {
        assertCapability(grant, "send_agent", "runtime.control", `subagents.send:${input.id}`);
        try {
          await subagents.send({
            id: input.id,
            ...owner(context),
            text: input.text,
            ...(input.enter === undefined ? {} : { enter: input.enter }),
            ...(signal === undefined ? {} : { signal }),
          });
          return textOutput(`Sent input to child Agent ${input.id}.`);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    controlIdTool(
      "stop_agent",
      "Stop a child Agent through its execution Provider. The operation is idempotent.",
      "stop",
      async (input, context, signal) => subagentRecordOutput(
        "Stopped",
        await subagents.stop({
          id: input.id,
          ...owner(context),
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
    ),
    readTool("collect_agent", ID_SCHEMA, parseId, async (input, context, signal) => {
      const collected = await subagents.collect({
        id: input.id,
        ...owner(context),
        ...(signal === undefined ? {} : { signal }),
      });
      return Object.freeze({
        content: Object.freeze([Object.freeze({
          type: "text" as const,
          text: [formatRecord(collected.record), collected.output ?? "(terminal output unavailable)"].join("\n\n"),
        })]),
        agent: collected.record,
      });
    }, "Collect the latest status and bounded terminal output for one child Agent."),
  ]);
}

function readTool<Input extends AgentIdToolInput>(
  name: "capture_agent" | "collect_agent",
  schema: string,
  parse: (input: Readonly<Record<string, unknown>>) => ToolInputParseResult<Input>,
  execute: (input: Input, context: WishToolExecutionContext, signal?: AbortSignal) => Promise<AgentToolOutput>,
  description: string,
): ToolDefinition<typeof name, Input, AgentToolOutput, WishToolExecutionContext> {
  return {
    name,
    description,
    inputSchemaJson: schema,
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse,
    resolveCapabilities(input) { return readCapability(`subagents.read:${input.id}`); },
    async execute(input, context, grant, signal) {
      assertCapability(grant, name, "runtime.read", `subagents.read:${input.id}`);
      try {
        return await execute(input, context, signal);
      } catch (error: unknown) {
        throw toolError(error);
      }
    },
  };
}

function controlIdTool(
  name: "stop_agent",
  description: string,
  action: string,
  execute: (
    input: AgentIdToolInput,
    context: WishToolExecutionContext,
    signal?: AbortSignal,
  ) => Promise<AgentToolOutput>,
): ToolDefinition<typeof name, AgentIdToolInput, AgentToolOutput, WishToolExecutionContext> {
  return {
    name,
    description,
    inputSchemaJson: ID_SCHEMA,
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse: parseId,
    resolveCapabilities(input) { return controlCapability(`subagents.${action}:${input.id}`); },
    async execute(input, context, grant, signal) {
      assertCapability(grant, name, "runtime.control", `subagents.${action}:${input.id}`);
      try {
        return await execute(input, context, signal);
      } catch (error: unknown) {
        throw toolError(error);
      }
    },
  };
}

function parseSpawn(input: Readonly<Record<string, unknown>>): ToolInputParseResult<SpawnAgentToolInput> {
  const unknown = unknownKey(input, ["task", "role", "model", "permissionProfile", "availableTools"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.task)) return invalid("task must not be empty");
  if (input.role !== undefined && !identifierValue(input.role)) return invalid("role must be non-empty trimmed text");
  if (input.model !== undefined && !identifierValue(input.model)) return invalid("model must be non-empty trimmed text");
  if (input.permissionProfile !== undefined && !(PERMISSION_PROFILES as readonly unknown[]).includes(input.permissionProfile)) {
    return invalid("permissionProfile is invalid");
  }
  if (input.availableTools !== undefined && (
    !Array.isArray(input.availableTools) || input.availableTools.length > 64 ||
    input.availableTools.some((tool) => !identifierValue(tool)) ||
    new Set(input.availableTools).size !== input.availableTools.length
  )) return invalid("availableTools must contain at most 64 non-empty identifiers");
  return { ok: true, input: Object.freeze({
    task: input.task as string,
    ...(input.role === undefined ? {} : { role: input.role as string }),
    ...(input.model === undefined ? {} : { model: input.model as string }),
    ...(input.permissionProfile === undefined ? {} : { permissionProfile: input.permissionProfile as PermissionProfile }),
    ...(input.availableTools === undefined ? {} : { availableTools: Object.freeze([...(input.availableTools as string[])]) }),
  }) };
}

function parseList(input: Readonly<Record<string, unknown>>): ToolInputParseResult<ListAgentsToolInput> {
  const unknown = unknownKey(input, ["status"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (
    input.status !== undefined &&
    (typeof input.status !== "string" || !SUBAGENT_STATUSES.has(input.status))
  ) return invalid("status is invalid");
  return { ok: true, input: Object.freeze({
    ...(input.status === undefined ? {} : { status: input.status as SubagentRecord["status"] }),
  }) };
}

function parseId(input: Readonly<Record<string, unknown>>): ToolInputParseResult<AgentIdToolInput> {
  const unknown = unknownKey(input, ["id"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!identifierValue(input.id)) return invalid("id must be non-empty trimmed text");
  return { ok: true, input: Object.freeze({ id: input.id }) };
}

function parseCapture(input: Readonly<Record<string, unknown>>): ToolInputParseResult<CaptureAgentToolInput> {
  const unknown = unknownKey(input, ["id", "lines"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!identifierValue(input.id)) return invalid("id must be non-empty trimmed text");
  if (input.lines !== undefined && (!Number.isSafeInteger(input.lines) || (input.lines as number) < 1)) {
    return invalid("lines must be a positive safe integer");
  }
  return { ok: true, input: Object.freeze({
    id: input.id,
    ...(input.lines === undefined ? {} : { lines: input.lines as number }),
  }) };
}

function parseSend(input: Readonly<Record<string, unknown>>): ToolInputParseResult<SendAgentToolInput> {
  const unknown = unknownKey(input, ["id", "text", "enter"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!identifierValue(input.id)) return invalid("id must be non-empty trimmed text");
  if (typeof input.text !== "string") return invalid("text must be a string");
  if (input.enter !== undefined && typeof input.enter !== "boolean") return invalid("enter must be a boolean");
  return { ok: true, input: Object.freeze({
    id: input.id,
    text: input.text,
    ...(input.enter === undefined ? {} : { enter: input.enter }),
  }) };
}

const SUBAGENT_STATUSES = new Set<string>([
  "starting", "running", "exited", "stopped", "failed", "lost",
]);

function readCapability(resource: string) {
  return { requirements: [{ capability: "runtime.read" as const, resources: [resource] }] };
}

function controlCapability(resource: string) {
  return { requirements: [{ capability: "runtime.control" as const, resources: [resource] }] };
}

function assertCapability(
  grant: ToolAuthorizationGrant,
  toolName: string,
  capability: "runtime.read" | "runtime.control",
  resource: string,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName });
  if (!grant.capabilities.requirements.some((requirement) =>
    requirement.capability === capability && requirement.resources.includes(resource)
  )) throw new Error(`Tool authorization Grant does not allow ${resource}`);
}

function owner(
  context: WishToolExecutionContext,
): {
  readonly parentAgentId: string;
  readonly parentSessionId: string;
  readonly parentRunId: string;
  readonly workspaceRoot: string;
} {
  const subject = context.permissions.subject;
  return {
    parentAgentId: subject.agentId,
    parentSessionId: subject.sessionId,
    parentRunId: subject.runId,
    workspaceRoot: context.workspace.root,
  };
}

export function subagentRecordOutput(action: string, record: SubagentRecord): AgentToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({
      type: "text" as const,
      text: `${action} child Agent.\n${formatRecord(record)}`,
    })]),
    agent: record,
  });
}

function textOutput(text: string): AgentToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
  });
}

function formatRecord(record: SubagentRecord): string {
  return [
    `Agent: ${record.id}`,
    `Role: ${record.role}`,
    `Status: ${record.status}`,
    `Parent Run: ${record.parentRunId}`,
    ...(record.exitCode === undefined ? [] : [`Exit code: ${record.exitCode}`]),
    ...(record.failure === undefined ? [] : [`Failure: ${record.failure}`]),
    ...(record.target === undefined ? [] : [
      `Execution target: ${record.target.target}`,
      `Attach: ${record.target.attachCommand}`,
      `Capture: ${record.target.captureCommand}`,
    ]),
  ].join("\n");
}

function toolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof SubagentError) {
    const code = error.code === "subagent_not_found"
      ? "not_found"
      : error.code === "subagent_invalid_input"
        ? "invalid_input"
        : error.code === "subagent_conflict" || error.code === "subagent_limit_exceeded" || error.code === "subagent_not_running"
          ? "conflict"
          : "execution_failed";
    return new ToolExecutionError(code, error.message);
  }
  return new ToolExecutionError(
    "execution_failed",
    error instanceof Error ? error.message : String(error),
  );
}

function unknownKey(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): string | undefined {
  return Object.keys(input).find((key) => !allowed.includes(key));
}

function invalid<Input>(message: string): ToolInputParseResult<Input> {
  return { ok: false, message };
}

function identifierValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
