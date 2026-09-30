import { randomUUID } from "node:crypto";
import { GoalConflictError, GoalError } from "./errors.js";
import type { BlockGoalRequest, CreateGoalRequest, EditGoalRequest, Goal, GoalRef, GoalSessionRequest, GoalState, GoalStateStore, GoalView, MutateGoalRequest } from "./types.js";

export interface GoalRuntimeOptions { readonly store: GoalStateStore; readonly defaultMaxGoalRounds?: number; readonly now?: () => Date; readonly id?: () => string }

export class GoalRuntime implements Goal {
  private readonly armed = new Map<string, string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly defaultMaxGoalRounds: number;
  private readonly now: () => Date;
  private readonly id: () => string;
  private closed = false;
  constructor(private readonly options: GoalRuntimeOptions) {
    this.defaultMaxGoalRounds = positive(options.defaultMaxGoalRounds ?? 8, "defaultMaxGoalRounds");
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }
  async get(request: GoalSessionRequest): Promise<GoalView | undefined> {
    this.assertOpen(); const sessionId = identifier(request.sessionId, "Goal Session id");
    request.signal?.throwIfAborted(); await (this.tails.get(sessionId) ?? Promise.resolve());
    const state = await this.options.store.get(sessionId, request.signal); return state && this.view(state);
  }
  create(request: CreateGoalRequest): Promise<GoalView> {
    const sessionId = identifier(request.sessionId, "Goal Session id"); const objective = text(request.objective, "Goal objective");
    const maxGoalRounds = positive(request.maxGoalRounds ?? this.defaultMaxGoalRounds, "Goal maxGoalRounds");
    return this.serial(sessionId, async () => {
      const current = await this.options.store.get(sessionId, request.signal);
      if (current && current.phase !== "complete") throw new GoalConflictError("goal_already_exists", `Session ${sessionId} already has an unfinished Goal`);
      const timestamp = this.timestamp(); const state: GoalState = Object.freeze({ schemaVersion: 1, sessionId, version: (current?.version ?? 0) + 1,
        id: identifier(this.id(), "Goal id"), revision: 1, objective, phase: "active", roundsStarted: 0, maxGoalRounds, createdAt: timestamp, updatedAt: timestamp });
      await this.options.store.put(state, current?.version, request.signal); this.armed.set(sessionId, state.id); return this.view(state);
    });
  }
  edit(request: EditGoalRequest): Promise<GoalView> {
    if (request.objective === undefined && request.maxGoalRounds === undefined) throw new GoalError("goal_invalid_input", "Goal edit requires objective or maxGoalRounds");
    return this.mutate(request, current => {
      const maxGoalRounds = request.maxGoalRounds === undefined ? current.maxGoalRounds : positive(request.maxGoalRounds, "Goal maxGoalRounds");
      if (maxGoalRounds < current.roundsStarted) throw new GoalConflictError("goal_round_limit", "Goal round cap cannot be below roundsStarted");
      return { ...current, ...(request.objective === undefined ? {} : { objective: text(request.objective, "Goal objective") }), maxGoalRounds };
    });
  }
  pause(request: MutateGoalRequest): Promise<GoalView> { return this.transition(request, ["active"], "paused", true); }
  resume(request: MutateGoalRequest): Promise<GoalView> { return this.mutate(request, current => {
    if (current.phase === "complete") throw invalid("A completed Goal cannot resume");
    if (current.roundsStarted >= current.maxGoalRounds) throw new GoalConflictError("goal_round_limit", "Goal round limit is exhausted");
    const { blockedReason: _blockedReason, ...rest } = current;
    return { ...rest, phase: "active" };
  }, true); }
  complete(request: MutateGoalRequest): Promise<GoalView> { return this.transition(request, ["active", "paused", "blocked"], "complete", true); }
  block(request: BlockGoalRequest): Promise<GoalView> { const reason = Object.freeze({ code: blockCode(request.reason.code), message: text(request.reason.message, "Goal block message") }); return this.mutate(request, current => {
    if (current.phase !== "active") throw invalid("Only an active Goal can be blocked"); return { ...current, phase: "blocked", blockedReason: reason };
  }, false, true); }
  clear(request: MutateGoalRequest): Promise<GoalRef> { const sessionId = identifier(request.sessionId, "Goal Session id"); return this.serial(sessionId, async () => {
    const current = await this.requireCurrent(sessionId, request.ref, request.signal); await this.options.store.delete(sessionId, current.version, request.signal); this.armed.delete(sessionId); return Object.freeze({ id: current.id, revision: current.revision + 1 });
  }); }
  async disarm(request: GoalSessionRequest): Promise<GoalView | undefined> { const sessionId = identifier(request.sessionId, "Goal Session id"); this.armed.delete(sessionId); return this.get({ ...request, sessionId }); }
  admitRound(request: MutateGoalRequest): Promise<GoalView> { const sessionId = identifier(request.sessionId, "Goal Session id"); return this.serial(sessionId, async () => {
    const current = await this.requireCurrent(sessionId, request.ref, request.signal);
    if (current.phase !== "active" || this.armed.get(sessionId) !== current.id) throw invalid("Goal is not active and armed");
    if (current.roundsStarted >= current.maxGoalRounds) throw new GoalConflictError("goal_round_limit", "Goal round limit is exhausted");
    const next = Object.freeze({ ...current, version: current.version + 1, roundsStarted: current.roundsStarted + 1, updatedAt: this.timestamp() });
    await this.options.store.put(next, current.version, request.signal); return this.view(next);
  }); }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.armed.clear(); await Promise.all([...this.tails.values()].map(tail => tail.catch(() => undefined))); await this.options.store.close(); }
  private transition(request: MutateGoalRequest, allowed: readonly GoalState["phase"][], phase: GoalState["phase"], disarm: boolean) { return this.mutate(request, current => { if (!allowed.includes(current.phase)) throw invalid(`Cannot transition Goal from ${current.phase} to ${phase}`); const { blockedReason: _blockedReason, ...rest } = current; return { ...rest, phase }; }, false, disarm); }
  private mutate(request: MutateGoalRequest, change: (current: GoalState) => GoalState, arm = false, disarm = false): Promise<GoalView> {
    const sessionId = identifier(request.sessionId, "Goal Session id"); return this.serial(sessionId, async () => {
      const current = await this.requireCurrent(sessionId, request.ref, request.signal); const changed = change(current);
      const next = Object.freeze({ ...changed, version: current.version + 1, revision: current.revision + 1, updatedAt: this.timestamp() }) as GoalState;
      await this.options.store.put(next, current.version, request.signal); if (arm) this.armed.set(sessionId, next.id); if (disarm) this.armed.delete(sessionId); return this.view(next);
    });
  }
  private async requireCurrent(sessionId: string, ref: GoalRef, signal?: AbortSignal): Promise<GoalState> { signal?.throwIfAborted(); const current = await this.options.store.get(sessionId, signal); if (!current) throw new GoalError("goal_not_found", `No Goal exists for Session ${sessionId}`); if (current.id !== ref.id || current.revision !== ref.revision) throw new GoalConflictError("goal_stale_revision", "Goal id or revision is stale"); return current; }
  private view(state: GoalState): GoalView { return Object.freeze({ ...state, activation: this.armed.get(state.sessionId) === state.id && state.phase === "active" ? "armed" : "disarmed" }); }
  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> { this.assertOpen(); const previous = this.tails.get(sessionId) ?? Promise.resolve(); const result = previous.then(operation); const settled = result.then(() => undefined, () => undefined); this.tails.set(sessionId, settled); void settled.finally(() => { if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId); }); return result; }
  private timestamp() { return this.now().toISOString(); }
  private assertOpen() { if (this.closed) throw new GoalError("goal_closed", "Goal service is closed"); }
}

function invalid(message: string) { return new GoalConflictError("goal_invalid_transition", message); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new GoalError("goal_invalid_input", `${label} must be non-empty trimmed text`); return value; }
function text(value: unknown, label: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new GoalError("goal_invalid_input", `${label} must not be empty`); return value.trim(); }
function positive(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new GoalError("goal_invalid_input", `${label} must be a positive safe integer`); return value as number; }
function blockCode(value: unknown): string { const code = identifier(value, "Goal block code"); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code)) throw new GoalError("goal_invalid_input", "Goal block code must be lower-kebab-case"); return code; }
