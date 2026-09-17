import type { ModelRef } from "../core/model/types.js";
import type { RunContinuation } from "../core/runtime/continuation.js";
import type { ModelsConfiguration } from "../models/types.js";
import type { PermissionSnapshot } from "../permissions/index.js";
import type { WorkspaceSnapshot } from "../workspace/index.js";
import type { SessionHistorySnapshot } from "../sessions/types.js";

/** Provider-neutral Model facts fixed for one Tool execution Step. */
export interface ToolModelContext {
  readonly ref: ModelRef;
  readonly configuration?: ModelsConfiguration;
}

/** Wish product facts fixed exactly once for one Tool execution Step. */
export interface WishToolExecutionContext {
  /** Compatibility execution cwd; always equals workspace.root in product graphs. */
  readonly cwd: string;
  /** Exact immutable Workspace Snapshot resolved for the current Step. */
  readonly workspace: WorkspaceSnapshot;
  /** Exact immutable permission authority fixed for the current Step. */
  readonly permissions: PermissionSnapshot;
  /** Effective Model facts available to model-aware capability Consumers. */
  readonly modelContext?: ToolModelContext;
  readonly modelSupportsImages?: boolean;
  /** Generic Run continuation Port; omitted by narrow standalone embedders. */
  readonly runContinuation?: RunContinuation;
  /** Host-bound read-only view of this Session's committed facts; no path or Session selector. */
  readonly sessionHistory?: {
    read(signal?: AbortSignal): Promise<SessionHistorySnapshot>;
  };
}
