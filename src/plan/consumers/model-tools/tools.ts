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
import { PlanError } from "../../errors.js";
import type { Plan, PlanState } from "../../types.js";

export interface PlanToolOutput {
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
  readonly plan?: PlanState;
}

export interface EnterPlanToolInput {
  readonly goal?: string;
}

export interface UpdatePlanToolInput {
  readonly plan: string;
}

export interface ExitPlanToolInput {
  readonly plan: string;
  readonly expectedPlanVersion: number;
  readonly summary?: string;
}

const ENTER_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    goal: { type: "string", minLength: 1, description: "Optional planning goal" },
  },
  additionalProperties: false,
});

const EMPTY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {},
  additionalProperties: false,
});

const UPDATE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    plan: { type: "string", minLength: 1, description: "Complete current Plan in Markdown" },
  },
  required: ["plan"],
  additionalProperties: false,
});

const EXIT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    plan: {
      type: "string",
      minLength: 1,
      description: "Exact complete Plan previously saved with update_plan",
    },
    expectedPlanVersion: { type: "integer", minimum: 1 },
    summary: { type: "string", minLength: 1 },
  },
  required: ["plan", "expectedPlanVersion"],
  additionalProperties: false,
});

export function createPlanTools(
  plan: Plan,
): readonly ToolDefinition<string, any, PlanToolOutput, WishToolExecutionContext>[] {
  return Object.freeze([
    {
      name: "enter_plan_mode",
      description:
        "Enter Session-scoped Plan mode. The host immediately restricts this Step to inspection and Plan controls; execution is restored only on a later Step after approval.",
      inputSchemaJson: ENTER_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseEnter,
      resolveCapabilities(_input, context) {
        return capability("runtime.control", `plan.enter:${sessionId(context)}`);
      },
      async execute(input: EnterPlanToolInput, context, grant, signal) {
        const resource = `plan.enter:${sessionId(context)}`;
        assertCapability(grant, "enter_plan_mode", "runtime.control", resource);
        try {
          return stateOutput("Plan mode entered.", await plan.enter({
            sessionId: sessionId(context),
            ...(input.goal === undefined ? {} : { goal: input.goal }),
            ...(signal === undefined ? {} : { signal }),
          }));
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "read_plan",
      description:
        "Read the durable Plan state for the current Session, including the saved version and digest.",
      inputSchemaJson: EMPTY_SCHEMA,
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
      parse: parseEmpty,
      resolveCapabilities(_input, context) {
        return capability("runtime.read", `plan.read:${sessionId(context)}`);
      },
      async execute(_input: Record<string, never>, context, grant, signal) {
        const resource = `plan.read:${sessionId(context)}`;
        assertCapability(grant, "read_plan", "runtime.read", resource);
        try {
          const state = await plan.get({
            sessionId: sessionId(context),
            ...(signal === undefined ? {} : { signal }),
          });
          return state === undefined
            ? textOutput("No Plan state exists for the current Session.")
            : stateOutput(formatState(state), state);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "update_plan",
      description:
        "Replace the complete durable Plan draft for the current Session. Returns the exact version required by exit_plan_mode.",
      inputSchemaJson: UPDATE_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseUpdate,
      resolveCapabilities(_input, context) {
        return capability("runtime.control", `plan.update:${sessionId(context)}`);
      },
      async execute(input: UpdatePlanToolInput, context, grant, signal) {
        const resource = `plan.update:${sessionId(context)}`;
        assertCapability(grant, "update_plan", "runtime.control", resource);
        try {
          const state = await plan.update({
            sessionId: sessionId(context),
            markdown: input.plan,
            ...(signal === undefined ? {} : { signal }),
          });
          return stateOutput("Plan draft saved.\n" + formatState(state), state);
        } catch (error: unknown) {
          throw toolError(error);
        }
      },
    },
    {
      name: "exit_plan_mode",
      description:
        "Submit the exact saved Plan for human review. Returns immediately with a durable pending review; stay in Plan mode and await feedback. Only the human review surface can approve or request changes.",
      inputSchemaJson: EXIT_SCHEMA,
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse: parseExit,
      resolveCapabilities(_input, context) {
        return capability("runtime.control", `plan.approve:${sessionId(context)}`);
      },
      async execute(input: ExitPlanToolInput, context, grant, signal) {
        const resource = `plan.approve:${sessionId(context)}`;
        assertCapability(grant, "exit_plan_mode", "runtime.control", resource);
        try {
          const state = await plan.review({
            sessionId: sessionId(context),
            markdown: input.plan,
            expectedPlanVersion: input.expectedPlanVersion,
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            ...(signal === undefined ? {} : { signal }),
          });
          return stateOutput(
            "Plan submitted for review. Still in Plan mode. Await user feedback; do not resubmit unchanged or execute.\n" +
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
): ToolInputParseResult<EnterPlanToolInput> {
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

function parseUpdate(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<UpdatePlanToolInput> {
  const unknown = unknownKey(input, ["plan"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.plan)) return invalid("plan must not be empty");
  return { ok: true, input: Object.freeze({ plan: input.plan }) };
}

function parseExit(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<ExitPlanToolInput> {
  const unknown = unknownKey(input, ["plan", "expectedPlanVersion", "summary"]);
  if (unknown !== undefined) return invalid(`Unknown field: ${unknown}`);
  if (!nonBlank(input.plan)) return invalid("plan must not be empty");
  if (!Number.isSafeInteger(input.expectedPlanVersion) || (input.expectedPlanVersion as number) < 1) {
    return invalid("expectedPlanVersion must be a positive safe integer");
  }
  if (input.summary !== undefined && !nonBlank(input.summary)) {
    return invalid("summary must not be empty");
  }
  return { ok: true, input: Object.freeze({
    plan: input.plan,
    expectedPlanVersion: input.expectedPlanVersion as number,
    ...(input.summary === undefined ? {} : { summary: input.summary as string }),
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

function sessionId(context: WishToolExecutionContext): string {
  return context.permissions.subject.sessionId;
}

function stateOutput(text: string, state: PlanState): PlanToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
    plan: state,
  });
}

function textOutput(text: string): PlanToolOutput {
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
  });
}

function formatState(state: PlanState): string {
  return [
    `Plan mode: ${state.active ? "active" : "inactive"}`,
    `State version: ${state.version}`,
    ...(state.review === undefined ? [] : [`Review: ${state.review.id} (${state.review.status})`,
      ...(state.review.feedback === undefined ? [] : [`User feedback: ${state.review.feedback}`])]),
    ...(state.goal === undefined ? [] : [`Goal: ${state.goal}`]),
    ...(state.document === undefined ? ["Document: not saved"] : [
      `Plan version: ${state.document.version}`,
      `Plan digest: ${state.document.digest}`,
      "Plan:",
      state.document.markdown,
    ]),
  ].join("\n");
}

function toolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof PlanError) {
    const code = error.code === "plan_not_found"
      ? "not_found"
      : error.code === "plan_invalid_input"
        ? "invalid_input"
        : error.code === "plan_conflict" || error.code === "plan_inactive"
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
