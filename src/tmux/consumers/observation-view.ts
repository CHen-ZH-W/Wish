import type { TmuxSessionSnapshot } from "../types.js";
export interface TmuxObservationView {
  readonly kind: "tmux-observation";
  readonly observedAt: string;
  readonly sessions: readonly TmuxSessionSnapshot[];
  readonly capture: { readonly sessionId: string; readonly observedAt: string; readonly output: string } | null;
}
