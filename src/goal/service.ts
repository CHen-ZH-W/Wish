import { Service, type Context } from "@deepseek-ai/cordis";
import type { Goal } from "./types.js";
export abstract class GoalService extends Service implements Goal {
  constructor(ctx: Context) { super(ctx, "goal"); }
  abstract get: Goal["get"]; abstract create: Goal["create"]; abstract edit: Goal["edit"];
  abstract pause: Goal["pause"]; abstract resume: Goal["resume"]; abstract complete: Goal["complete"];
  abstract block: Goal["block"]; abstract clear: Goal["clear"]; abstract disarm: Goal["disarm"];
  abstract admitRound: Goal["admitRound"]; abstract close: Goal["close"];
}
declare module "@deepseek-ai/cordis" { interface Context { goal: GoalService } }
