import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

import {
  assertActiveCapabilityAuthorizationGrant,
  type CapabilityRequirement,
} from "../../permissions/authorization.js";
import type { Filesystem } from "../../filesystem/types.js";
import {
  ShellExecutionFailedError,
  ShellInvalidInputError,
  ShellPermissionDeniedError,
  ShellPolicyMismatchError,
  ShellUnavailableError,
} from "../errors.js";
import { ShellService } from "../service.js";
import type {
  PreflightShellCommandRequest,
  ResolveShellCommandRequest,
  RunShellCommandRequest,
  Shell,
  ShellCommandPreflight,
  ShellCommandSpec,
  ShellExecutionResult,
  ShellPolicy,
  ShellResourceLimits,
} from "../types.js";
import { spawnShellProcess } from "./process.js";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120;
export const DEFAULT_SHELL_MAX_TIMEOUT_SECONDS = 900;
// RLIMIT_NPROC is counted per Unix user, not per sandbox process tree. Keep the
// default above realistic shared CI/desktop process counts; operators can lower
// it only when Wish runs under a dedicated OS user.
export const DEFAULT_SHELL_MAX_PROCESSES = 4_096;
export const DEFAULT_SHELL_MAX_OPEN_FILES = 256;
export const DEFAULT_SHELL_MAX_FILE_SIZE_BYTES = 64_000_000;
export const DEFAULT_SHELL_MAX_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_SHELL_SCOPED_PATHS = 128;

export interface LinuxNativeShellOptions {
  readonly launcherPath?: string;
  readonly defaultTimeoutSeconds?: number;
  readonly maxTimeoutSeconds?: number;
  readonly maxProcesses?: number;
  readonly maxOpenFiles?: number;
  readonly maxFileSizeBytes?: number;
  readonly maxMemoryBytes?: number;
}

/** Loader-owned Linux native sandbox settings. */
export interface Config extends LinuxNativeShellOptions {}

export const Config: s<Config> = s.object({
  launcherPath: s.string(),
  defaultTimeoutSeconds: s.number().min(0),
  maxTimeoutSeconds: s.number().min(0),
  maxProcesses: s.number().step(1).min(1),
  maxOpenFiles: s.number().step(1).min(1),
  maxFileSizeBytes: s.number().step(1).min(1),
  maxMemoryBytes: s.number().step(1).min(1),
});

interface ResolvedOptions {
  readonly launcherPath: string;
  readonly defaultTimeoutSeconds: number;
  readonly limits: ShellResourceLimits;
}

/** Process-local Linux implementation reusable by standalone and Cordis graphs. */
export class LinuxNativeShellBackend implements Shell {
  readonly policy: ShellPolicy;
  private readonly options: ResolvedOptions;
  private readonly resolved = new WeakSet<ShellCommandSpec>();

  constructor(
    private readonly filesystem: Filesystem,
    options: LinuxNativeShellOptions = {},
  ) {
    if (process.platform !== "linux") {
      throw new ShellUnavailableError(
        "Linux Native Shell is only available on Linux",
      );
    }
    this.options = resolveOptions(options);
    this.policy = createPolicy(filesystem, this.options.limits);
  }

  async preflight(
    request: PreflightShellCommandRequest,
  ): Promise<ShellCommandPreflight> {
    validatePreflightRequest(request);
    throwIfAborted(request.signal);
    assertExecutionContext(request.context, this.policy, this.filesystem);
    assertCapabilitiesWithinCeiling(request.context, request.capabilities);
    const command = requireCommand(request.command);
    const processCapability = requireProcessCapability(
      request.capabilities,
      command,
    );
    assertProcessArguments(processCapability, request);
    const cwd = await resolveCwd(
      request.cwd ?? processCapability.cwd ?? request.context.workspace.root,
      request.context.workspace.root,
      request.signal,
    );
    const timeoutSeconds = resolveTimeout(
      request.timeoutSeconds ?? processCapability.timeoutSeconds,
      this.options.defaultTimeoutSeconds,
      this.options.limits.maxTimeoutSeconds,
    );
    const readPaths = await preflightScopes(
      request,
      this.filesystem,
      "filesystem.read",
    );
    const writePaths = await preflightScopes(
      request,
      this.filesystem,
      "filesystem.write",
    );
    const networkEnabled = resolveCapabilityNetwork(request.capabilities);
    throwIfAborted(request.signal);
    return Object.freeze({
      command,
      cwd,
      timeoutSeconds,
      readPaths,
      writePaths,
      networkEnabled,
      policyVersion: this.policy.version,
    });
  }

  async resolve(
    request: ResolveShellCommandRequest,
  ): Promise<ShellCommandSpec> {
    validateRequest(request);
    throwIfAborted(request.signal);
    assertContext(request, this.policy, this.filesystem);
    const preflight = await this.preflight({
      command: request.command,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: request.timeoutSeconds }),
      capabilities: request.grant.capabilities,
      context: request.context,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const spec = Object.freeze({
      ...preflight,
      policyVersion: this.policy.version,
      context: request.context,
      grant: request.grant,
    });
    this.resolved.add(spec);
    return spec;
  }

  async run(
    request: RunShellCommandRequest,
  ): Promise<ShellExecutionResult> {
    if (request === null || typeof request !== "object") {
      throw new ShellInvalidInputError("Shell run request must be an object");
    }
    if (typeof request.onData !== "function") {
      throw new ShellInvalidInputError("Shell onData must be a function");
    }
    if (!this.resolved.delete(request.spec)) {
      throw new ShellPermissionDeniedError(
        "Shell command Spec was not resolved by this Provider or was already consumed",
      );
    }
    throwIfAborted(request.signal);
    assertContext(request.spec, this.policy, this.filesystem);
    assertProcessGrant(request.spec, request.spec.command);
    if (request.spec.policyVersion !== this.policy.version) {
      throw new ShellPolicyMismatchError(
        "Shell command Spec belongs to another policy generation",
      );
    }

    await assertLauncher(this.options.launcherPath);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "wish-shell-"));
    let failure: unknown;
    try {
      const filesystemPolicy = this.filesystem.policy;
      return await spawnShellProcess({
        executable: this.options.launcherPath,
        args: [
          "--workspace",
          request.spec.context.workspace.root,
          ...request.spec.readPaths.flatMap((path) => ["--read-path", path]),
          ...request.spec.writePaths.flatMap((path) => ["--write-path", path]),
          "--network",
          request.spec.networkEnabled ? "enabled" : "disabled",
          ...filesystemPolicy.protectedDirectoryNames.flatMap((name) =>
            ["--protect-name", name]
          ),
          ...filesystemPolicy.protectedFileNames.flatMap((name) =>
            ["--protect-name", name]
          ),
          ...filesystemPolicy.protectedFilePrefixes.flatMap((prefix) =>
            ["--protect-prefix", prefix]
          ),
          ...filesystemPolicy.protectedNameExceptions.flatMap((name) =>
            ["--allow-protected-name", name]
          ),
          "--cwd",
          request.spec.cwd,
          "--tmp",
          temporaryDirectory,
          "--cpu-seconds",
          `${Math.ceil(request.spec.timeoutSeconds) + 1}`,
          "--max-processes",
          `${this.policy.resourceLimits.maxProcesses}`,
          "--max-open-files",
          `${this.policy.resourceLimits.maxOpenFiles}`,
          "--max-file-size-bytes",
          `${this.policy.resourceLimits.maxFileSizeBytes}`,
          "--max-memory-bytes",
          `${this.policy.resourceLimits.maxMemoryBytes}`,
          "--",
          "/bin/sh",
          "-lc",
          request.spec.command,
        ],
        cwd: request.spec.context.workspace.root,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
        timeoutSeconds: request.spec.timeoutSeconds,
        onData: request.onData,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      failure = error;
      throw error;
    } finally {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true });
      } catch (cleanupError: unknown) {
        if (failure === undefined) {
          throw new ShellExecutionFailedError(
            `Failed to clean Shell temporary directory: ${errorMessage(cleanupError)}`,
            { cause: cleanupError },
          );
        }
      }
    }
  }
}

/** Cordis Provider for Landlock + seccomp constrained command execution. */
export class LinuxNativeShell extends ShellService {
  static readonly inject = ["filesystem"];
  static readonly Config = Config;

  readonly policy: ShellPolicy;
  private readonly backend: LinuxNativeShellBackend;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backend = new LinuxNativeShellBackend(ctx.filesystem, config);
    this.policy = this.backend.policy;
    this.work = new PluginWorkOwner(ctx, { code: "shell_native", codeReload: true });
  }

  preflight(
    request: PreflightShellCommandRequest,
  ): Promise<ShellCommandPreflight> {
    return this.work.run(() => this.backend.preflight(request));
  }

  resolve(request: ResolveShellCommandRequest): Promise<ShellCommandSpec> {
    return this.work.run(() => this.backend.resolve(request));
  }

  run(request: RunShellCommandRequest): Promise<ShellExecutionResult> {
    return this.work.run(() => this.backend.run(request));
  }
}

function resolveOptions(options: LinuxNativeShellOptions): ResolvedOptions {
  const maxTimeoutSeconds = positiveNumber(
    options.maxTimeoutSeconds ?? DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
    "Shell maxTimeoutSeconds",
  );
  const defaultTimeoutSeconds = positiveNumber(
    options.defaultTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_SECONDS,
    "Shell defaultTimeoutSeconds",
  );
  if (defaultTimeoutSeconds > maxTimeoutSeconds) {
    throw new ShellInvalidInputError(
      "Shell defaultTimeoutSeconds must not exceed maxTimeoutSeconds",
    );
  }
  return Object.freeze({
    launcherPath: resolve(options.launcherPath ?? fileURLToPath(
      new URL("../../../native/bin/wish-linux-sandbox", import.meta.url),
    )),
    defaultTimeoutSeconds,
    limits: Object.freeze({
      maxProcesses: positiveInteger(
        options.maxProcesses ?? DEFAULT_SHELL_MAX_PROCESSES,
        "Shell maxProcesses",
      ),
      maxOpenFiles: positiveInteger(
        options.maxOpenFiles ?? DEFAULT_SHELL_MAX_OPEN_FILES,
        "Shell maxOpenFiles",
      ),
      maxFileSizeBytes: positiveInteger(
        options.maxFileSizeBytes ?? DEFAULT_SHELL_MAX_FILE_SIZE_BYTES,
        "Shell maxFileSizeBytes",
      ),
      maxMemoryBytes: positiveInteger(
        options.maxMemoryBytes ?? DEFAULT_SHELL_MAX_MEMORY_BYTES,
        "Shell maxMemoryBytes",
      ),
      maxTimeoutSeconds,
    }),
  });
}

function createPolicy(
  filesystem: Filesystem,
  resourceLimits: ShellResourceLimits,
): ShellPolicy {
  const values = {
    schemaVersion: 1 as const,
    backend: "linux-native" as const,
    filesystem: "path-scoped" as const,
    network: "per-call" as const,
    environment: "clean" as const,
    automaticPermissionProfiles: ["workspace-write" as const],
    resourceLimits,
    filesystemPolicyVersion: filesystem.policy.version,
  };
  return Object.freeze({
    ...values,
    version: identity(values),
    automaticPermissionProfiles: Object.freeze(
      values.automaticPermissionProfiles,
    ),
  });
}

async function preflightScopes(
  request: PreflightShellCommandRequest,
  filesystem: Filesystem,
  capability: "filesystem.read" | "filesystem.write",
): Promise<readonly string[]> {
  const paths = [...new Set(request.capabilities.requirements.flatMap(
    (requirement) => requirement.capability === capability
      ? [...requirement.paths]
      : [],
  ))];
  if (paths.length > MAX_SHELL_SCOPED_PATHS) {
    throw new ShellInvalidInputError(
      `${capability} exceeds ${MAX_SHELL_SCOPED_PATHS} path scopes`,
    );
  }
  const resolvedPaths: string[] = [];
  for (const path of paths) {
    if (isAbsolute(path)) {
      throw new ShellPermissionDeniedError(
        `Shell ${capability} scopes must be Workspace-relative: ${path}`,
      );
    }
    try {
      const resolvedPath = await filesystem.preflight({
        path,
        access: capability === "filesystem.read" ? "read" : "write",
        allowWorkspaceRoot: true,
        context: request.context,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      resolvedPaths.push(resolvedPath.relativePath || ".");
    } catch (cause: unknown) {
      throw new ShellPermissionDeniedError(
        `Shell cannot enforce ${capability} scope ${JSON.stringify(path)}: ${errorMessage(cause)}`,
        { cause },
      );
    }
  }
  return Object.freeze(resolvedPaths);
}

function resolveCapabilityNetwork(
  capabilities: PreflightShellCommandRequest["capabilities"],
): boolean {
  const network = capabilities.requirements.filter(
    (requirement) => requirement.capability === "network.connect",
  );
  if (network.length === 0) return false;
  if (network.some((requirement) =>
    requirement.capability === "network.connect" &&
    (requirement.hosts.length !== 1 || requirement.hosts[0] !== "*")
  )) {
    throw new ShellPermissionDeniedError(
      "Linux Native Shell can enforce network only as all-or-none",
    );
  }
  return true;
}

function assertContext(
  request: Pick<ResolveShellCommandRequest, "context" | "grant">,
  policy: ShellPolicy,
  filesystem: Filesystem,
): void {
  const { context } = request;
  assertExecutionContext(context, policy, filesystem);
  try {
    assertActiveCapabilityAuthorizationGrant(request.grant, {
      policyVersion: context.permissions.policyVersion,
      authorityVersion: context.permissions.authorityVersion,
    });
  } catch (cause: unknown) {
    throw new ShellPermissionDeniedError(errorMessage(cause), { cause });
  }
}

function assertExecutionContext(
  context: PreflightShellCommandRequest["context"],
  policy: ShellPolicy,
  filesystem: Filesystem,
): void {
  if (
    context.permissions.workspace.fingerprint !== context.workspace.fingerprint ||
    context.permissions.workspace.revision !== context.workspace.revision
  ) {
    throw new ShellPolicyMismatchError(
      "Permission Snapshot belongs to another Workspace Snapshot",
    );
  }
  if (context.permissions.shellPolicyVersion !== policy.version) {
    throw new ShellPolicyMismatchError(
      "Permission Snapshot belongs to another Shell policy generation",
    );
  }
  if (
    context.permissions.filesystemPolicyVersion !== filesystem.policy.version ||
    policy.filesystemPolicyVersion !== filesystem.policy.version
  ) {
    throw new ShellPolicyMismatchError(
      "Shell and Permission Snapshots belong to another Filesystem policy generation",
    );
  }
}

function assertProcessGrant(
  request: Pick<ResolveShellCommandRequest, "context" | "grant">,
  command: string,
): void {
  if (!request.context.permissions.ceiling.allowedCapabilities.includes(
    "process.exec",
  )) {
    throw new ShellPermissionDeniedError(
      "Permission ceiling excludes process.exec",
    );
  }
  const capability = requireProcessCapability(
    request.grant.capabilities,
    command,
  );
  void capability;
}

function requireProcessCapability(
  capabilities: PreflightShellCommandRequest["capabilities"],
  command: string,
): Extract<CapabilityRequirement, { readonly capability: "process.exec" }> {
  const permitted = capabilities.requirements.find(
    (requirement) => requirement.capability === "process.exec" &&
      requirement.commands?.includes(command) === true,
  );
  if (permitted === undefined || permitted.capability !== "process.exec") {
    throw new ShellPermissionDeniedError(
      "Shell Grant does not include process.exec for this exact command",
    );
  }
  return permitted;
}

function assertProcessArguments(
  capability: Extract<
    CapabilityRequirement,
    { readonly capability: "process.exec" }
  >,
  request: Pick<PreflightShellCommandRequest, "cwd" | "timeoutSeconds">,
): void {
  if (request.cwd !== undefined && capability.cwd !== request.cwd) {
    throw new ShellPermissionDeniedError(
      "Shell process.exec Grant does not include this cwd",
    );
  }
  if (
    request.timeoutSeconds !== undefined &&
    capability.timeoutSeconds !== request.timeoutSeconds
  ) {
    throw new ShellPermissionDeniedError(
      "Shell process.exec Grant does not include this timeout",
    );
  }
}

async function resolveCwd(
  input: string,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const root = resolve(workspaceRoot);
  const requested = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isInside(root, requested)) {
    throw new ShellPermissionDeniedError(`Shell cwd is outside Workspace: ${input}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(requested);
    const information = await stat(canonical);
    if (!information.isDirectory()) {
      throw new ShellInvalidInputError(`Shell cwd is not a directory: ${input}`);
    }
  } catch (cause: unknown) {
    if (cause instanceof ShellInvalidInputError) throw cause;
    throw new ShellInvalidInputError(
      `Shell cwd is unavailable: ${input}: ${errorMessage(cause)}`,
    );
  }
  throwIfAborted(signal);
  if (canonical !== requested || !isInside(root, canonical)) {
    throw new ShellPermissionDeniedError(
      `Symbolic links and Workspace escapes are not allowed in Shell cwd: ${input}`,
    );
  }
  return canonical;
}

function assertCapabilitiesWithinCeiling(
  context: PreflightShellCommandRequest["context"],
  capabilities: PreflightShellCommandRequest["capabilities"],
): void {
  const ceiling = new Set(context.permissions.ceiling.allowedCapabilities);
  const denied = capabilities.requirements.find(
    (requirement) => !ceiling.has(requirement.capability),
  );
  if (denied !== undefined) {
    throw new ShellPermissionDeniedError(
      `Permission ceiling excludes ${denied.capability}`,
    );
  }
}

function validateRequest(request: ResolveShellCommandRequest): void {
  if (request === null || typeof request !== "object") {
    throw new ShellInvalidInputError("Shell resolve request must be an object");
  }
  if (request.context === null || typeof request.context !== "object") {
    throw new ShellInvalidInputError("Shell request requires an execution context");
  }
  assertCapabilitiesWithinCeiling(
    request.context,
    request.grant.capabilities,
  );
}

function validatePreflightRequest(request: PreflightShellCommandRequest): void {
  if (request === null || typeof request !== "object") {
    throw new ShellInvalidInputError("Shell preflight request must be an object");
  }
  if (request.context === null || typeof request.context !== "object") {
    throw new ShellInvalidInputError(
      "Shell preflight request requires an execution context",
    );
  }
  if (request.capabilities === null || typeof request.capabilities !== "object") {
    throw new ShellInvalidInputError(
      "Shell preflight request requires capabilities",
    );
  }
}

function requireCommand(command: string): string {
  if (
    typeof command !== "string" || command.trim().length === 0 ||
    command.includes("\0")
  ) {
    throw new ShellInvalidInputError(
      "Shell command must be a non-empty string without null bytes",
    );
  }
  return command;
}

function resolveTimeout(
  input: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const value = input ?? defaultValue;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ShellInvalidInputError(
      "Shell timeoutSeconds must be a positive finite number",
    );
  }
  if (value > maximum) {
    throw new ShellInvalidInputError(
      `Shell timeoutSeconds must not exceed ${maximum}`,
    );
  }
  return value;
}

async function assertLauncher(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch (cause: unknown) {
    throw new ShellUnavailableError(
      `Linux Native Shell launcher is not executable: ${path}`,
      { cause },
    );
  }
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child.length === 0 || (
    child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ShellInvalidInputError(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ShellInvalidInputError(`${label} must be a positive finite number`);
  }
  return value;
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Shell operation was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default LinuxNativeShell;
