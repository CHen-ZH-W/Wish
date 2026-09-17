import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../../core/tools/authorization.js";
import { ToolExecutionError } from "../../../core/tools/executor.js";
import type {
  ToolDefinition,
  ToolInputParseResult,
} from "../../../core/tools/tool.js";
import type { WishToolExecutionContext } from
  "../../../composition/tool-context.js";
import { CoordinatorError } from "../../errors.js";
import type { Coordinator, CoordinatorState } from "../../types.js";

export interface CoordinatorToolOutput {
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
  readonly coordinator?: CoordinatorState;
}

export interface EnterCoordinatorToolInput {
  readonly goal?: string;
}

export interface ExitCoordinatorToolInput {
  readonly outcome?: string;
}

const ENTER_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    goal: { type: "string", minLength: 1, description: "Optional coordination goal" },
  },
  additionalProperties: false,
});

const READ_SCHEMA = JSON.stringify({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const EXIT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    outcome: {
      type: "string",
      minLength: 1,
      description: "Optional reconciled outcome of delegated work",
    },
  },
  additionalProperties: false,
});

export function createCoordinatorTools(
  coordinator: Coordinator,
): readonly ToolDefinition<string, any, CoordinatorToolOutput, WishToolExecutionContext>[] {
  return Object.freeze([
    {
      name: "enter_coordinator_mode",
      description:
        "Enter Run-scoped Coordinator mode. The host immediately restricts this Step to inspection, child-Agent controls, and Coordinator controls.",
      inputSchemaJson: ENTER_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseEnter,
      resolveCapabilities(_input, context) {
        return capability(
          "runtime.control",
          `coordinator.enter:${runId(context)}`,
        );
      },
      async execute(input: EnterCoordinatorToolInput, context, grant, signal) {
        const resource = `coordinator.enter:${runId(context)}`;
        assertCapability(
          grant,
          "enter_coordinator_mode",
          "runtime.control",
          resource,
        );
        try {
          const state = await coordinator.enter({
            runId: runId(context),
            sessionId: context.permissions.subject.sessionId,
            ...(input.goal === undefined ? {} : { goal: input.goal }),
            ...(signal === undefined ? {} : { signal }),
          });
          return stateOutput("Coordinator mode entered.\n" + formatState(state), state);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "read_coordinator",
      description:
        "Read durable Coordinator mode state for the current parent Run.",
      inputSchemaJson: READ_SCHEMA,
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
      parse: parseEmpty,
      resolveCapabilities(_input, context) {
        return capability("runtime.read", `coordinator.read:${runId(context)}`);
      },
      async execute(_input: Record<string, never>, context, grant, signal) {
        const resource = `coordinator.read:${runId(context)}`;
        assertCapability(grant, "read_coordinator", "runtime.read", resource);
        try {
          const state = await coordinator.get({
            runId: runId(context),
            ...(signal === undefined ? {} : { signal }),
          });
          return state === undefined
            ? textOutput("No Coordinator state exists for the current Run.")
            : stateOutput(formatState(state), state);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "exit_coordinator_mode",
      description:
        "Leave Coordinator mode after delegated work is reconciled. It does not stop or delete child Agents; broader capabilities return on the next Agent Step.",
      inputSchemaJson: EXIT_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseExit,
      resolveCapabilities(_input, context) {
        return capability("runtime.control", `coordinator.exit:${runId(context)}`);
      },
      async execute(input: ExitCoordinatorToolInput, context, grant, signal) {
        const resource = `coordinator.exit:${runId(context)}`;
        assertCapability(
          grant,
          "exit_coordinator_mode",
          "runtime.control",
          resource,
        );
        try {
          const state = await coordinator.exit({
            runId: runId(context),
            ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
            ...(signal === undefined ? {} : { signal }),
          });
          return stateOutput(
            "Coordinator mode exited. Broader capabilities return on the next Agent Step.\n" +
              formatState(state),
            state,
          );
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
  ]);
}

function parseEnter(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<EnterCoordinatorToolInput> {
  const unknown = unknownKey(input, ["goal"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (input.goal !== undefined && !nonBlank(input.goal)) {
    return invalid("goal must not be empty");
  }
  return { ok: true, input: Object.freeze({
    ...(input.goal === undefined ? {} : { goal: input.goal as string }),
  }) };
}

function parseEmpty(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<Record<string, never>> {
  const unknown = unknownKey(input, []);
  return unknown === undefined
    ? { ok: true, input: Object.freeze({}) }
    : invalid(`Unknown field: ${unknown}`);
}

function parseExit(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<ExitCoordinatorToolInput> {
  const unknown = unknownKey(input, ["outcome"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (input.outcome !== undefined && !nonBlank(input.outcome)) {
    return invalid("outcome must not be empty");
  }
  return { ok: true, input: Object.freeze({
    ...(input.outcome === undefined ? {} : { outcome: input.outcome as string }),
  }) };
}

function capability(
  kind: "runtime.read" | "runtime.control",
  resource: string,
) {
  return Object.freeze({ requirements: Object.freeze([Object.freeze({
    capability: kind,
    resources: Object.freeze([resource]),
  })]) });
}

function assertCapability(
  grant: ToolAuthorizationGrant,
  toolName: string,
  kind: "runtime.read" | "runtime.control",
  resource: string,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName });
  if (!grant.capabilities.requirements.some((requirement) =>
    requirement.capability === kind && requirement.resources.includes(resource)
  )) throw new Error(`Tool authorization Grant does not allow ${resource}`);
}

function runId(context: WishToolExecutionContext): string {
  return context.permissions.subject.runId;
}

function stateOutput(
  text: string,
  state: CoordinatorState,
): CoordinatorToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
    coordinator: state,
  });
}

function textOutput(text: string): CoordinatorToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
  });
}

function formatState(state: CoordinatorState): string {
  return [
    `Coordinator mode: ${state.active ? "active" : "inactive"}`,
    `Run: ${state.runId}`,
    `State version: ${state.version}`,
    ...(state.goal === undefined ? [] : [`Goal: ${state.goal}`]),
    ...(state.outcome === undefined ? [] : [`Outcome: ${state.outcome}`]),
  ].join("\n");
}

function toolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof CoordinatorError) {
    const code = error.code === "coordinator_not_found"
      ? "not_found"
      : error.code === "coordinator_invalid_input"
        ? "invalid_input"
        : error.code === "coordinator_conflict" ||
            error.code === "coordinator_inactive"
          ? "conflict"
          : "execution_failed";
    return new ToolExecutionError(code, error.message);
  }
  return new ToolExecutionError(
    "execution_failed",
    error instanceof Error ? error.message : String(error),
  );
}

function unknownKey(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(input).find((key) => !allowed.includes(key));
}

function invalid<Input>(message: string): ToolInputParseResult<Input> {
  return { ok: false, message };
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
