import type { TmuxSessionSnapshot } from "../types.js";

export interface TmuxPaneCapture {
  readonly sessionId: string;
  readonly observedAt: string;
  readonly output: string;
  /** Process state immediately before this capture was requested. */
  readonly active: boolean;
}

export interface TmuxObservationView {
  readonly kind: "tmux-observation";
  readonly observedAt: string;
  readonly sessions: readonly TmuxSessionSnapshot[];
  readonly captures: readonly TmuxPaneCapture[];
}
