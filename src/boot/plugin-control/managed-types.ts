import type { PluginInspectionSnapshot } from "./types.js";
import type { PluginPreference, PluginSelection, PluginStopOperation } from "./management-types.js";
import type { CodeReloadSnapshot } from "./code-reload.js";

export interface ManagedPluginPreference { readonly name: string; readonly preference: Exclude<PluginPreference, "inherit"> }
export interface ManagedPluginRequest {
  readonly requestId: string;
  readonly selection: PluginSelection;
  readonly revision: string;
  readonly preference: PluginPreference;
}
export interface ManagedPluginReceipt {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly status: "succeeded" | "rejected" | "failed";
  readonly code: string;
  readonly operationId?: string;
}
export interface ManagedPluginState {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly preferences: Readonly<Record<string, ManagedPluginPreference>>;
  readonly pending: ManagedPluginRequest | null;
  readonly receipts: readonly ManagedPluginReceipt[];
}
export interface ManagedPluginActivationControl {
  /** Present only when the deployment profile delegates activation to the user. */
  readonly canEnable: boolean;
}
export interface ManagedPluginSnapshot {
  readonly codeReload: CodeReloadSnapshot | null;
  readonly inspection: PluginInspectionSnapshot;
  readonly revision: string;
  readonly preferences: ManagedPluginState["preferences"];
  /** Browser-safe activation authority; omitted entries remain deployment-controlled. */
  readonly controls: Readonly<Record<string, ManagedPluginActivationControl>>;
  readonly pending: ManagedPluginRequest | null;
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
