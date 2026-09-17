import type { CapabilityAuthorizationGrant } from
  "../permissions/authorization.js";
import type { PermissionSnapshot } from "../permissions/types.js";
import type { WorkspaceSnapshot } from "../workspace/types.js";

export type FilesystemAccess = "read" | "write";
export type FilesystemEntryKind = "file" | "directory";

/** Immutable enforcement facts owned by one Filesystem Provider generation. */
export interface FilesystemPolicy {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly scope: "workspace";
  readonly symbolicLinks: "deny";
  readonly maxFileBytes: number;
  readonly protectedDirectoryNames: readonly string[];
  readonly protectedFileNames: readonly string[];
  readonly protectedFilePrefixes: readonly string[];
  readonly protectedNameExceptions: readonly string[];
}

/** Exact Step facts that every filesystem operation must bind to. */
export interface FilesystemExecutionContext {
  readonly workspace: WorkspaceSnapshot;
  readonly permissions: PermissionSnapshot;
}

export interface FilesystemOperationRequest {
  /** Relative paths resolve against workspace.root; absolute paths stay explicit. */
  readonly path: string;
  readonly context: FilesystemExecutionContext;
  readonly grant: CapabilityAuthorizationGrant;
  readonly signal?: AbortSignal;
}

export interface ResolveFilesystemPathRequest
  extends FilesystemOperationRequest {
  readonly access: FilesystemAccess;
  readonly allowMissing?: boolean;
  readonly allowWorkspaceRoot?: boolean;
}

/** Approval-time path check. It proves enforceability but grants no IO authority. */
export interface PreflightFilesystemPathRequest {
  readonly path: string;
  readonly access: FilesystemAccess;
  readonly allowMissing?: boolean;
  readonly allowWorkspaceRoot?: boolean;
  readonly context: FilesystemExecutionContext;
  readonly signal?: AbortSignal;
}

export interface ResolvedFilesystemPath {
  readonly requestedPath: string;
  readonly path: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly kind?: FilesystemEntryKind;
}

export interface ReadFilesystemFileRequest extends FilesystemOperationRequest {}

export interface WriteFilesystemFileRequest extends FilesystemOperationRequest {
  readonly data: Uint8Array;
  readonly createParents?: boolean;
}

export interface StatFilesystemPathRequest extends FilesystemOperationRequest {
  readonly access: FilesystemAccess;
  readonly allowWorkspaceRoot?: boolean;
}

export interface FilesystemEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: FilesystemEntryKind;
  readonly size: number;
}

/** Provider-neutral filesystem enforcement capability. */
export interface Filesystem {
  readonly policy: FilesystemPolicy;

  preflight(
    request: PreflightFilesystemPathRequest,
  ): Promise<ResolvedFilesystemPath>;

  resolve(request: ResolveFilesystemPathRequest): Promise<ResolvedFilesystemPath>;

  readFile(request: ReadFilesystemFileRequest): Promise<Uint8Array>;

  writeFile(request: WriteFilesystemFileRequest): Promise<void>;

  stat(request: StatFilesystemPathRequest): Promise<FilesystemEntry>;
}
