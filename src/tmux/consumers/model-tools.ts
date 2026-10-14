import type { Context } from "@deepseek-ai/cordis";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type {
  ToolDefinition,
  ToolInputParseResult,
} from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { Shell } from "../../shell/types.js";
import {
  resolveBashPermissions,
  type BashToolPermissions,
} from "../../shell/consumers/model-tool.js";
import { ShellError } from "../../shell/errors.js";
import { ManagedToolOwner } from "../../tools/managed.js";
import { TmuxError } from "../errors.js";
import type { Tmux, TmuxSessionSnapshot } from "../types.js";

export const TMUX_TOOL_NAMES = Object.freeze([
  "tmux_start",
  "tmux_list",
  "tmux_capture",
  "tmux_send",
  "tmux_stop",
] as const);

interface StartInput {
  readonly command: string;
  readonly id?: string;
  readonly label?: string;
  readonly permissions?: BashToolPermissions;
}

interface IdInput {
  readonly id: string;
}

interface CaptureInput extends IdInput {
  readonly lines?: number;
}

interface SendInput extends IdInput {
  readonly text: string;
  readonly enter?: boolean;
}

export interface TmuxToolOutput {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly terminal?: TmuxSessionSnapshot;
  readonly terminals?: readonly TmuxSessionSnapshot[];
}

export interface TmuxToolOptions {
  readonly shell: Shell;
  readonly tmux: Tmux;
}

const PERMISSIONS_SCHEMA = {
  type: "object",
  description: "Least authority required by the terminal command.",
  properties: {
    filesystem: {
      oneOf: [
        { type: "string", enum: ["read", "write"] },
        {
          type: "object",
          properties: {
            read: { type: "array", items: { type: "string" }, maxItems: 128 },
            write: { type: "array", items: { type: "string" }, maxItems: 128 },
          },
          required: ["read", "write"],
          additionalProperties: false,
        },
      ],
    },
    network: { type: "boolean" },
    externalSideEffect: { type: "boolean" },
    destructive: { type: "boolean" },
  },
  required: ["filesystem", "network", "externalSideEffect", "destructive"],
  additionalProperties: false,
};

const START_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, description: "Long-running shell command" },
    id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "Optional stable terminal id" },
    label: { type: "string", minLength: 1, maxLength: 96, description: "Human-readable terminal label" },
    permissions: PERMISSIONS_SCHEMA,
  },
  required: ["command"],
  additionalProperties: false,
});

const LIST_SCHEMA = JSON.stringify({ type: "object", properties: {}, additionalProperties: false });
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
    lines: { type: "integer", minimum: 1, maximum: 2_000 },
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

export function createTmuxTools(
  options: TmuxToolOptions,
): readonly ToolDefinition<string, any, TmuxToolOutput, WishToolExecutionContext>[] {
  return Object.freeze([
    {
      name: "tmux_start",
      description:
        "Start a long-running or interactive command in a Wish-managed tmux terminal. The command keeps the current Shell permission boundary, appears in the session sidebar, remains discoverable after context compaction, and retains its final screen until tmux_stop or manual deletion.",
      inputSchemaJson: START_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseStart,
      resolveCapabilities(input: StartInput, context) {
        const permissions = resolveBashPermissions(input);
        return {
          requirements: [
            {
              capability: "process.exec" as const,
              commands: [input.command],
              cwd: context.cwd,
              timeoutSeconds: options.shell.policy.resourceLimits.maxTimeoutSeconds,
            },
            ...(permissions.readPaths.length === 0 ? [] : [{
              capability: "filesystem.read" as const,
              paths: permissions.readPaths,
            }]),
            ...(permissions.writePaths.length === 0 ? [] : [{
              capability: "filesystem.write" as const,
              paths: permissions.writePaths,
            }]),
            ...(permissions.network ? [{ capability: "network.connect" as const, hosts: ["*"] }] : []),
            ...(permissions.externalSideEffect ? [{
              capability: "external.side_effect" as const,
              resources: ["*"],
            }] : []),
            { capability: "runtime.control" as const, resources: ["tmux.start"] },
          ],
          effects: {
            destructive: permissions.destructive,
            openWorld: permissions.network || permissions.externalSideEffect,
          },
        };
      },
      async execute(input: StartInput, context, grant, signal) {
        assertGrant(grant, "tmux_start");
        try {
          const spec = await options.shell.resolve({
            command: input.command,
            cwd: context.cwd,
            timeoutSeconds: options.shell.policy.resourceLimits.maxTimeoutSeconds,
            context,
            grant,
            ...(signal === undefined ? {} : { signal }),
          });
          const command = await options.shell.prepare({
            spec,
            ...(signal === undefined ? {} : { signal }),
          });
          const id = input.id ?? grant.subject.id;
          const label = input.label ?? input.id ?? "terminal";
          const terminal = await options.tmux.start({
            sessionId: id,
            windowName: label,
            command,
            metadata: { workspaceRoot: context.workspace.root, label },
            ...(signal === undefined ? {} : { signal }),
          });
          return terminalOutput("Started", terminal);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "tmux_list",
      description: "List Wish-managed tmux terminals in the current Workspace from the real tmux server.",
      inputSchemaJson: LIST_SCHEMA,
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
      parse: parseList,
      resolveCapabilities() { return readCapability("tmux.list"); },
      async execute(_input, context, grant, signal) {
        assertResource(grant, "tmux_list", "runtime.read", "tmux.list");
        try {
          const terminals = await options.tmux.list({
            workspaceRoot: context.workspace.root,
            ...(signal === undefined ? {} : { signal }),
          });
          return Object.freeze({
            content: Object.freeze([Object.freeze({
              type: "text" as const,
              text: terminals.length === 0
                ? "No Wish-managed tmux terminals in this Workspace."
                : terminals.map(formatTerminal).join("\n\n"),
            })]),
            terminals,
          });
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    readIdTool("tmux_capture", CAPTURE_SCHEMA, parseCapture,
      "Capture bounded recent output from a Wish-managed tmux terminal.",
      async (input: CaptureInput, context, signal) => {
        const terminal = await findTerminal(options.tmux, context.workspace.root, input.id, signal);
        const output = await options.tmux.capture({
          target: terminal.target,
          ...(input.lines === undefined ? {} : { lines: input.lines }),
          ...(signal === undefined ? {} : { signal }),
        });
        return Object.freeze({
          content: Object.freeze([Object.freeze({ type: "text" as const, text: output })]),
          terminal,
        });
      }),
    {
      name: "tmux_send",
      description: "Send literal input to a running Wish-managed tmux terminal.",
      inputSchemaJson: SEND_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseSend,
      resolveCapabilities(input: SendInput) { return controlCapability(`tmux.send:${input.id}`); },
      async execute(input: SendInput, context, grant, signal) {
        assertResource(grant, "tmux_send", "runtime.control", `tmux.send:${input.id}`);
        try {
          const terminal = await findTerminal(options.tmux, context.workspace.root, input.id, signal);
          await options.tmux.send({
            target: terminal.target,
            text: input.text,
            ...(input.enter === undefined ? {} : { enter: input.enter }),
            ...(signal === undefined ? {} : { signal }),
          });
          return terminalOutput("Sent input to", terminal);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "tmux_stop",
      description: "Stop and remove one Wish-managed tmux terminal, including its retained final screen.",
      inputSchemaJson: ID_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseId,
      resolveCapabilities(input: IdInput) {
        return {
          ...controlCapability(`tmux.stop:${input.id}`),
          effects: { destructive: true },
        };
      },
      async execute(input: IdInput, context, grant, signal) {
        assertResource(grant, "tmux_stop", "runtime.control", `tmux.stop:${input.id}`);
        try {
          const terminal = await findTerminal(options.tmux, context.workspace.root, input.id, signal);
          await options.tmux.stop({
            target: terminal.target,
            ...(signal === undefined ? {} : { signal }),
          });
          return terminalOutput("Stopped and removed", terminal);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
  ]);
}

function readIdTool<Input extends IdInput>(
  name: "tmux_capture",
  schema: string,
  parse: (input: Readonly<Record<string, unknown>>) => ToolInputParseResult<Input>,
  description: string,
  execute: (input: Input, context: WishToolExecutionContext, signal?: AbortSignal) => Promise<TmuxToolOutput>,
): ToolDefinition<typeof name, Input, TmuxToolOutput, WishToolExecutionContext> {
  return {
    name,
    description,
    inputSchemaJson: schema,
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse,
    resolveCapabilities(input) { return readCapability(`tmux.read:${input.id}`); },
    async execute(input, context, grant, signal) {
      assertResource(grant, name, "runtime.read", `tmux.read:${input.id}`);
      try { return await execute(input, context, signal); }
      catch (error: unknown) { throw toolError(error); }
    },
  };
}

async function findTerminal(
  tmux: Tmux,
  workspaceRoot: string,
  id: string,
  signal?: AbortSignal,
): Promise<TmuxSessionSnapshot> {
  const terminal = (await tmux.list({
    workspaceRoot,
    ...(signal === undefined ? {} : { signal }),
  })).find((item) => item.target.sessionId === id);
  if (terminal === undefined) {
    throw new ToolExecutionError("not_found", `tmux terminal ${JSON.stringify(id)} is unavailable in this Workspace`);
  }
  return terminal;
}

function terminalOutput(action: string, terminal: TmuxSessionSnapshot): TmuxToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({
      type: "text" as const,
      text: `${action} tmux terminal.\n${formatTerminal(terminal)}`,
    })]),
    terminal,
  });
}

function formatTerminal(terminal: TmuxSessionSnapshot): string {
  return [
    `Terminal: ${terminal.target.sessionId}`,
    `Label: ${terminal.metadata.label ?? terminal.target.sessionId}`,
    `Status: ${terminal.active ? "running" : "exited"}`,
    ...(terminal.exitCode === undefined ? [] : [`Exit code: ${terminal.exitCode}`]),
    `Target: ${terminal.target.target}`,
    `Attach: ${terminal.target.attachCommand}`,
    `Capture: ${terminal.target.captureCommand}`,
  ].join("\n");
}

function readCapability(resource: string) {
  return { requirements: [{ capability: "runtime.read" as const, resources: [resource] }] };
}

function controlCapability(resource: string) {
  return { requirements: [{ capability: "runtime.control" as const, resources: [resource] }] };
}

function assertGrant(grant: ToolAuthorizationGrant, toolName: string): void {
  assertActiveToolAuthorizationGrant(grant, { toolName });
}

function assertResource(
  grant: ToolAuthorizationGrant,
  toolName: string,
  capability: "runtime.read" | "runtime.control",
  resource: string,
): void {
  assertGrant(grant, toolName);
  if (!grant.capabilities.requirements.some((requirement) =>
    requirement.capability === capability && requirement.resources.includes(resource)
  )) throw new Error(`Tool authorization Grant does not allow ${resource}`);
}

function parseStart(input: Readonly<Record<string, unknown>>): ToolInputParseResult<StartInput> {
  const unknown = unknownKey(input, ["command", "id", "label", "permissions"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.command)) return invalid("command must not be empty");
  if (input.id !== undefined && (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.id))) {
    return invalid("id must contain 1-64 letters, digits, underscores, or hyphens");
  }
  if (input.label !== undefined && (!nonBlank(input.label) || input.label.length > 96)) {
    return invalid("label must contain 1-96 non-blank characters");
  }
  const permissions = parsePermissions(input.permissions);
  if (permissions === null) return invalid("permissions must contain filesystem, network, externalSideEffect, and destructive");
  return { ok: true, input: Object.freeze({
    command: input.command,
    ...(input.id === undefined ? {} : { id: input.id as string }),
    ...(input.label === undefined ? {} : { label: input.label as string }),
    ...(permissions === undefined ? {} : { permissions }),
  }) };
}

function parseList(input: Readonly<Record<string, unknown>>): ToolInputParseResult<Record<string, never>> {
  const unknown = unknownKey(input, []);
  return unknown === undefined ? { ok: true, input: Object.freeze({}) } : invalid(`Unknown field: ${unknown}`);
}

function parseId(input: Readonly<Record<string, unknown>>): ToolInputParseResult<IdInput> {
  const unknown = unknownKey(input, ["id"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.id)) return invalid("id must not be empty");
  return { ok: true, input: Object.freeze({ id: input.id }) };
}

function parseCapture(input: Readonly<Record<string, unknown>>): ToolInputParseResult<CaptureInput> {
  const unknown = unknownKey(input, ["id", "lines"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.id)) return invalid("id must not be empty");
  if (input.lines !== undefined && (!Number.isSafeInteger(input.lines) || (input.lines as number) < 1 || (input.lines as number) > 2_000)) {
    return invalid("lines must be a positive integer no greater than 2000");
  }
  return { ok: true, input: Object.freeze({
    id: input.id,
    ...(input.lines === undefined ? {} : { lines: input.lines as number }),
  }) };
}

function parseSend(input: Readonly<Record<string, unknown>>): ToolInputParseResult<SendInput> {
  const unknown = unknownKey(input, ["id", "text", "enter"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.id)) return invalid("id must not be empty");
  if (typeof input.text !== "string") return invalid("text must be a string");
  if (input.enter !== undefined && typeof input.enter !== "boolean") return invalid("enter must be a boolean");
  return { ok: true, input: Object.freeze({
    id: input.id,
    text: input.text,
    ...(input.enter === undefined ? {} : { enter: input.enter }),
  }) };
}

function parsePermissions(value: unknown): BashToolPermissions | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || unknownKey(value, ["filesystem", "network", "externalSideEffect", "destructive"]) !== undefined) return null;
  const filesystem = value.filesystem;
  let parsedFilesystem: BashToolPermissions["filesystem"];
  if (filesystem === "read" || filesystem === "write") parsedFilesystem = filesystem;
  else if (
    isRecord(filesystem) && unknownKey(filesystem, ["read", "write"]) === undefined &&
    stringArray(filesystem.read) && stringArray(filesystem.write)
  ) parsedFilesystem = { read: Object.freeze([...filesystem.read]), write: Object.freeze([...filesystem.write]) };
  else return null;
  if (typeof value.network !== "boolean" || typeof value.externalSideEffect !== "boolean" || typeof value.destructive !== "boolean") return null;
  return Object.freeze({
    filesystem: parsedFilesystem,
    network: value.network,
    externalSideEffect: value.externalSideEffect,
    destructive: value.destructive,
  });
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every((item) => typeof item === "string");
}

function unknownKey(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): string | undefined {
  return Object.keys(input).find((key) => !allowed.includes(key));
}

function invalid<Input>(message: string): ToolInputParseResult<Input> {
  return { ok: false, message };
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof TmuxError) {
    const code = error.code === "tmux_not_found"
      ? "not_found"
      : error.code === "tmux_invalid_input"
        ? "invalid_input"
        : error.code === "tmux_conflict"
          ? "conflict"
          : "execution_failed";
    return new ToolExecutionError(code, error.message);
  }
  if (error instanceof ShellError) {
    return new ToolExecutionError(
      error.code === "shell_invalid_input" ? "invalid_input" : "execution_failed",
      error.message,
    );
  }
  return new ToolExecutionError("execution_failed", error instanceof Error ? error.message : String(error));
}

export const TmuxTools = {
  name: "tmux-tools",
  inject: ["tools", "shell", "tmux"],
  apply(ctx: Context): void {
    const owner = new ManagedToolOwner(ctx, { code: "tmux_tools", codeReload: true });
    for (const definition of createTmuxTools({ shell: ctx.shell, tmux: ctx.tmux })) {
      owner.register(definition);
    }
  },
};

export default TmuxTools;
