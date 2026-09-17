import type { CapabilityAuthorizationGrant } from
  "../../permissions/authorization.js";
import type { FilesystemExecutionContext } from "../types.js";

export interface FilesystemSearchPolicy {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly backend: "local-node";
  readonly filesystemPolicyVersion: string;
  readonly maxFiles: number;
  readonly maxDirectories: number;
}

export interface SearchTextRequest {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly literal?: boolean;
  readonly contextLines: number;
  readonly limit: number;
  readonly context: FilesystemExecutionContext;
  readonly grant: CapabilityAuthorizationGrant;
  readonly signal?: AbortSignal;
}

export interface SearchTextContextLine {
  readonly lineNumber: number;
  readonly text: string;
}

export interface SearchTextMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly before: readonly SearchTextContextLine[];
  readonly after: readonly SearchTextContextLine[];
}

export interface SearchTextResult {
  readonly root: string;
  readonly rootKind: "file" | "directory";
  readonly matches: readonly SearchTextMatch[];
  readonly limitReached: boolean;
}

/** Provider-neutral workspace text-search capability. */
export interface FilesystemSearch {
  readonly policy: FilesystemSearchPolicy;

  search(request: SearchTextRequest): Promise<SearchTextResult>;
}
