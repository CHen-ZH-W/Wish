import type { AgentProfileDefinition, AgentProfileSnapshot } from "../src/agent-profiles/types.js";
import type { ExperimentPlan, ExperimentMetrics } from "../src/experiments/types.js";

declare const definition: AgentProfileDefinition;
declare const snapshot: AgentProfileSnapshot;
declare const plan: ExperimentPlan;
declare const metrics: ExperimentMetrics;

// @ts-expect-error A versioned recipe cannot be edited through a retained handle.
definition.version = 2;
// @ts-expect-error Bound Tool ceilings remain immutable.
snapshot.permissions.availableTools?.push("bash");
// @ts-expect-error Experiment variants identify resolved snapshots, not mutable aliases.
plan.variants[0]!.profile = "coder@latest";
// @ts-expect-error An incomplete Worker ledger cannot be assumed to contain a numeric total.
const knownAttempts: number = metrics.attempts;
void knownAttempts;
