import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  Coordinator,
  CoordinatorRunRequest,
  CoordinatorState,
  EnterCoordinatorRequest,
  ExitCoordinatorRequest,
  CoordinatorModeControl,
} from "./types.js";

/** Replaceable Coordinator capability; Subagents owns every child lifecycle. */
export abstract class CoordinatorService extends Service implements Coordinator {
  private readonly controls = new Set<CoordinatorModeControl>();
  modeControls(): readonly CoordinatorModeControl[] { return [...this.controls]; }
  registerModeControl(control: CoordinatorModeControl): () => void {
    const stable = Object.freeze({ ...control });
    const unregister = () => { this.controls.delete(stable); };
    this.ctx.effect(() => { this.controls.add(stable); return unregister; }, "coordinator.mode-control");
    return unregister;
  }
  constructor(ctx: Context) {
    super(ctx, "coordinator");
  }

  abstract get(request: CoordinatorRunRequest): Promise<CoordinatorState | undefined>;
  abstract enter(request: EnterCoordinatorRequest): Promise<CoordinatorState>;
  abstract exit(request: ExitCoordinatorRequest): Promise<CoordinatorState>;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    coordinator: CoordinatorService;
  }
}

export default CoordinatorService;
