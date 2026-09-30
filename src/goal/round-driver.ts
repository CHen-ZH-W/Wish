import { Service, type Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { WishUserTurnContinuationPolicy } from "../composition/runtime-service.js";
import type { RunCompletionHold } from "../core/runtime/runtime.js";
import type { GoalService } from "./service.js";
import type { GoalView } from "./types.js";

interface Reservation {
  readonly goalId: string;
  readonly revision: number;
  readonly round: number;
}

interface Binding {
  readonly sessionId: string;
  readonly goalId: string;
  readonly hold: RunCompletionHold;
  reservation?: Reservation;
}

export class GoalRoundDriver extends Service {
  static readonly inject = ["goal", "runEngine"];
  private readonly bindings = new Map<string, Binding>();
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context) {
    super(ctx, "goalRoundDriver");
    this.work = new PluginWorkOwner(ctx, {
      code: "goal_round_driver",
      codeReload: true,
      close: () => this.closeBindings(ctx.goal),
    });
    const policy: WishUserTurnContinuationPolicy = {
      openUserTurn: input => this.work.run(() => this.openUserTurn(ctx.goal, input)),
      afterUserTurn: input => this.work.run(() => this.afterUserTurn(ctx, input)),
      finishRun: input => this.work.run(() => this.finishRun(ctx.goal, input)),
    };
    ctx.effect(
      () => ctx.runEngine.registerContinuationPolicy(Object.freeze(policy)),
      "Goal Round continuation policy",
    );
  }

  private async openUserTurn(
    goalService: GoalService,
    input: Parameters<NonNullable<WishUserTurnContinuationPolicy["openUserTurn"]>>[0],
  ): Promise<void> {
    const metadata = input.userTurn.input.continuation;
    if (
      input.userTurn.provenance.origin !== "follow_up" ||
      input.userTurn.provenance.source !== "wish-goal-round-driver" ||
      metadata?.kind !== "goal_round"
    ) {
      return;
    }
    const binding = this.bindings.get(input.run.runId);
    const reservation = binding?.reservation;
    if (
      binding === undefined ||
      reservation === undefined ||
      binding.sessionId !== input.run.scope ||
      reservation.goalId !== metadata.goalId ||
      reservation.revision !== metadata.revision ||
      reservation.round !== metadata.round
    ) {
      throw new Error("Goal round reservation does not match the opened UserTurn");
    }
    const current = await goalService.get({ sessionId: input.run.scope, signal: input.signal });
    if (!matches(current, reservation) || current.roundsStarted + 1 !== reservation.round) {
      throw new Error("Goal round reservation is stale");
    }
    const admitted = await goalService.admitRound({
      sessionId: input.run.scope,
      ref: { id: reservation.goalId, revision: reservation.revision },
      signal: input.signal,
    });
    if (admitted.roundsStarted !== reservation.round) {
      throw new Error("Goal round admission is not contiguous");
    }
    delete binding.reservation;
  }

  private async afterUserTurn(
    ctx: Context,
    input: Parameters<NonNullable<WishUserTurnContinuationPolicy["afterUserTurn"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<WishUserTurnContinuationPolicy["afterUserTurn"]>>>> {
    const goalService = ctx.goal;
    const runId = input.run.runId;
    const existing = this.bindings.get(runId);
    if (existing !== undefined) delete existing.reservation;
    const goal = await goalService.get({ sessionId: input.run.scope, signal: input.signal });
    if (goal === undefined || goal.phase !== "active" || goal.activation !== "armed") {
      this.release(runId);
      return Object.freeze({ type: "none" });
    }
    const plan = ctx.get("plan");
    const planState = await plan?.get({ sessionId: input.run.scope, signal: input.signal });
    if (planState?.review?.status === "pending") {
      this.release(runId);
      await goalService.disarm({ sessionId: input.run.scope, signal: input.signal });
      return Object.freeze({ type: "none" });
    }
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      await goalService.block({
        sessionId: input.run.scope,
        ref: goal,
        reason: {
          code: "round-limit",
          message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
        },
        signal: input.signal,
      });
      this.release(runId);
      return Object.freeze({ type: "none" });
    }
    let binding = existing;
    if (binding === undefined || binding.goalId !== goal.id) {
      this.release(runId);
      const hold = input.completion.defer(`goal:${goal.id}`);
      if (hold === undefined) {
        await goalService.disarm({ sessionId: input.run.scope, signal: input.signal });
        throw new Error("Could not defer Run completion for active Goal");
      }
      binding = { sessionId: input.run.scope, goalId: goal.id, hold };
      this.bindings.set(runId, binding);
    }
    const ownHold = `goal:${goal.id}`;
    const hasExternalHold = input.pending.completionHolds.some(
      reason => reason !== ownHold,
    );
    if (hasExternalHold) {
      return Object.freeze({ type: "none" });
    }
    const reservation: Reservation = Object.freeze({
      goalId: goal.id,
      revision: goal.revision,
      round: goal.roundsStarted + 1,
    });
    binding.reservation = reservation;
    const text = renderGoalRoundPrompt(goal, reservation.round);
    return Object.freeze({
      type: "follow_up" as const,
      source: "wish-goal-round-driver",
      reserveCapacity: true,
      preemptible: true,
      text,
      payload: Object.freeze({
        text,
        ...(input.userTurn.input.model === undefined ? {} : { model: input.userTurn.input.model }),
        ...(input.userTurn.input.reasoningEffort === undefined ? {} : { reasoningEffort: input.userTurn.input.reasoningEffort }),
        continuation: Object.freeze({ kind: "goal_round" as const, ...reservation }),
      }),
    });
  }

  private async finishRun(
    goalService: GoalService,
    input: Parameters<NonNullable<WishUserTurnContinuationPolicy["finishRun"]>>[0],
  ): Promise<void> {
    const binding = this.bindings.get(input.run.runId);
    this.release(input.run.runId);
    if (binding === undefined) return;
    const current = await goalService.get({ sessionId: binding.sessionId });
    if (current?.id !== binding.goalId || current.phase !== "active") return;
    const lastTurn = input.run.userTurns.at(-1);
    const cancelledGoalRound = input.status === "aborted" &&
      lastTurn?.provenance.origin === "follow_up" &&
      lastTurn.provenance.source === "wish-goal-round-driver";
    if (cancelledGoalRound) {
      await goalService.pause({ sessionId: binding.sessionId, ref: current });
    } else {
      await goalService.disarm({ sessionId: binding.sessionId });
    }
  }

  private release(runId: string): void {
    const binding = this.bindings.get(runId);
    if (binding === undefined) return;
    this.bindings.delete(runId);
    binding.hold.release();
  }

  private async closeBindings(goalService: GoalService): Promise<void> {
    const bindings = [...this.bindings.entries()];
    for (const [runId] of bindings) this.release(runId);
    await Promise.allSettled(bindings.map(([, binding]) =>
      goalService.disarm({ sessionId: binding.sessionId })));
  }
}

function matches(goal: GoalView | undefined, reservation: Reservation): goal is GoalView {
  return goal !== undefined && goal.id === reservation.goalId &&
    goal.revision === reservation.revision && goal.phase === "active" &&
    goal.activation === "armed";
}

export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  return [
    `Continue the active Goal (round ${round}/${goal.maxGoalRounds}).`,
    `Objective: ${goal.objective}`,
    "Make concrete progress. Use get_goal before changing state.",
    "Call update_goal action complete only when the objective is achieved; call blocked only for a concrete persistent blocker.",
  ].join("\n");
}

declare module "@deepseek-ai/cordis" {
  interface Context { goalRoundDriver: GoalRoundDriver }
}

export default GoalRoundDriver;
