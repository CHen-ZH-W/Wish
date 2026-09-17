import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ApprovePlanRequest,
  EnterPlanRequest,
  Plan,
  PlanSessionRequest,
  PlanState,
  UpdatePlanRequest,
  DecidePlanReviewRequest,
  PlanFeedbackRequest,
  PlanModeControl,
} from "./types.js";

/** Replaceable Plan capability. Session state and execution remain separate. */
export abstract class PlanService extends Service implements Plan {
  private readonly controls = new Set<PlanModeControl>();
  modeControls(): readonly PlanModeControl[] { return [...this.controls]; }
  registerModeControl(control: PlanModeControl): () => void {
    const stable = Object.freeze({ ...control });
    const unregister = () => { this.controls.delete(stable); };
    this.ctx.effect(() => { this.controls.add(stable); return unregister; }, "plan.mode-control");
    return unregister;
  }
  constructor(ctx: Context) {
    super(ctx, "plan");
  }

  abstract get(request: PlanSessionRequest): Promise<PlanState | undefined>;
  abstract enter(request: EnterPlanRequest): Promise<PlanState>;
  abstract update(request: UpdatePlanRequest): Promise<PlanState>;
  abstract approve(request: ApprovePlanRequest): Promise<PlanState>;
  abstract review(request: ApprovePlanRequest): Promise<PlanState>;
  abstract decide(request: DecidePlanReviewRequest): Promise<PlanState>;
  abstract feedback(request: PlanFeedbackRequest): Promise<PlanState | undefined>;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    plan: PlanService;
  }
}

export default PlanService;
