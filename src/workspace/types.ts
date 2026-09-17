/** Opaque identity of one canonical execution workspace. */
export type WorkspaceFingerprint = string;

/** Opaque version of the facts captured in one Workspace Snapshot. */
export type WorkspaceRevision = string;

/** One already-resolved workspace instruction. Consumers never scan its source. */
export interface WorkspaceInstruction {
  readonly id: string;
  readonly authority: "developer";
  readonly source: string;
  readonly content: string;
  readonly digest: string;
}

/** Stable repository identity resolved for the current workspace, when known. */
export interface WorkspaceRepository {
  readonly kind: "git";
  readonly root: string;
  readonly identity: string;
}

/** Input to one explicit Workspace resolution. */
export interface ResolveWorkspaceRequest {
  /** Directory spelling selected by the caller before canonicalization. */
  readonly root: string;
  readonly signal?: AbortSignal;
}

/**
 * Immutable execution facts shared by every consumer in one Runtime Step.
 * `root` is canonical; `requestedRoot` is retained only for diagnostics.
 */
export interface WorkspaceSnapshot {
  readonly requestedRoot: string;
  readonly root: string;
  readonly fingerprint: WorkspaceFingerprint;
  readonly revision: WorkspaceRevision;
  readonly instructions: readonly WorkspaceInstruction[];
  readonly repository?: WorkspaceRepository;
}

/** Provider-neutral Workspace capability. */
export interface WorkspaceResolver {
  resolve(request: ResolveWorkspaceRequest): Promise<WorkspaceSnapshot>;
}
