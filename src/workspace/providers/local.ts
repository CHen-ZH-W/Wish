import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import {
  WorkspaceInstructionTooLargeError,
  WorkspaceInstructionUnavailableError,
  WorkspaceInvalidRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotFoundError,
  WorkspaceRootUnavailableError,
} from "../errors.js";
import { WorkspaceService } from "../service.js";
import { snapshotWorkspace } from "../snapshot.js";
import type {
  ResolveWorkspaceRequest,
  WorkspaceInstruction,
  WorkspaceRepository,
  WorkspaceSnapshot,
} from "../types.js";

export const DEFAULT_WORKSPACE_INSTRUCTION_FILES = Object.freeze([
  "AGENTS.md",
  "AGENTS.local.md",
]);
export const DEFAULT_WORKSPACE_REPOSITORY_MARKERS = Object.freeze([".git"]);
export const DEFAULT_WORKSPACE_MAX_INSTRUCTION_BYTES = 128 * 1024;
export const DEFAULT_WORKSPACE_MAX_INSTRUCTION_FILE_BYTES = 64 * 1024;

const SNAPSHOT_SCHEMA_VERSION = 1;

/** Loader-owned Local Workspace discovery settings. */
export interface Config {
  readonly instructionFiles?: string[];
  readonly repositoryMarkers?: string[];
  readonly maxInstructionBytes?: number;
  readonly maxInstructionFileBytes?: number;
}

export const Config: s<Config> = s.object({
  instructionFiles: s.array(s.string()).default([
    ...DEFAULT_WORKSPACE_INSTRUCTION_FILES,
  ]),
  repositoryMarkers: s.array(s.string()).default([
    ...DEFAULT_WORKSPACE_REPOSITORY_MARKERS,
  ]),
  maxInstructionBytes: s.number().step(1).min(1),
  maxInstructionFileBytes: s.number().step(1).min(1),
});

interface ResolvedConfig {
  readonly instructionFiles: readonly string[];
  readonly repositoryMarkers: readonly string[];
  readonly maxInstructionBytes: number;
  readonly maxInstructionFileBytes: number;
}

/** Local filesystem Provider for the Workspace capability. */
export class LocalWorkspace extends WorkspaceService {
  static readonly inject = ["launch"];
  static readonly Config = Config;

  private readonly baseDirectory: string;
  private readonly config: ResolvedConfig;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.baseDirectory = resolve(ctx.launch.cwd);
    this.config = resolveConfig(config);
  }

  async resolve(
    request: ResolveWorkspaceRequest,
  ): Promise<WorkspaceSnapshot> {
    const inputRoot = requireRoot(request);
    throwIfAborted(request.signal);
    const requestedRoot = resolve(this.baseDirectory, inputRoot);
    const root = await canonicalDirectory(requestedRoot, request.signal);
    const repository = await discoverRepository(
      root,
      requestedRoot,
      this.config.repositoryMarkers,
      request.signal,
    );
    const instructions = await loadInstructions({
      root,
      requestedRoot,
      instructionRoot: repository?.root ?? root,
      config: this.config,
      signal: request.signal,
    });
    const fingerprint = identity("workspace", root);
    const revision = identity("workspace-revision", JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      root,
      fingerprint,
      instructions,
      repository: repository ?? null,
    }));
    throwIfAborted(request.signal);
    return snapshotWorkspace({
      requestedRoot,
      root,
      fingerprint,
      revision,
      instructions,
      ...(repository === undefined ? {} : { repository }),
    });
  }
}

async function canonicalDirectory(
  requestedRoot: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch (error: unknown) {
    throwPathError(error, requestedRoot);
  }
  throwIfAborted(signal);

  let metadata;
  try {
    metadata = await stat(root);
  } catch (error: unknown) {
    throwPathError(error, requestedRoot);
  }
  throwIfAborted(signal);
  if (!metadata.isDirectory()) {
    throw new WorkspaceRootNotDirectoryError(requestedRoot);
  }

  try {
    await access(root, constants.R_OK | constants.X_OK);
  } catch (error: unknown) {
    throwPathError(error, requestedRoot);
  }
  throwIfAborted(signal);
  return root;
}

async function discoverRepository(
  root: string,
  requestedRoot: string,
  markers: readonly string[],
  signal: AbortSignal | undefined,
): Promise<WorkspaceRepository | undefined> {
  let current = root;
  for (;;) {
    for (const marker of markers) {
      throwIfAborted(signal);
      const path = join(current, marker);
      try {
        await stat(path);
        throwIfAborted(signal);
        return Object.freeze({
          kind: "git" as const,
          root: current,
          identity: identity("git-repository", current),
        });
      } catch (error: unknown) {
        throwIfAborted(signal);
        if (!isMissingPathError(error)) {
          throw new WorkspaceRootUnavailableError(requestedRoot, {
            cause: error,
          });
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function loadInstructions(input: {
  readonly root: string;
  readonly requestedRoot: string;
  readonly instructionRoot: string;
  readonly config: ResolvedConfig;
  readonly signal: AbortSignal | undefined;
}): Promise<readonly WorkspaceInstruction[]> {
  const instructions: WorkspaceInstruction[] = [];
  const seenTargets = new Set<string>();
  let remainingBytes = input.config.maxInstructionBytes;
  for (const directory of ancestorChain(input.instructionRoot, input.root)) {
    for (const candidate of input.config.instructionFiles) {
      throwIfAborted(input.signal);
      const source = join(directory, candidate);
      const target = await instructionTarget({
        source,
        instructionRoot: input.instructionRoot,
        requestedRoot: input.requestedRoot,
        signal: input.signal,
      });
      if (target === undefined || seenTargets.has(target)) continue;
      seenTargets.add(target);
      const loaded = await readInstruction({
        source,
        target,
        requestedRoot: input.requestedRoot,
        maxFileBytes: input.config.maxInstructionFileBytes,
        remainingBytes,
        signal: input.signal,
      });
      if (loaded === undefined) continue;
      remainingBytes -= loaded.bytes;
      instructions.push(Object.freeze({
        id: `workspace-instruction:${digest(source)}`,
        authority: "developer" as const,
        source,
        content: loaded.content,
        digest: `sha256:${digest(loaded.content)}`,
      }));
    }
  }
  return Object.freeze(instructions);
}

async function instructionTarget(input: {
  readonly source: string;
  readonly instructionRoot: string;
  readonly requestedRoot: string;
  readonly signal: AbortSignal | undefined;
}): Promise<string | undefined> {
  let target: string;
  try {
    target = await realpath(input.source);
  } catch (error: unknown) {
    throwIfAborted(input.signal);
    if (isMissingPathError(error)) return undefined;
    throw new WorkspaceInstructionUnavailableError(
      input.requestedRoot,
      input.source,
      { cause: error },
    );
  }
  throwIfAborted(input.signal);
  if (!isInside(input.instructionRoot, target)) {
    throw new WorkspaceInstructionUnavailableError(
      input.requestedRoot,
      input.source,
      { cause: new Error("Workspace instruction target escapes its instruction root") },
    );
  }
  return target;
}

async function readInstruction(input: {
  readonly source: string;
  readonly target: string;
  readonly requestedRoot: string;
  readonly maxFileBytes: number;
  readonly remainingBytes: number;
  readonly signal: AbortSignal | undefined;
}): Promise<{ readonly content: string; readonly bytes: number } | undefined> {
  let handle;
  try {
    handle = await open(input.target, "r");
  } catch (error: unknown) {
    throwIfAborted(input.signal);
    if (isMissingPathError(error)) return undefined;
    throw new WorkspaceInstructionUnavailableError(
      input.requestedRoot,
      input.source,
      { cause: error },
    );
  }

  let failure: unknown;
  try {
    const information = await handle.stat();
    throwIfAborted(input.signal);
    if (!information.isFile()) return undefined;
    const limit = Math.min(input.maxFileBytes, input.remainingBytes);
    if (information.size > limit) {
      throw new WorkspaceInstructionTooLargeError(
        input.requestedRoot,
        input.source,
        limit,
      );
    }
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    for (;;) {
      throwIfAborted(input.signal);
      const read = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        bytes,
      );
      bytes += read.bytesRead;
      if (read.bytesRead === 0 || bytes === buffer.length) break;
    }
    throwIfAborted(input.signal);
    if (bytes > limit) {
      throw new WorkspaceInstructionTooLargeError(
        input.requestedRoot,
        input.source,
        limit,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytes),
      );
    } catch (error: unknown) {
      throw new WorkspaceInstructionUnavailableError(
        input.requestedRoot,
        input.source,
        { cause: error },
      );
    }
    return content.trim().length === 0
      ? undefined
      : Object.freeze({ content, bytes });
  } catch (error: unknown) {
    failure = error;
    if (
      error instanceof WorkspaceInstructionTooLargeError ||
      error instanceof WorkspaceInstructionUnavailableError
    ) throw error;
    throwIfAborted(input.signal);
    throw new WorkspaceInstructionUnavailableError(
      input.requestedRoot,
      input.source,
      { cause: error },
    );
  } finally {
    try {
      await handle.close();
    } catch (error: unknown) {
      if (failure === undefined) {
        throw new WorkspaceInstructionUnavailableError(
          input.requestedRoot,
          input.source,
          { cause: error },
        );
      }
    }
  }
}

function ancestorChain(root: string, leaf: string): readonly string[] {
  const reversed: string[] = [];
  let current = leaf;
  for (;;) {
    reversed.push(current);
    if (current === root) return Object.freeze(reversed.reverse());
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Workspace instruction root is not an ancestor");
    }
    current = parent;
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  return Object.freeze({
    instructionFiles: leafNames(
      config.instructionFiles ?? [...DEFAULT_WORKSPACE_INSTRUCTION_FILES],
      "Workspace instructionFiles",
    ),
    repositoryMarkers: leafNames(
      config.repositoryMarkers ?? [...DEFAULT_WORKSPACE_REPOSITORY_MARKERS],
      "Workspace repositoryMarkers",
    ),
    maxInstructionBytes: positiveInteger(
      config.maxInstructionBytes ?? DEFAULT_WORKSPACE_MAX_INSTRUCTION_BYTES,
      "Workspace maxInstructionBytes",
    ),
    maxInstructionFileBytes: positiveInteger(
      config.maxInstructionFileBytes ??
        DEFAULT_WORKSPACE_MAX_INSTRUCTION_FILE_BYTES,
      "Workspace maxInstructionFileBytes",
    ),
  });
}

function leafNames(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  return Object.freeze(values.map((value) => {
    if (
      typeof value !== "string" || value.length === 0 ||
      value !== value.trim() || value === "." || value === ".." ||
      /[\\/\0]/u.test(value)
    ) {
      throw new Error(`${label} must contain only trimmed leaf names`);
    }
    if (seen.has(value)) throw new Error(`${label} contains duplicate ${value}`);
    seen.add(value);
    return value;
  }));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireRoot(request: ResolveWorkspaceRequest): string {
  if (request === null || typeof request !== "object") {
    throw new WorkspaceInvalidRootError();
  }
  const root: unknown = request.root;
  if (
    typeof root !== "string" || root.length === 0 || root !== root.trim() ||
    root.includes("\0")
  ) {
    throw new WorkspaceInvalidRootError(
      typeof root === "string" ? root : undefined,
    );
  }
  return root;
}

function throwPathError(error: unknown, requestedRoot: string): never {
  if (isNodeError(error, "ENOENT")) {
    throw new WorkspaceRootNotFoundError(requestedRoot, { cause: error });
  }
  if (isNodeError(error, "ENOTDIR")) {
    throw new WorkspaceRootNotDirectoryError(requestedRoot);
  }
  throw new WorkspaceRootUnavailableError(requestedRoot, { cause: error });
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR");
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path.length === 0 ||
    (path !== ".." && !path.startsWith(`..${sep}`));
}

function identity(kind: string, value: string): string {
  return `${kind}:sha256:${digest(value)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export default LocalWorkspace;
