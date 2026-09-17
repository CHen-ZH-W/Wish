import { FilesystemUnavailableError } from "./errors.js";
import type {
  Filesystem,
  FilesystemEntry,
  PreflightFilesystemPathRequest,
  ReadFilesystemFileRequest,
  ResolvedFilesystemPath,
  ResolveFilesystemPathRequest,
  StatFilesystemPathRequest,
  WriteFilesystemFileRequest,
} from "./types.js";

/** Fail-closed placeholder used only by explicit standalone compositions. */
export function createUnavailableFilesystem(
  reason = "No Filesystem Provider was supplied",
): Filesystem {
  const unavailable = (): FilesystemUnavailableError =>
    new FilesystemUnavailableError(reason);
  return Object.freeze({
    policy: Object.freeze({
      schemaVersion: 1 as const,
      version: "filesystem-unavailable-v1",
      scope: "workspace" as const,
      symbolicLinks: "deny" as const,
      maxFileBytes: 1,
      protectedDirectoryNames: Object.freeze([]),
      protectedFileNames: Object.freeze([]),
      protectedFilePrefixes: Object.freeze([]),
      protectedNameExceptions: Object.freeze([]),
    }),
    preflight(
      _request: PreflightFilesystemPathRequest,
    ): Promise<ResolvedFilesystemPath> {
      return Promise.reject(unavailable());
    },
    resolve(_request: ResolveFilesystemPathRequest): Promise<ResolvedFilesystemPath> {
      return Promise.reject(unavailable());
    },
    readFile(_request: ReadFilesystemFileRequest): Promise<Uint8Array> {
      return Promise.reject(unavailable());
    },
    writeFile(_request: WriteFilesystemFileRequest): Promise<void> {
      return Promise.reject(unavailable());
    },
    stat(_request: StatFilesystemPathRequest): Promise<FilesystemEntry> {
      return Promise.reject(unavailable());
    },
  });
}
