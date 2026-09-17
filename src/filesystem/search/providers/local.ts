import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { FilesystemError } from "../../errors.js";
import type { Filesystem } from "../../types.js";
import { FilesystemSearchError } from "../errors.js";
import { FilesystemSearchService } from "../service.js";
import type {
  FilesystemSearch,
  FilesystemSearchPolicy,
  SearchTextContextLine,
  SearchTextMatch,
  SearchTextRequest,
  SearchTextResult,
} from "../types.js";

export const DEFAULT_SEARCH_MAX_FILES = 50_000;
export const DEFAULT_SEARCH_MAX_DIRECTORIES = 10_000;

export interface LocalFilesystemSearchOptions {
  readonly maxFiles?: number;
  readonly maxDirectories?: number;
}

/** Loader-owned resource bounds for local workspace traversal. */
export interface Config extends LocalFilesystemSearchOptions {}

export const Config: s<Config> = s.object({
  maxFiles: s.number().step(1).min(1),
  maxDirectories: s.number().step(1).min(1),
});

/** Process-local search implementation; it never starts an external process. */
export class LocalFilesystemSearchBackend implements FilesystemSearch {
  readonly policy: FilesystemSearchPolicy;

  constructor(
    private readonly filesystem: Filesystem,
    options: LocalFilesystemSearchOptions = {},
  ) {
    const values = Object.freeze({
      schemaVersion: 1 as const,
      backend: "local-node" as const,
      filesystemPolicyVersion: filesystem.policy.version,
      maxFiles: positiveSafeInteger(
        options.maxFiles ?? DEFAULT_SEARCH_MAX_FILES,
        "Filesystem Search maxFiles",
      ),
      maxDirectories: positiveSafeInteger(
        options.maxDirectories ?? DEFAULT_SEARCH_MAX_DIRECTORIES,
        "Filesystem Search maxDirectories",
      ),
    });
    this.policy = Object.freeze({
      ...values,
      version: createHash("sha256")
        .update(JSON.stringify(values))
        .digest("hex"),
    });
  }

  async search(request: SearchTextRequest): Promise<SearchTextResult> {
    validateRequest(request);
    throwIfAborted(request.signal);
    if (
      request.context.permissions.filesystemPolicyVersion !==
        this.policy.filesystemPolicyVersion
    ) {
      throw new FilesystemSearchError(
        "unavailable",
        "Filesystem Search belongs to another Filesystem generation",
      );
    }

    const root = await this.filesystem.resolve({
      path: request.path,
      access: "read",
      allowWorkspaceRoot: true,
      context: request.context,
      grant: request.grant,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (root.kind !== "file" && root.kind !== "directory") {
      throw new FilesystemSearchError(
        "search_failed",
        `Search path is not a file or directory: ${request.path}`,
      );
    }

    const matcher = createMatcher(
      request.pattern,
      request.literal === true,
      request.ignoreCase === true,
    );
    const glob = request.glob === undefined
      ? undefined
      : createGlobMatcher(request.glob);
    const files = root.kind === "file"
      ? [root.path]
      : await this.collectFiles(root.path, request);
    const matches: SearchTextMatch[] = [];
    let limitReached = false;

    for (const file of files) {
      throwIfAborted(request.signal);
      const relativePath = root.kind === "file"
        ? basename(file)
        : portablePath(relative(root.path, file));
      if (glob !== undefined && !glob(relativePath)) continue;

      const text = await this.readSearchableText(file, request);
      if (text === undefined) continue;
      const lines = normalizeLines(text);
      for (let index = 0; index < lines.length; index += 1) {
        throwIfAborted(request.signal);
        const line = lines[index] ?? "";
        matcher.lastIndex = 0;
        if (!matcher.test(line)) continue;
        matches.push(Object.freeze({
          path: file,
          lineNumber: index + 1,
          lineText: line,
          before: contextLines(lines, index, request.contextLines, "before"),
          after: contextLines(lines, index, request.contextLines, "after"),
        }));
        if (matches.length >= request.limit) {
          limitReached = true;
          break;
        }
      }
      if (limitReached) break;
    }

    return Object.freeze({
      root: root.path,
      rootKind: root.kind,
      matches: Object.freeze(matches),
      limitReached,
    });
  }

  private async collectFiles(
    root: string,
    request: SearchTextRequest,
  ): Promise<readonly string[]> {
    const files: string[] = [];
    const pending = [root];
    let directories = 0;
    while (pending.length > 0) {
      throwIfAborted(request.signal);
      const directory = pending.pop();
      if (directory === undefined) break;
      directories += 1;
      if (directories > this.policy.maxDirectories) {
        throw searchLimitExceeded("directories", this.policy.maxDirectories);
      }
      await this.filesystem.resolve({
        path: directory,
        access: "read",
        allowWorkspaceRoot: true,
        context: request.context,
        grant: request.grant,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error: unknown) {
        throw new FilesystemSearchError(
          "search_failed",
          `Cannot enumerate search directory ${directory}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const childDirectories: string[] = [];
      for (const entry of entries) {
        throwIfAborted(request.signal);
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (isProtectedDirectory(entry.name, this.filesystem)) continue;
          childDirectories.push(path);
        } else if (
          entry.isFile() &&
          !isProtectedFile(entry.name, this.filesystem)
        ) {
          files.push(path);
          if (files.length > this.policy.maxFiles) {
            throw searchLimitExceeded("files", this.policy.maxFiles);
          }
        }
      }
      for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
        const child = childDirectories[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return Object.freeze(files);
  }

  private async readSearchableText(
    path: string,
    request: SearchTextRequest,
  ): Promise<string | undefined> {
    let value: Uint8Array;
    try {
      value = await this.filesystem.readFile({
        path,
        context: request.context,
        grant: request.grant,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      throwIfAborted(request.signal);
      if (error instanceof FilesystemError && isSkippableFileError(error)) {
        return undefined;
      }
      throw error;
    }
    if (value.includes(0)) return undefined;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return undefined;
    }
  }
}

/** Cordis Provider binding the search capability to one Filesystem generation. */
export class LocalFilesystemSearch extends FilesystemSearchService {
  static readonly inject = ["filesystem"];
  static readonly Config = Config;

  readonly policy: FilesystemSearchPolicy;
  private readonly backend: LocalFilesystemSearchBackend;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backend = new LocalFilesystemSearchBackend(ctx.filesystem, config);
    this.policy = this.backend.policy;
  }

  search(request: SearchTextRequest): Promise<SearchTextResult> {
    return this.backend.search(request);
  }
}

function validateRequest(request: SearchTextRequest): void {
  if (request === null || typeof request !== "object") {
    throw new FilesystemSearchError("invalid_request", "Search request must be an object");
  }
  requireText(request.pattern, "Search pattern", true);
  requireText(request.path, "Search path");
  if (request.glob !== undefined) requireText(request.glob, "Search glob");
  if (!Number.isSafeInteger(request.contextLines) || request.contextLines < 0) {
    throw new FilesystemSearchError(
      "invalid_request",
      "Search contextLines must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new FilesystemSearchError(
      "invalid_request",
      "Search limit must be a positive safe integer",
    );
  }
}

function createMatcher(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "iu" : "u");
  } catch (error: unknown) {
    throw new FilesystemSearchError(
      "invalid_pattern",
      `Search pattern is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function createGlobMatcher(pattern: string): (path: string) => boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  expression += "$";
  const matcher = new RegExp(expression, "u");
  const basenameOnly = !pattern.includes("/");
  return (path) => matcher.test(basenameOnly ? basename(path) : path);
}

function contextLines(
  lines: readonly string[],
  matchIndex: number,
  count: number,
  side: "before" | "after",
): readonly SearchTextContextLine[] {
  if (count === 0) return Object.freeze([]);
  const start = side === "before" ? Math.max(0, matchIndex - count) : matchIndex + 1;
  const end = side === "before" ? matchIndex : Math.min(lines.length, matchIndex + count + 1);
  return Object.freeze(lines.slice(start, end).map((text, offset) =>
    Object.freeze({ lineNumber: start + offset + 1, text })
  ));
}

function normalizeLines(value: string): readonly string[] {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}

function isProtectedDirectory(name: string, filesystem: Filesystem): boolean {
  return filesystem.policy.protectedDirectoryNames.includes(name);
}

function isProtectedFile(name: string, filesystem: Filesystem): boolean {
  if (filesystem.policy.protectedNameExceptions.includes(name)) return false;
  return filesystem.policy.protectedFileNames.includes(name) ||
    filesystem.policy.protectedFilePrefixes.some((prefix) => name.startsWith(prefix));
}

function portablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requireText(value: string, label: string, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new FilesystemSearchError(
      "invalid_request",
      `${label} must be ${allowEmpty ? "text" : "non-empty text"}`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Search aborted",
  );
  error.name = "AbortError";
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function searchLimitExceeded(kind: "files" | "directories", limit: number): Error {
  return new FilesystemSearchError(
    "search_limit_exceeded",
    `Filesystem Search exceeded its ${limit} ${kind} traversal limit`,
  );
}

function isSkippableFileError(error: FilesystemError): boolean {
  return error.code === "filesystem_not_found" ||
    error.code === "filesystem_not_file" ||
    error.code === "filesystem_too_large" ||
    error.code === "filesystem_protected_path" ||
    error.code === "filesystem_symbolic_link";
}

export default LocalFilesystemSearch;
