import type { AgentRuntimeService } from "../src/core/agent/agent.js";
import {
  RunGeneration,
  type RunGenerationSnapshot,
  type RunGenerationState,
} from "../src/core/runtime/generation.js";
import {
  createWishRuntime,
  type RuntimeDependencies,
} from "../src/composition/runtime-service.js";
import type { WishAgentProtocol } from "../src/apps/types.js";
import type { AgentLoopDependencies } from "../src/composition/agent-loop-service.js";

declare const runtime: AgentRuntimeService<WishAgentProtocol>;
declare const agentLoop: AgentLoopDependencies;

const generation = new RunGeneration<WishAgentProtocol>(runtime, {
  id: "generation-1",
  drainTimeoutMs: 30_000,
  abortControl: ({ reason }) => ({
    type: "abort",
    source: "type-test",
    reason,
  }),
});
const state: RunGenerationState = generation.state;
const snapshot: RunGenerationSnapshot = generation.snapshot();
const retirement: Promise<void> = generation.retire();

// Standalone Core Runtime remains a valid Agent dependency without Cordis.
const standalone: RuntimeDependencies = {
  runtime: createWishRuntime(agentLoop),
};

void state;
void snapshot;
void retirement;
void standalone;
