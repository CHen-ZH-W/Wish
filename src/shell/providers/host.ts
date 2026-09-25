import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

import {
  assertActiveCapabilityAuthorizationGrant,
  type CapabilityRequirement,
} from "../../permissions/authorization.js";
import type { Filesystem } from "../../filesystem/types.js";
import {
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
} from "../types.js";
import {
  DEFAULT_SHELL_MAX_FILE_SIZE_BYTES,
  DEFAULT_SHELL_MAX_MEMORY_BYTES,
  DEFAULT_SHELL_MAX_OPEN_FILES,
  DEFAULT_SHELL_MAX_PROCESSES,
  DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
  DEFAULT_SHELL_TIMEOUT_SECONDS,
} from "./linux-native.js";
import { spawnShellProcess } from "./process.js";

export interface HostShellOptions {
  readonly enabled?: boolean;
  readonly shellPath?: string;
  readonly defaultTimeoutSeconds?: number;
  readonly maxTimeoutSeconds?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface Config extends Omit<HostShellOptions, "env"> {}

export const Config: s<Config> = s.object({
  enabled: s.boolean(),
  shellPath: s.string(),
  defaultTimeoutSeconds: s.number().min(0),
  maxTimeoutSeconds: s.number().min(0),
});

/** Explicit development escape hatch. This backend does not isolate processes. */
export class HostShellBackend implements Shell {
  readonly policy: ShellPolicy;
  private readonly enabled: boolean;
  private readonly shellPath: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolved = new WeakSet<ShellCommandSpec>();

  constructor(
    filesystem: Filesystem,
    options: HostShellOptions = {},
  ) {
    this.enabled = options.enabled === true;
    this.shellPath = options.shellPath ?? defaultShellPath();
    this.maxTimeoutSeconds = positiveNumber(
      options.maxTimeoutSeconds ?? DEFAULT_SHELL_MAX_TIMEOUT_SECONDS,
      "Host Shell maxTimeoutSeconds",
    );
    this.defaultTimeoutSeconds = positiveNumber(
      options.defaultTimeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_SECONDS,
      "Host Shell defaultTimeoutSeconds",
    );
    if (this.defaultTimeoutSeconds > this.maxTimeoutSeconds) {
      throw new ShellInvalidInputError(
        "Host Shell defaultTimeoutSeconds must not exceed maxTimeoutSeconds",
      );
    }
    this.env = options.env ?? process.env;
    const values = {
      schemaVersion: 1 as const,
      backend: "host" as const,
      filesystem: "none" as const,
      network: "none" as const,
      environment: "inherit" as const,
      automaticPermissionProfiles: this.enabled
        ? ["full-access" as const]
        : [],
      resourceLimits: {
        maxProcesses: DEFAULT_SHELL_MAX_PROCESSES,
        maxOpenFiles: DEFAULT_SHELL_MAX_OPEN_FILES,
        maxFileSizeBytes: DEFAULT_SHELL_MAX_FILE_SIZE_BYTES,
        maxMemoryBytes: DEFAULT_SHELL_MAX_MEMORY_BYTES,
        maxTimeoutSeconds: this.maxTimeoutSeconds,
      },
      filesystemPolicyVersion: filesystem.policy.version,
    };
    this.policy = Object.freeze({
      ...values,
      version: identity(values),
      automaticPermissionProfiles: Object.freeze(
        values.automaticPermissionProfiles,
      ),
      resourceLimits: Object.freeze(values.resourceLimits),
    });
  }

  async preflight(
    request: PreflightShellCommandRequest,
  ): Promise<ShellCommandPreflight> {
    if (!this.enabled) {
      throw new ShellUnavailableError(
        "Host Shell is disabled; set enabled=true only for an explicit full-access graph",
      );
    }
    validateExecutionContext(request.context, this.policy);
    if (request.context.permissions.profile !== "full-access") {
      throw new ShellPermissionDeniedError(
        "Host Shell requires the explicit full-access Permission profile",
      );
    }
    const command = requireCommand(request.command);
    const processCapability = requireProcessCapability(
      request.capabilities,
      command,
    );
    assertProcessArguments(processCapability, request);
    const readPaths = capabilityPaths(request.capabilities, "filesystem.read");
    const writePaths = capabilityPaths(request.capabilities, "filesystem.write");
    const networkEnabled = networkCapability(request.capabilities);
    const cwd = await resolveCwd(
      request.cwd ?? processCapability.cwd ?? request.context.workspace.root,
      request.context.workspace.root,
      request.signal,
    );
    return Object.freeze({
      command,
      cwd,
      timeoutSeconds: resolveTimeout(
        request.timeoutSeconds ?? processCapability.timeoutSeconds,
        this.defaultTimeoutSeconds,
        this.maxTimeoutSeconds,
      ),
      readPaths,
      writePaths,
      networkEnabled,
      policyVersion: this.policy.version,
    });
  }

  async resolve(
    request: ResolveShellCommandRequest,
  ): Promise<ShellCommandSpec> {
    if (!this.enabled) {
      throw new ShellUnavailableError(
        "Host Shell is disabled; set enabled=true only for an explicit full-access graph",
      );
    }
    validateAuthority(request, this.policy);
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

  async run(request: RunShellCommandRequest): Promise<ShellExecutionResult> {
    if (!this.resolved.delete(request.spec)) {
      throw new ShellPermissionDeniedError(
        "Host Shell command Spec was not resolved here or was already consumed",
      );
    }
    validateAuthority(request.spec, this.policy);
    if (request.spec.policyVersion !== this.policy.version) {
      throw new ShellPolicyMismatchError(
        "Host Shell command Spec belongs to another policy generation",
      );
    }
    return await spawnShellProcess({
      executable: this.shellPath,
      args: ["-c", request.spec.command],
      cwd: request.spec.cwd,
      env: this.env,
      timeoutSeconds: request.spec.timeoutSeconds,
      onData: request.onData,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }
}

export class HostShell extends ShellService {
  static readonly inject = ["filesystem"];
  static readonly Config = Config;

  readonly policy: ShellPolicy;
  private readonly backend: HostShellBackend;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backend = new HostShellBackend(ctx.filesystem, config);
    this.policy = this.backend.policy;
    this.work = new PluginWorkOwner(ctx, { code: "shell_host", codeReload: true });
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

function validateAuthority(
  request: Pick<ResolveShellCommandRequest, "context" | "grant">,
  policy: ShellPolicy,
): void {
  validateExecutionContext(request.context, policy);
  try {
    assertActiveCapabilityAuthorizationGrant(request.grant, {
      policyVersion: request.context.permissions.policyVersion,
      authorityVersion: request.context.permissions.authorityVersion,
    });
  } catch (cause: unknown) {
    throw new ShellPermissionDeniedError(errorMessage(cause), { cause });
  }
}

function validateExecutionContext(
  context: ResolveShellCommandRequest["context"],
  policy: ShellPolicy,
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
      "Permission Snapshot belongs to another Host Shell generation",
    );
  }
  if (context.permissions.filesystemPolicyVersion !== policy.filesystemPolicyVersion) {
    throw new ShellPolicyMismatchError(
      "Host Shell and Permission Snapshot belong to another Filesystem policy generation",
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
    throw new ShellPermissionDeniedError(`Host Shell cwd is outside Workspace: ${input}`);
  }
  try {
    const canonical = await realpath(requested);
    const information = await stat(canonical);
    if (!information.isDirectory()) {
      throw new ShellInvalidInputError(`Host Shell cwd is not a directory: ${input}`);
    }
    throwIfAborted(signal);
    return canonical;
  } catch (cause: unknown) {
    if (cause instanceof ShellInvalidInputError) throw cause;
    throw new ShellInvalidInputError(
      `Host Shell cwd is unavailable: ${input}: ${errorMessage(cause)}`,
    );
  }
}

function capabilityPaths(
  capabilities: PreflightShellCommandRequest["capabilities"],
  capability: "filesystem.read" | "filesystem.write",
): readonly string[] {
  return Object.freeze([...new Set(capabilities.requirements.flatMap(
    (requirement) => requirement.capability === capability
      ? [...requirement.paths]
      : [],
  ))]);
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
      "Host Shell capabilities do not include process.exec for this exact command",
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
      "Host Shell process.exec capability does not include this cwd",
    );
  }
  if (
    request.timeoutSeconds !== undefined &&
    capability.timeoutSeconds !== request.timeoutSeconds
  ) {
    throw new ShellPermissionDeniedError(
      "Host Shell process.exec capability does not include this timeout",
    );
  }
}

function networkCapability(
  capabilities: PreflightShellCommandRequest["capabilities"],
): boolean {
  const requirements = capabilities.requirements.filter(
    (requirement) => requirement.capability === "network.connect",
  );
  if (requirements.length === 0) return false;
  if (requirements.some((requirement) =>
    requirement.capability === "network.connect" &&
    (requirement.hosts.length !== 1 || requirement.hosts[0] !== "*")
  )) {
    throw new ShellPermissionDeniedError(
      "Host Shell can execute network access only as explicit full access",
    );
  }
  return true;
}

function requireCommand(command: string): string {
  if (
    typeof command !== "string" || command.trim().length === 0 ||
    command.includes("\0")
  ) {
    throw new ShellInvalidInputError(
      "Host Shell command must be a non-empty string without null bytes",
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
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new ShellInvalidInputError(
      `Host Shell timeoutSeconds must be positive and at most ${maximum}`,
    );
  }
  return value;
}

function defaultShellPath(): string {
  if (process.platform === "win32") return "bash.exe";
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child.length === 0 || (
    child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
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
  throw new Error("Host Shell operation was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default HostShell;
