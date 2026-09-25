import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

import { assertActiveCapabilityAuthorizationGrant } from
  "../../permissions/authorization.js";
import {
  FilesystemAuthorityMismatchError,
  FilesystemError,
  FilesystemInvalidPathError,
  FilesystemNotFileError,
  FilesystemNotFoundError,
  FilesystemOutsideWorkspaceError,
  FilesystemProtectedPathError,
  FilesystemSymbolicLinkError,
  FilesystemTooLargeError,
} from "../errors.js";
import { FilesystemService } from "../service.js";
import type {
  Filesystem,
  FilesystemAccess,
  FilesystemEntry,
  FilesystemEntryKind,
  FilesystemExecutionContext,
  FilesystemPolicy,
  PreflightFilesystemPathRequest,
  ReadFilesystemFileRequest,
  ResolvedFilesystemPath,
  ResolveFilesystemPathRequest,
  StatFilesystemPathRequest,
  WriteFilesystemFileRequest,
} from "../types.js";

export const DEFAULT_FILESYSTEM_MAX_FILE_BYTES = 64_000_000;
export const DEFAULT_PROTECTED_DIRECTORY_NAMES = Object.freeze([
  ".git",
  ".wish",
]);
export const DEFAULT_PROTECTED_FILE_NAMES = Object.freeze([
  ".env",
  ".gitconfig",
  ".netrc",
  ".npmrc",
]);
export const DEFAULT_PROTECTED_FILE_PREFIXES = Object.freeze([".env."]);
export const DEFAULT_PROTECTED_NAME_EXCEPTIONS = Object.freeze([
  ".env.example",
]);

export interface LocalFilesystemOptions {
  readonly maxFileBytes?: number;
  readonly protectedDirectoryNames?: readonly string[];
  readonly protectedFileNames?: readonly string[];
  readonly protectedFilePrefixes?: readonly string[];
  readonly protectedNameExceptions?: readonly string[];
}

/** Loader-owned Local Filesystem policy. */
export interface Config {
  readonly maxFileBytes?: number;
  readonly protectedDirectoryNames?: string[];
  readonly protectedFileNames?: string[];
  readonly protectedFilePrefixes?: string[];
  readonly protectedNameExceptions?: string[];
}

export const Config: s<Config> = s.object({
  maxFileBytes: s.number().step(1).min(1),
  protectedDirectoryNames: s.array(s.string()).default([
    ...DEFAULT_PROTECTED_DIRECTORY_NAMES,
  ]),
  protectedFileNames: s.array(s.string()).default([
    ...DEFAULT_PROTECTED_FILE_NAMES,
  ]),
  protectedFilePrefixes: s.array(s.string()).default([
    ...DEFAULT_PROTECTED_FILE_PREFIXES,
  ]),
  protectedNameExceptions: s.array(s.string()).default([
    ...DEFAULT_PROTECTED_NAME_EXCEPTIONS,
  ]),
});

/** Process-local implementation reusable by standalone and Cordis compositions. */
export class LocalFilesystemBackend implements Filesystem {
  readonly policy: FilesystemPolicy;

  constructor(options: LocalFilesystemOptions = {}) {
    this.policy = createPolicy(options);
  }

  async preflight(
    request: PreflightFilesystemPathRequest,
  ): Promise<ResolvedFilesystemPath> {
    return await this.resolvePath(request, false);
  }

  async resolve(
    request: ResolveFilesystemPathRequest,
  ): Promise<ResolvedFilesystemPath> {
    return await this.resolvePath(request, true);
  }

  async readFile(request: ReadFilesystemFileRequest): Promise<Uint8Array> {
    const resolved = await this.resolvePath({
      ...request,
      access: "read",
    });
    if (resolved.kind !== "file") {
      throw new FilesystemNotFileError(resolved.path);
    }
    throwIfAborted(request.signal);
    assertAuthority(request, "read", resolved.path, this.policy);

    let handle;
    try {
      handle = await open(
        resolved.path,
        constants.O_RDONLY | noFollowFlag(),
      );
      const information = await handle.stat();
      if (!information.isFile()) throw new FilesystemNotFileError(resolved.path);
      assertFileSize(resolved.path, information.size, this.policy.maxFileBytes);
      throwIfAborted(request.signal);
      const value = await handle.readFile();
      throwIfAborted(request.signal);
      return new Uint8Array(value);
    } catch (error: unknown) {
      throw mapIoError(error, resolved.path);
    } finally {
      await handle?.close();
    }
  }

  async writeFile(request: WriteFilesystemFileRequest): Promise<void> {
    if (!(request.data instanceof Uint8Array)) {
      throw new TypeError("Filesystem write data must be a Uint8Array");
    }
    assertFileSize(request.path, request.data.byteLength, this.policy.maxFileBytes);
    const first = await this.resolvePath({
      ...request,
      access: "write",
      allowMissing: true,
    });
    if (first.exists && first.kind !== "file") {
      throw new FilesystemNotFileError(first.path);
    }
    if (!first.exists && request.createParents === true) {
      await ensureParentDirectories(
        request.context.workspace.root,
        first.path,
        request.signal,
      );
    }

    const resolved = await this.resolvePath({
      ...request,
      access: "write",
      allowMissing: true,
    });
    if (resolved.exists && resolved.kind !== "file") {
      throw new FilesystemNotFileError(resolved.path);
    }
    throwIfAborted(request.signal);
    assertAuthority(request, "write", resolved.path, this.policy);

    let handle;
    let failure: unknown;
    try {
      handle = await open(
        resolved.path,
        constants.O_WRONLY | constants.O_CREAT | noFollowFlag(),
        0o666,
      );
      const information = await handle.stat();
      if (!information.isFile()) throw new FilesystemNotFileError(resolved.path);
      throwIfAborted(request.signal);
      assertAuthority(request, "write", resolved.path, this.policy);
      await handle.truncate(0);
      await handle.writeFile(request.data);
      await handle.sync();
      throwIfAborted(request.signal);
    } catch (error: unknown) {
      failure = mapIoError(error, resolved.path);
      throw failure;
    } finally {
      try {
        await handle?.close();
      } catch (closeError: unknown) {
        if (failure === undefined) throw mapIoError(closeError, resolved.path);
      }
    }
  }

  async stat(request: StatFilesystemPathRequest): Promise<FilesystemEntry> {
    const resolved = await this.resolvePath({
      ...request,
      access: request.access,
      ...(request.allowWorkspaceRoot === undefined
        ? {}
        : { allowWorkspaceRoot: request.allowWorkspaceRoot }),
    });
    if (resolved.kind === undefined) {
      throw new FilesystemNotFoundError(resolved.path);
    }
    const information = await lstat(resolved.path);
    throwIfAborted(request.signal);
    if (information.isSymbolicLink()) {
      throw new FilesystemSymbolicLinkError(resolved.path);
    }
    return Object.freeze({
      path: resolved.path,
      relativePath: resolved.relativePath,
      kind: resolved.kind,
      size: information.size,
    });
  }

  private async resolvePath(
    request: ResolveFilesystemPathRequest | PreflightFilesystemPathRequest,
    requireAuthority = true,
  ): Promise<ResolvedFilesystemPath> {
    validateResolveRequest(request);
    throwIfAborted(request.signal);
    const root = resolve(request.context.workspace.root);
    const requestedPath = requirePath(request.path);
    const target = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(root, requestedPath);
    assertContext(request.context, root, target, this.policy);
    const relativePath = relative(root, target);
    if (!isInside(root, target)) throw new FilesystemOutsideWorkspaceError(target);
    if (relativePath.length === 0 && request.allowWorkspaceRoot !== true) {
      throw new FilesystemInvalidPathError(target);
    }
    if (isProtectedPath(relativePath, this.policy)) {
      throw new FilesystemProtectedPathError(target);
    }
    if (requireAuthority) {
      assertAuthority(
        request as ResolveFilesystemPathRequest,
        request.access,
        target,
        this.policy,
      );
    }

    const canonicalRootPath = await canonicalWorkspaceRoot(root, request.signal);
    let current = root;
    const segments = relativePath.length === 0 ? [] : relativePath.split(sep);
    for (const segment of segments) {
      current = resolve(current, segment);
      let information;
      try {
        information = await lstat(current);
      } catch (error: unknown) {
        throwIfAborted(request.signal);
        if (isNodeError(error, "ENOENT")) {
          if (request.allowMissing === true) {
            return Object.freeze({
              requestedPath,
              path: target,
              relativePath,
              exists: false,
            });
          }
          throw new FilesystemNotFoundError(target, { cause: error });
        }
        throw mapIoError(error, target);
      }
      throwIfAborted(request.signal);
      if (information.isSymbolicLink()) {
        throw new FilesystemSymbolicLinkError(current);
      }
    }

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch (error: unknown) {
      throw mapIoError(error, target);
    }
    throwIfAborted(request.signal);
    if (!isInside(canonicalRootPath, canonicalTarget)) {
      throw new FilesystemOutsideWorkspaceError(target);
    }
    if (canonicalTarget !== target) {
      throw new FilesystemSymbolicLinkError(target);
    }
    const information = await lstat(target);
    const kind = entryKind(information, target);
    return Object.freeze({
      requestedPath,
      path: target,
      relativePath,
      exists: true,
      kind,
    });
  }
}

/** Cordis Provider for the local process filesystem. */
export class LocalFilesystem extends FilesystemService {
  static readonly Config = Config;

  readonly policy: FilesystemPolicy;
  private readonly backend: LocalFilesystemBackend;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backend = new LocalFilesystemBackend(config);
    this.policy = this.backend.policy;
    this.work = new PluginWorkOwner(ctx, { code: "filesystem", codeReload: true });
  }

  preflight(
    request: PreflightFilesystemPathRequest,
  ): Promise<ResolvedFilesystemPath> {
    return this.work.run(() => this.backend.preflight(request));
  }

  resolve(request: ResolveFilesystemPathRequest): Promise<ResolvedFilesystemPath> {
    return this.work.run(() => this.backend.resolve(request));
  }

  readFile(request: ReadFilesystemFileRequest): Promise<Uint8Array> {
    return this.work.run(() => this.backend.readFile(request));
  }

  writeFile(request: WriteFilesystemFileRequest): Promise<void> {
    return this.work.run(() => this.backend.writeFile(request));
  }

  stat(request: StatFilesystemPathRequest): Promise<FilesystemEntry> {
    return this.work.run(() => this.backend.stat(request));
  }
}

function createPolicy(options: LocalFilesystemOptions): FilesystemPolicy {
  const values = {
    maxFileBytes: positiveSafeInteger(
      options.maxFileBytes ?? DEFAULT_FILESYSTEM_MAX_FILE_BYTES,
      "Filesystem maxFileBytes",
    ),
    protectedDirectoryNames: protectedNames(
      options.protectedDirectoryNames ?? DEFAULT_PROTECTED_DIRECTORY_NAMES,
      "protectedDirectoryNames",
    ),
    protectedFileNames: protectedNames(
      options.protectedFileNames ?? DEFAULT_PROTECTED_FILE_NAMES,
      "protectedFileNames",
    ),
    protectedFilePrefixes: protectedNames(
      options.protectedFilePrefixes ?? DEFAULT_PROTECTED_FILE_PREFIXES,
      "protectedFilePrefixes",
    ),
    protectedNameExceptions: protectedNames(
      options.protectedNameExceptions ?? DEFAULT_PROTECTED_NAME_EXCEPTIONS,
      "protectedNameExceptions",
    ),
  };
  return Object.freeze({
    schemaVersion: 1 as const,
    version: identity({ schemaVersion: 1, ...values }),
    scope: "workspace" as const,
    symbolicLinks: "deny" as const,
    maxFileBytes: values.maxFileBytes,
    protectedDirectoryNames: Object.freeze(values.protectedDirectoryNames),
    protectedFileNames: Object.freeze(values.protectedFileNames),
    protectedFilePrefixes: Object.freeze(values.protectedFilePrefixes),
    protectedNameExceptions: Object.freeze(values.protectedNameExceptions),
  });
}

function validateResolveRequest(
  request: ResolveFilesystemPathRequest | PreflightFilesystemPathRequest,
): void {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Filesystem request must be an object");
  }
  if (request.access !== "read" && request.access !== "write") {
    throw new TypeError("Filesystem access must be read or write");
  }
  if (request.context === null || typeof request.context !== "object") {
    throw new TypeError("Filesystem request requires an execution context");
  }
}

function assertContext(
  context: FilesystemExecutionContext,
  root: string,
  path: string,
  policy: FilesystemPolicy,
): void {
  if (context.workspace.root !== root) {
    throw new FilesystemAuthorityMismatchError(
      path,
      "Workspace root is not canonical",
    );
  }
  if (
    context.permissions.workspace.fingerprint !== context.workspace.fingerprint ||
    context.permissions.workspace.revision !== context.workspace.revision
  ) {
    throw new FilesystemAuthorityMismatchError(
      path,
      "Permission Snapshot belongs to another Workspace Snapshot",
    );
  }
  if (context.permissions.filesystemPolicyVersion !== policy.version) {
    throw new FilesystemAuthorityMismatchError(
      path,
      "Permission Snapshot belongs to another Filesystem policy generation",
    );
  }
}

function assertAuthority(
  request: {
    readonly path: string;
    readonly context: FilesystemExecutionContext;
    readonly grant: ReadFilesystemFileRequest["grant"];
  },
  access: FilesystemAccess,
  target: string,
  policy: FilesystemPolicy,
): void {
  try {
    assertActiveCapabilityAuthorizationGrant(request.grant, {
      policyVersion: request.context.permissions.policyVersion,
      authorityVersion: request.context.permissions.authorityVersion,
    });
  } catch (error: unknown) {
    throw new FilesystemAuthorityMismatchError(target, errorMessage(error));
  }
  assertContext(request.context, resolve(request.context.workspace.root), target, policy);
  const capability = access === "read" ? "filesystem.read" : "filesystem.write";
  if (!request.context.permissions.ceiling.allowedCapabilities.includes(capability)) {
    throw new FilesystemAuthorityMismatchError(
      target,
      `Permission ceiling excludes ${capability}`,
    );
  }
  const permitted = request.grant.capabilities.requirements.some((requirement) =>
    requirement.capability === capability && requirement.paths.some((scope) =>
      scopeAllowsPath(scope, target, request.context.workspace.root)
    )
  );
  if (!permitted) {
    throw new FilesystemAuthorityMismatchError(
      target,
      `Grant does not include ${capability}`,
    );
  }
}

function scopeAllowsPath(scope: string, target: string, root: string): boolean {
  const resolvedScope = isAbsolute(scope) ? resolve(scope) : resolve(root, scope);
  if (resolvedScope === target) return true;
  if (!isInside(root, resolvedScope) || !isInside(resolvedScope, target)) return false;
  try {
    const information = lstatSync(resolvedScope);
    return information.isDirectory() && !information.isSymbolicLink();
  } catch {
    return false;
  }
}

async function canonicalWorkspaceRoot(
  root: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch (error: unknown) {
    throw mapIoError(error, root);
  }
  throwIfAborted(signal);
  if (canonical !== root) {
    throw new FilesystemAuthorityMismatchError(
      root,
      "Workspace root changed after resolution",
    );
  }
  return canonical;
}

async function ensureParentDirectories(
  root: string,
  target: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const parent = dirname(target);
  const relativeParent = relative(root, parent);
  let current = root;
  for (const segment of relativeParent.length === 0 ? [] : relativeParent.split(sep)) {
    current = resolve(current, segment);
    throwIfAborted(signal);
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink()) {
        throw new FilesystemSymbolicLinkError(current);
      }
      if (!information.isDirectory()) throw new FilesystemNotFileError(current);
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError: unknown) {
        if (!isNodeError(mkdirError, "EEXIST")) {
          throw mapIoError(mkdirError, current);
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink()) throw new FilesystemSymbolicLinkError(current);
      if (!created.isDirectory()) throw new FilesystemNotFileError(current);
    }
  }
}

function isProtectedPath(relativePath: string, policy: FilesystemPolicy): boolean {
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  return segments.some((name) => {
    if (policy.protectedNameExceptions.includes(name)) return false;
    return policy.protectedDirectoryNames.includes(name) ||
      policy.protectedFileNames.includes(name) ||
      policy.protectedFilePrefixes.some((prefix) => name.startsWith(prefix));
  });
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot));
}

function entryKind(
  information: Awaited<ReturnType<typeof lstat>>,
  path: string,
): FilesystemEntryKind {
  if (information.isFile()) return "file";
  if (information.isDirectory()) return "directory";
  throw new FilesystemNotFileError(path);
}

function mapIoError(error: unknown, path: string): Error {
  if (error instanceof FilesystemError) return error;
  if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
    return new FilesystemNotFoundError(path, { cause: error });
  }
  if (isNodeError(error, "ELOOP")) {
    return new FilesystemSymbolicLinkError(path);
  }
  return new FilesystemError(
    "filesystem_unavailable",
    `Filesystem operation failed for ${path}: ${errorMessage(error)}`,
    path,
    { cause: error },
  );
}

function assertFileSize(path: string, size: number, maxBytes: number): void {
  if (size > maxBytes) throw new FilesystemTooLargeError(path, maxBytes);
}

function protectedNames(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.includes("/") || value.includes("\\") || value === "." || value === ".."
    ) throw new TypeError(`${label} entries must be trimmed path names`);
    if (!seen.has(value)) result.push(value);
    seen.add(value);
  }
  return result;
}

function requirePath(path: string): string {
  if (
    typeof path !== "string" || path.length === 0 || path !== path.trim() ||
    path.includes("\0")
  ) throw new FilesystemInvalidPathError(path);
  return path;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Filesystem operation aborted",
  );
}

export default LocalFilesystem;
