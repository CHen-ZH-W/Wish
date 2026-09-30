import type { ContextItem, ContextProvider } from "../core/context/projector.js";
import type { ContextInput } from "../context/types.js";
import type { Goal } from "./types.js";
export class GoalContextProvider implements ContextProvider<ContextInput> {
  readonly id = "goal-state";
  constructor(private readonly goal: Goal) {}
  async provide(input: ContextInput, signal?: AbortSignal): Promise<readonly ContextItem[]> {
    const goal = await this.goal.get({ sessionId: input.sessionId, ...(signal === undefined ? {} : { signal }) });
    if (!goal) return Object.freeze([]);
    return Object.freeze([Object.freeze({ id: "goal-state:current", kind: "instruction" as const, placement: "dynamic_tail" as const,
      message: Object.freeze({ role: "developer" as const, content: [
        "Current same-session Goal facts:", JSON.stringify(goal, null, 2),
        "Use get_goal before any mutation and copy the exact id/revision into update_goal.",
        "Goal phase is durable; activation is process-local. A disarmed active Goal does not auto-continue.",
        "Do not claim completion unless the objective is actually achieved. Do not mark blocked merely because work is hard or uncertain.",
      ].join("\n") }),
    })]);
  }
}
