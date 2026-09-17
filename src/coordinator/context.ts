import type {
  ContextItem,
  ContextProvider,
} from "../core/context/projector.js";
import type { ContextInput } from "../context/types.js";
import type { Coordinator } from "./types.js";

export const COORDINATOR_CONTEXT_PROVIDER_ID = "coordinator-mode";

export class CoordinatorContextProvider implements ContextProvider<ContextInput> {
  readonly id = COORDINATOR_CONTEXT_PROVIDER_ID;

  constructor(private readonly coordinator: Coordinator) {}

  async provide(
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<readonly ContextItem[]> {
    signal?.throwIfAborted();
    const state = await this.coordinator.get({
      runId: input.runId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (state?.active !== true) return Object.freeze([]);
    const facts = Object.freeze({
      runId: state.runId,
      sessionId: state.sessionId,
      stateVersion: state.version,
      ...(state.goal === undefined ? {} : { goal: state.goal }),
    });
    return Object.freeze([Object.freeze({
      id: `${COORDINATOR_CONTEXT_PROVIDER_ID}:active`,
      kind: "instruction" as const,
      placement: "dynamic_tail" as const,
      message: Object.freeze({
        role: "developer" as const,
        content: [
          "Coordinator mode is active for this Run.",
          "Coordinate work through the existing child-Agent Tools. Direct source mutation and shell execution are forbidden by host policy.",
          "Child executions remain visible through list_agents and capture_agent, and an operator may attach to their tmux sessions.",
          "Use collect_agent after context compaction or process restart. While this parent process stays alive, completed children are relayed into the held Run, so do not busy-poll them.",
          "Children currently share the workspace: do not run concurrent write-capable children against overlapping files.",
          "Use exit_coordinator_mode when delegated work has been reconciled. Broader capabilities return only on the next Agent Step.",
          "Current Coordinator facts:",
          JSON.stringify(facts, null, 2),
        ].join("\n"),
      }),
    })]);
  }
}
