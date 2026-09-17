import type { SubagentRecord } from "../types.js";
export interface SubagentObservationView {
  readonly kind: "subagent-observation";
  readonly records: readonly SubagentRecord[];
  readonly capture: { readonly id: string; readonly observedAt: string; readonly output: string } | null;
}
