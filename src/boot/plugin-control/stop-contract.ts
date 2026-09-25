import type { PluginSelectionImpact } from "./management-types.js";

/** In-process owner protocol, never accepted from an HTTP client. */
export interface PluginStopGuard {
  /** Await real owned resource cleanup. Must be idempotent and never kill unapproved work. */
  close(): Promise<void>;
  /** Undo only the admission fence, before close was called. Must not throw. */
  release(): void;
}

/** Synchronously fence every admission path, including previously returned references.
 * Throwing must leave admission unchanged. Existing work remains owned by the module.
 */
export type PreparePluginStop = () => PluginStopGuard;

/** A broken guard/rollback cannot be reported as an unchanged rejection. */
export class PluginStopAdmissionUncertainError extends Error {
  readonly code = "stop_admission_uncertain";
  constructor() { super("Plugin stop admission could not be restored"); }
}

/** Trusted Host configuration/recovery lease. Not a client-supplied safety boolean.
 * Reservation must not change runtime or configuration. It excludes concurrent config
 * writers/recovery-path removal through apply and verifies the exact selected entries.
 * apply must preserve deployment gates, await Loader disposal, and never auto-rollback
 * a partially stopped graph. Persistence is deliberately outside this protocol.
 */
export interface PluginDisableReservation {
  current(): boolean;
  apply(): Promise<void>;
  verify(): Promise<boolean>;
  /** Recreate the last committed configuration after confirmed cleanup. */
  restore(): Promise<void>;
  /** Prove that the replacement old generation is healthy before reopening work. */
  verifyRestored(): Promise<boolean>;
  release(): void;
}

export interface PluginStopHost {
  reserve(impact: PluginSelectionImpact): PluginDisableReservation;
}
