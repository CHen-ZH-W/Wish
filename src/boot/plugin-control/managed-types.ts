import type { PluginInspectionSnapshot } from "./types.js";
import type { PluginPreference, PluginSelection, PluginStopOperation } from "./management-types.js";
import type { CodeReloadSnapshot } from "./code-reload.js";
import type { PluginChangeOperationView } from "./change-coordinator.js";

export interface ManagedPluginPreference { readonly name: string; readonly preference: Exclude<PluginPreference, "inherit"> }
export interface ManagedPluginRequest {
  readonly requestId: string;
  readonly selection: PluginSelection;
  readonly revision: string;
  readonly preference: PluginPreference;
}
/** Host-produced structural change; contains identities, never deployment config. */
export type ManagedEntryChange = {
  readonly entryId: string;
  readonly beforeName: string | null;
  readonly afterName: string | null;
} & ({ readonly kind: "add" | "remove" | "update" | "replace" | "reorder" } | {
  readonly kind: "retype";
  readonly beforeGroup: boolean;
  readonly afterGroup: boolean;
});
export interface ManagedPluginIntent extends ManagedPluginRequest {
  readonly configuration?: {
    readonly beforeDigest: string;
    readonly afterDigest: string;
    readonly changes: readonly ManagedEntryChange[];
  };
}
export interface ManagedPluginReceipt {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly status: "succeeded" | "rejected" | "failed";
  readonly code: string;
  readonly operationId?: string;
}
export interface ManagedPluginState {
  readonly schemaVersion: 2;
  readonly revision: string;
  readonly preferences: Readonly<Record<string, ManagedPluginPreference>>;
  readonly pending: ManagedPluginIntent | null;
  readonly receipts: readonly ManagedPluginReceipt[];
  /** Bounded durable operation history; candidates and private diagnostics are never stored. */
  readonly operations: readonly PluginChangeOperationView[];
}
export interface ManagedPluginActivationControl {
  /** Present only when the deployment profile delegates activation to the user. */
  readonly canEnable: boolean;
}
export interface ManagedPluginControlView {
  readonly managementClass: PluginInspectionSnapshot["entries"][number]["managementClass"];
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  readonly canReplace: boolean;
  /** Stable browser-safe reason; actual operations always recheck Host state. */
  readonly reason?: string;
}
export type ManagedPluginProtocolMode = "online" | "restart" | "missing" | "mismatch" | "inactive";
export interface ManagedPluginProtocolView {
  readonly entryId: string;
  /** Aggregate declaration state; it is not a point-in-time safety approval. */
  readonly conformance: "online" | "restart" | "incomplete" | "inactive";
  readonly stop: ManagedPluginProtocolMode;
  readonly codeUpdate: ManagedPluginProtocolMode;
}
export interface ManagedPluginSnapshot {
  /** Owner declarations, not a promise that the whole dependent closure is idle. */
  readonly owners: readonly { readonly fiberId: number; readonly lifecycle: "managed" | "observe-only" | "unregistered"; readonly codeReload: "registered" | "restart" | "unregistered"; readonly replacement: "drain" | "generation" | "restart" | "unregistered"; readonly declaration: "canonical" | "compatibility" | "unregistered" }[];
  /** Entry-level projection of actual active Fiber declarations. */
  readonly protocols: readonly ManagedPluginProtocolView[];
  readonly requests: readonly { readonly operationId: string; readonly requestId: string; readonly phase: "queued" | "waiting" | "applying"; readonly cancellable: boolean }[];
  readonly operations: ManagedPluginState["operations"];
  readonly codeReload: CodeReloadSnapshot | null;
  readonly inspection: PluginInspectionSnapshot;
  readonly revision: string;
  readonly preferences: ManagedPluginState["preferences"];
  /** Browser-safe activation authority; omitted entries remain deployment-controlled. */
  readonly controls: Readonly<Record<string, ManagedPluginControlView>>;
  readonly pending: ManagedPluginIntent | null;
  readonly status: "ready" | "working" | "recovery-required";
  readonly writable: boolean;
  readonly operation: PluginStopOperation | null;
  readonly lastReceipt: ManagedPluginReceipt | null;
  readonly configuration: {
    readonly watching: boolean;
    readonly phase: "idle" | "applying" | "rejected" | "recovery-required";
    /** Applied deployment digest only; no paths, expressions, values or raw errors. */
    readonly digest: string | null;
    readonly code: string | null;
  };
}
