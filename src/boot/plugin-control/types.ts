/** Browser-safe observations; no Context, plugin config, or service objects. */
export type PluginPhase =
  | "pending"
  | "loading"
  | "active"
  | "failed"
  | "disposed"
  | "unloading";

/** The declared gate, without serializing trusted executable expressions. */
export type PluginGate = "default" | "enabled" | "disabled" | "conditional";

export interface PluginEntryView {
  /** Loader-qualified id, unique within this inspection's process instance. */
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: "plugin" | "group";
  readonly gate: PluginGate;
  /** Loader's effective value, including ancestor gates; null if evaluation fails. */
  readonly enabled: boolean | null;
  readonly fiberId: number | null;
  /** Missing fibers prove neither why one is absent nor that cleanup has settled. */
  readonly phase: PluginPhase | "absent";
}

export interface PluginDependencyView {
  readonly service: string;
  /** The captured binding, not a name-based guess across isolation scopes. */
  readonly providerFiberId: number | null;
  /** Unobserved includes pending fibers without a captured binding. */
  readonly binding: "captured" | "unobserved";
}

export interface PluginFiberView {
  /** Cordis uid; meaningful only together with the process instance id. */
  readonly id: number;
  readonly parentId: number | null;
  /** null for Root-owned infrastructure and programmatic mounts without an Entry. */
  readonly entryId: string | null;
  readonly entryRoot: boolean;
  readonly phase: PluginPhase;
  readonly dependencies: readonly PluginDependencyView[];
}

export interface PluginInspectionSnapshot {
  /** Changes on every bootstrap; ids must not be reused across process instances. */
  readonly instanceId: string;
  readonly entries: readonly PluginEntryView[];
  /** Includes nested injection fibers, so partial module loss stays distinguishable. */
  readonly fibers: readonly PluginFiberView[];
}

export type PluginImpactCause =
  | { readonly kind: "target" }
  | { readonly kind: "parent"; readonly fiberId: number }
  | { readonly kind: "dependency"; readonly fiberId: number; readonly service: string };

export interface PluginDisableImpact {
  readonly targetEntryId: string;
  readonly snapshot: PluginInspectionSnapshot;
  readonly affected: readonly {
    readonly fiberId: number;
    /** One observed path to this fiber; all bindings remain in the snapshot. */
    readonly cause: PluginImpactCause;
  }[];
  /** Not a dry run, complete dependency graph, safety approval, or mutation token. */
  readonly coverage: "observed-fibers";
  readonly safety: "not-assessed";
}

/** Host inspection port. Execution, persistence, and task ownership are separate. */
export interface PluginInspection {
  inspect(): PluginInspectionSnapshot;
  previewDisable(entryId: string): PluginDisableImpact;
}
