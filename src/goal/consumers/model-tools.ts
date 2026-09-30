import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition, ToolInputParseResult } from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import { ManagedToolOwner } from "../../tools/managed.js";
import { GoalError } from "../errors.js";
import type { Goal, GoalRef, GoalView } from "../types.js";

export interface Config { readonly blockedAfterConsecutiveRounds?: number }
export const Config: s<Config> = s.object({ blockedAfterConsecutiveRounds: s.number().step(1).min(1) });
type UpdateAction = "edit" | "pause" | "resume" | "complete" | "blocked";
interface CreateInput { readonly objective: string; readonly max_goal_rounds?: number }
interface UpdateInput { readonly goal_id: string; readonly revision: number; readonly action: UpdateAction; readonly objective?: string; readonly max_goal_rounds?: number; readonly blocked_reason?: string }
export interface GoalToolOutput { readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly goal?: GoalView }

export function createGoalTools(goal: Goal, config: Config = {}): readonly ToolDefinition<string, any, GoalToolOutput, WishToolExecutionContext>[] {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3;
  return Object.freeze([
    definition("get_goal", "Read the current same-session Goal and its exact CAS id/revision.", "parallel", "retry-safe", EMPTY_SCHEMA, parseEmpty,
      (_input, context) => capability("runtime.read", `goal.read:${sessionId(context)}`),
      async (_input, context, grant, signal) => {
        authorize(grant, "get_goal", "runtime.read", `goal.read:${sessionId(context)}`);
        const current = await goal.get({ sessionId: sessionId(context), ...(signal === undefined ? {} : { signal }) });
        return output(current);
      }),
    definition("create_goal", "Create and arm one persisted same-session completion Goal for a long-running objective. Requires a direct top-level human UserTurn.", "sequential", "needs-reconciliation", CREATE_SCHEMA, parseCreate,
      (_input, context) => capability("runtime.control", `goal.create:${sessionId(context)}`),
      async (input: CreateInput, context, grant, signal) => {
        authorize(grant, "create_goal", "runtime.control", `goal.create:${sessionId(context)}`); requireDirectHuman(context);
        try { return output(await goal.create({ sessionId: sessionId(context), objective: input.objective,
          ...(input.max_goal_rounds === undefined ? {} : { maxGoalRounds: input.max_goal_rounds }), ...(signal === undefined ? {} : { signal }) })); }
        catch (error: unknown) { throw toolError(error); }
      }),
    definition("update_goal", "Mutate the exact current Goal revision. edit, pause, resume, complete, and blocked currently require a direct top-level human UserTurn; automatic goal-round authority is added by the GoalRoundDriver.", "sequential", "needs-reconciliation", UPDATE_SCHEMA, parseUpdate,
      (_input, context) => capability("runtime.control", `goal.update:${sessionId(context)}`),
      async (input: UpdateInput, context, grant, signal) => {
        authorize(grant, "update_goal", "runtime.control", `goal.update:${sessionId(context)}`);
        if (input.action === "edit" || input.action === "pause" || input.action === "resume") {
          requireDirectHuman(context);
        } else {
          requireCompletionAuthority(context, input, blockedAfter);
        }
        const base = { sessionId: sessionId(context), ref: ref(input), ...(signal === undefined ? {} : { signal }) };
        try {
          const current = input.action === "edit" ? await goal.edit({ ...base, ...(input.objective === undefined ? {} : { objective: input.objective }), ...(input.max_goal_rounds === undefined ? {} : { maxGoalRounds: input.max_goal_rounds }) })
            : input.action === "pause" ? await goal.pause(base)
            : input.action === "resume" ? await goal.resume(base)
            : input.action === "complete" ? await goal.complete(base)
            : await goal.block({ ...base, reason: { code: "model-reported", message: input.blocked_reason! } });
          return output(current);
        } catch (error: unknown) { throw toolError(error); }
      }),
  ]);
}

function definition(name: string, description: string, executionMode: "parallel" | "sequential", recoveryPolicy: "retry-safe" | "needs-reconciliation", inputSchemaJson: string,
  parse: (input: Readonly<Record<string, unknown>>) => ToolInputParseResult<any>, resolveCapabilities: ToolDefinition<string, any, GoalToolOutput, WishToolExecutionContext>["resolveCapabilities"],
  execute: ToolDefinition<string, any, GoalToolOutput, WishToolExecutionContext>["execute"]): ToolDefinition<string, any, GoalToolOutput, WishToolExecutionContext> {
  return { name, description, executionMode, recoveryPolicy, inputSchemaJson, parse, resolveCapabilities, execute };
}
const EMPTY_SCHEMA = JSON.stringify({ type: "object", properties: {}, additionalProperties: false });
const CREATE_SCHEMA = JSON.stringify({ type: "object", properties: { objective: { type: "string", minLength: 1 }, max_goal_rounds: { type: "integer", minimum: 1 } }, required: ["objective"], additionalProperties: false });
const UPDATE_SCHEMA = JSON.stringify({ type: "object", properties: { goal_id: { type: "string", minLength: 1 }, revision: { type: "integer", minimum: 1 }, action: { enum: ["edit", "pause", "resume", "complete", "blocked"] }, objective: { type: "string", minLength: 1 }, max_goal_rounds: { type: "integer", minimum: 1 }, blocked_reason: { type: "string", minLength: 1 } }, required: ["goal_id", "revision", "action"], additionalProperties: false });
function parseEmpty(input: Readonly<Record<string, unknown>>): ToolInputParseResult<Record<string, never>> { return Object.keys(input).length === 0 ? { ok: true, input: Object.freeze({}) } : invalid("get_goal accepts no fields"); }
function parseCreate(input: Readonly<Record<string, unknown>>): ToolInputParseResult<CreateInput> { if (unknown(input, ["objective", "max_goal_rounds"])) return invalid("Unknown create_goal field"); if (!textValue(input.objective)) return invalid("objective is required"); if (input.max_goal_rounds !== undefined && !positive(input.max_goal_rounds)) return invalid("max_goal_rounds must be positive"); return { ok: true, input: Object.freeze({ objective: input.objective, ...(input.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.max_goal_rounds as number }) }) }; }
function parseUpdate(input: Readonly<Record<string, unknown>>): ToolInputParseResult<UpdateInput> {
  if (unknown(input, ["goal_id", "revision", "action", "objective", "max_goal_rounds", "blocked_reason"])) return invalid("Unknown update_goal field");
  if (!textValue(input.goal_id) || !positive(input.revision) || !["edit", "pause", "resume", "complete", "blocked"].includes(input.action as string)) return invalid("goal_id, positive revision, and valid action are required");
  const action = input.action as UpdateAction; const hasEdit = input.objective !== undefined || input.max_goal_rounds !== undefined; const hasBlock = input.blocked_reason !== undefined;
  if (action === "edit" && !hasEdit) return invalid("edit requires objective or max_goal_rounds");
  if (action !== "edit" && hasEdit) return invalid("objective and max_goal_rounds are valid only with edit");
  if (action === "blocked" && !textValue(input.blocked_reason)) return invalid("blocked_reason is required with blocked");
  if (action !== "blocked" && hasBlock) return invalid("blocked_reason is valid only with blocked");
  if (input.objective !== undefined && !textValue(input.objective)) return invalid("objective must not be empty");
  if (input.max_goal_rounds !== undefined && !positive(input.max_goal_rounds)) return invalid("max_goal_rounds must be positive");
  return { ok: true, input: Object.freeze({ goal_id: input.goal_id, revision: input.revision as number, action,
    ...(input.objective === undefined ? {} : { objective: input.objective as string }), ...(input.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.max_goal_rounds as number }),
    ...(input.blocked_reason === undefined ? {} : { blocked_reason: input.blocked_reason as string }) }) };
}
function requireDirectHuman(context: WishToolExecutionContext) { const turn = context.userTurn; if (!turn || turn.parentRunId !== undefined) throw new ToolExecutionError("permission_denied", "Goal mutation requires direct top-level human authority"); const direct = turn.provenance.origin === "run_input" ? turn.inputSource === "user" : turn.provenance.source === "wish-cli" || turn.provenance.source === "wish-webui"; if (!direct) throw new ToolExecutionError("permission_denied", "Goal mutation requires direct top-level human authority"); }
function requireCompletionAuthority(context: WishToolExecutionContext, input: UpdateInput, blockedAfter: number) {
  try { requireDirectHuman(context); return; } catch {}
  const turn = context.userTurn;
  const round = turn?.goalRound;
  if (!turn || turn.parentRunId !== undefined || turn.provenance.origin !== "follow_up" || turn.provenance.source !== "wish-goal-round-driver" ||
      round === undefined || round.goalId !== input.goal_id || round.revision !== input.revision || round.round < 1) {
    throw new ToolExecutionError("permission_denied", "Goal completion requires direct human or exact current Goal-round authority");
  }
  if (input.action === "blocked" && round.round < blockedAfter) {
    throw new ToolExecutionError("conflict", `blocked requires at least ${blockedAfter} admitted Goal rounds; current round is ${round.round}`);
  }
}
function sessionId(context: WishToolExecutionContext) { return context.permissions.subject.sessionId; }
function ref(input: UpdateInput): GoalRef { return Object.freeze({ id: input.goal_id, revision: input.revision }); }
function capability(kind: "runtime.read" | "runtime.control", resource: string) { return Object.freeze({ requirements: Object.freeze([Object.freeze({ capability: kind, resources: Object.freeze([resource]) })]) }); }
function authorize(grant: any, name: string, kind: string, resource: string) { assertActiveToolAuthorizationGrant(grant, { toolName: name }); if (!grant.capabilities.requirements.some((item: any) => item.capability === kind && item.resources.includes(resource))) throw new ToolExecutionError("permission_denied", `Tool authorization Grant does not allow ${resource}`); }
function output(goal: GoalView | undefined): GoalToolOutput { return Object.freeze({ content: Object.freeze([Object.freeze({ type: "text" as const, text: JSON.stringify({ goal: goal ?? null }) })]), ...(goal === undefined ? {} : { goal }) }); }
function toolError(error: unknown) { if (error instanceof ToolExecutionError) return error; if (error instanceof GoalError) return new ToolExecutionError(error.code === "goal_not_found" ? "not_found" : error.code === "goal_invalid_input" ? "invalid_input" : error.code.includes("stale") || error.code.includes("transition") || error.code.includes("exists") || error.code.includes("limit") ? "conflict" : "execution_failed", error.message); return new ToolExecutionError("execution_failed", error instanceof Error ? error.message : String(error)); }
function unknown(input: Readonly<Record<string, unknown>>, allowed: readonly string[]) { return Object.keys(input).some(key => !allowed.includes(key)); }
function textValue(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function positive(value: unknown) { return Number.isSafeInteger(value) && (value as number) > 0; }
function invalid<Input>(message: string): ToolInputParseResult<Input> { return { ok: false, message }; }

export default { name: "goal-tools", inject: ["tools", "goal"], Config, apply(ctx: Context, config: Config = {}) { const owner = new ManagedToolOwner(ctx, { code: "goal_tools", codeReload: true }); for (const tool of createGoalTools(ctx.goal, config)) owner.register(tool); } };
