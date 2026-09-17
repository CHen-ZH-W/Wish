import type { PluginInspectionSnapshot, PluginImpactCause } from "./types.js";

/** Explicit Loader entries in one Root, not module names or an atomic transaction. */
export interface PluginSelection {
  readonly instanceId: string;
  readonly entryIds: readonly string[];
}

/** A preference never replaces deployment expressions or bypasses Host constraints. */
export type PluginPreference = "inherit" | "enabled" | "disabled";

/** Management-layer state; distinct from Loader gate and actual Fiber phase. */
export interface PluginConfigurationState {
  readonly preference: PluginPreference;
  readonly persistence:
    | { readonly status: "unmanaged" }
    | { readonly status: "saved"; readonly revision: string }
    | { readonly status: "unsaved"; readonly basedOnRevision: string | null }
    | { readonly status: "failed"; readonly basedOnRevision: string | null; readonly code: string };
}

/** Operation receipts must not infer cleanup or persistence from a missing Fiber. */
export type PluginOperationState =
  | { readonly phase: "checking" | "stopping" | "applying" | "verifying" }
  | {
    readonly phase: "succeeded";
    readonly runtime: "confirmed";
    readonly cleanup: "confirmed";
    readonly persistence: "saved" | "not-requested";
  }
  | { readonly phase: "rejected" | "conflict"; readonly code: string; readonly changed: false }
  | {
    readonly phase: "failed";
    readonly code: string;
    readonly runtime: "unchanged" | "changed" | "unknown";
    readonly persistence: "unchanged" | "saved" | "unknown";
    readonly cleanup: "confirmed" | "pending" | "failed" | "unknown";
  };

export interface PluginSelectionImpact {
  readonly selection: PluginSelection;
  readonly snapshot: PluginInspectionSnapshot;
  /** Selected entries and configured descendants, including entries without fibers. */
  readonly gatedEntryIds: readonly string[];
  readonly affected: readonly {
    readonly fiberId: number;
    readonly cause: PluginImpactCause;
  }[];
  readonly coverage: "observed-fibers";
  readonly safety: "not-assessed";
}

/** Direct still requires awaited disposal; drain is not permission to kill tasks. */
export type PluginStopDisposition = "direct" | "drain" | "blocked" | "maintenance" | "restart";

export type PluginStopSubject =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "fiber"; readonly fiberId: number };

/** Host-collected module facts, never client-supplied approval or stored task state. */
export interface PluginStopReport {
  readonly subject: PluginStopSubject;
  readonly disposition: PluginStopDisposition;
  /** Stable, public diagnostic code; no exception text, paths, or task payload. */
  readonly code: string;
}

/** Preconditions checked by Host adapters using existing admission/security boundaries. */
export interface PluginDisableEvidence {
  /** Exact observation used for collection; identity prevents accidental report reuse. */
  readonly observation: PluginInspectionSnapshot;
  readonly configuration: "managed" | "read-only" | "unknown";
  readonly recovery: "available" | "maintenance" | "restart" | "unknown";
  readonly admission: "guarded" | "unknown";
  readonly reports: readonly PluginStopReport[];
}

export interface PluginDisableAssessment {
  readonly impact: PluginSelectionImpact;
  readonly disposition: PluginStopDisposition;
  readonly conditions: readonly {
    readonly subject: PluginStopSubject | { readonly kind: "host" };
    readonly disposition: PluginStopDisposition;
    readonly code: string;
  }[];
  /** A point-in-time assessment is neither authorization nor a concurrency token. */
  readonly safety: "requires-execution-check";
}

/** Bounded diagnostics supplied by a lifecycle owner, never domain payloads. */
export interface PluginLifecycleStatus {
  readonly disposition: PluginStopDisposition;
  readonly code: string;
  readonly counts?: Readonly<Record<string, number>>;
}

export interface PluginLifecycleOwnerView {
  /** Changes on each registration, including reactivation of the same Fiber. */
  readonly registrationId: number;
  readonly fiberId: number;
  readonly entryId: string | null;
  readonly entryRoot: boolean;
  readonly status: PluginLifecycleStatus;
}

export interface PluginLifecycleCollection extends PluginDisableEvidence {
  /** Read-only impact from the same observation used to collect owner reports. */
  readonly impact: Pick<PluginSelectionImpact, "gatedEntryIds" | "affected" | "coverage" | "safety">;
  readonly owners: readonly PluginLifecycleOwnerView[];
  readonly coverage: "registered-owners";
}

/** Root-owned read port. No registration, arbitrary callback, or mutation over the wire. */
export interface PluginLifecycleInspection {
  collect(selection: PluginSelection): Promise<PluginLifecycleCollection>;
}

/** Process-local operation, including an unresolved cleanup after the response deadline. */
export interface PluginStopOperation {
  readonly id: string;
  readonly selection: PluginSelection;
  readonly state: PluginOperationState;
}

export interface PluginStopControl {
  disable(selection: PluginSelection): Promise<PluginStopOperation>;
  /** Most recent admitted operation; polling never starts or retries cleanup. */
  current(): PluginStopOperation | null;
}
