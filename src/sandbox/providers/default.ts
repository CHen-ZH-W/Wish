import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";

import { capabilityRequestDigest } from
  "../../permissions/authorization.js";
import type { Filesystem } from "../../filesystem/types.js";
import type { Shell } from "../../shell/types.js";
import { SandboxPolicyService } from "../service.js";
import type {
  EffectiveSandboxCallPolicy,
  SandboxAuthorizationInput,
  SandboxPolicy,
  SandboxPolicyDescriptor,
  SandboxPreflightResult,
} from "../types.js";

/** Reusable policy engine over one fixed Filesystem and Shell generation. */
export class DefaultSandboxPolicyBackend implements SandboxPolicy {
  readonly policy: SandboxPolicyDescriptor;
  private readonly issued = new WeakSet<EffectiveSandboxCallPolicy>();

  constructor(
    private readonly filesystem: Filesystem,
    private readonly shell: Shell,
  ) {
    const values = {
      schemaVersion: 1 as const,
      filesystemPolicyVersion: filesystem.policy.version,
      shellPolicyVersion: shell.policy.version,
      shellBackend: shell.policy.backend,
      filesystem: "workspace-path-scoped" as const,
      network: shell.policy.network === "per-call"
        ? "all-or-none" as const
        : "none" as const,
      web: "grant-scoped-provider" as const,
    };
    this.policy = Object.freeze({
      ...values,
      version: identity(values),
    });
  }

  async preflight(
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> {
    try {
      throwIfAborted(signal);
      validateContext(input, this.policy);
      const processCommands = commands(input);
      const hasNetwork = input.capabilities.requirements.some(
        (requirement) => requirement.capability === "network.connect",
      );
      if (hasNetwork && processCommands.length === 0) {
        return denied(
          "The active Sandbox can enforce network authority only through process.exec",
        );
      }
      const webSearchProviders = input.capabilities.requirements.flatMap(
        (requirement) => requirement.capability === "web.search"
          ? requirement.providers
          : [],
      );
      const webFetchOrigins = input.capabilities.requirements.flatMap(
        (requirement) => requirement.capability === "web.fetch"
          ? requirement.origins
          : [],
      );
      const webFetchProviders = input.capabilities.requirements.flatMap(
        (requirement) => requirement.capability === "web.fetch"
          ? requirement.providers
          : [],
      );
      if (
        (webSearchProviders.length > 0 || webFetchOrigins.length > 0) &&
        input.capabilities.effects?.openWorld !== true
      ) {
        return denied("Web capabilities must declare the openWorld effect");
      }

      const commandPolicies = [];
      if (processCommands.length > 0) {
        for (const process of processCommands) {
          commandPolicies.push(await this.shell.preflight({
            command: process.command,
            ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
            ...(process.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: process.timeoutSeconds }),
            capabilities: input.capabilities,
            context: input.context,
            ...(signal === undefined ? {} : { signal }),
          }));
        }
      }

      const readPaths: string[] = [];
      const writePaths: string[] = [];
      if (processCommands.length === 0) {
        for (const requirement of input.capabilities.requirements) {
          if (
            requirement.capability !== "filesystem.read" &&
            requirement.capability !== "filesystem.write"
          ) continue;
          for (const path of requirement.paths) {
            const resolved = await this.filesystem.preflight({
              path,
              access: requirement.capability === "filesystem.read"
                ? "read"
                : "write",
              allowMissing: requirement.capability === "filesystem.write",
              allowWorkspaceRoot: true,
              context: input.context,
              ...(signal === undefined ? {} : { signal }),
            });
            const target = resolved.relativePath || ".";
            (requirement.capability === "filesystem.read"
              ? readPaths
              : writePaths).push(target);
          }
        }
      } else {
        for (const command of commandPolicies) {
          readPaths.push(...command.readPaths);
          writePaths.push(...command.writePaths);
        }
      }

      throwIfAborted(signal);
      const effective = Object.freeze({
        schemaVersion: 1 as const,
        policyVersion: this.policy.version,
        capabilityDigest: capabilityRequestDigest(input.capabilities),
        workspace: Object.freeze({
          fingerprint: input.context.workspace.fingerprint,
          revision: input.context.workspace.revision,
        }),
        shellBackend: this.shell.policy.backend,
        readPaths: Object.freeze([...new Set(readPaths)]),
        writePaths: Object.freeze([...new Set(writePaths)]),
        networkEnabled: hasNetwork,
        webSearchProviders: Object.freeze([...new Set(webSearchProviders)]),
        webFetchProviders: Object.freeze([...new Set(webFetchProviders)]),
        webFetchOrigins: Object.freeze([...new Set(webFetchOrigins)]),
        commands: Object.freeze(commandPolicies),
      });
      this.issued.add(effective);
      return Object.freeze({ status: "allowed" as const, effective });
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      return denied(errorMessage(error));
    }
  }

  async revalidate(
    effective: EffectiveSandboxCallPolicy,
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> {
    if (!this.issued.has(effective)) {
      return denied("Sandbox preflight proof was not issued by this Provider");
    }
    const current = await this.preflight(input, signal);
    if (current.status === "denied") return current;
    if (stableEffective(current.effective) !== stableEffective(effective)) {
      return denied("Sandbox enforceability changed while approval was pending");
    }
    return Object.freeze({ status: "allowed" as const, effective });
  }
}

/** Cordis Provider composing the active Filesystem and Shell policies. */
export class DefaultSandboxPolicy extends SandboxPolicyService {
  static readonly inject = ["filesystem", "shell"];

  readonly policy: SandboxPolicyDescriptor;
  private readonly backend: DefaultSandboxPolicyBackend;

  constructor(ctx: Context) {
    super(ctx);
    this.backend = new DefaultSandboxPolicyBackend(ctx.filesystem, ctx.shell);
    this.policy = this.backend.policy;
  }

  preflight(
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> {
    return this.backend.preflight(input, signal);
  }

  revalidate(
    effective: EffectiveSandboxCallPolicy,
    input: SandboxAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<SandboxPreflightResult> {
    return this.backend.revalidate(effective, input, signal);
  }
}

interface ProcessPreflightRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
}

function commands(
  input: SandboxAuthorizationInput,
): readonly ProcessPreflightRequest[] {
  const values = input.capabilities.requirements.flatMap((requirement) =>
    requirement.capability === "process.exec"
      ? (requirement.commands ?? []).map((command) => Object.freeze({
          command,
          ...(requirement.cwd === undefined ? {} : { cwd: requirement.cwd }),
          ...(requirement.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: requirement.timeoutSeconds }),
        }))
      : []
  );
  const hasUnspecified = input.capabilities.requirements.some(
    (requirement) => requirement.capability === "process.exec" &&
      (requirement.commands === undefined || requirement.commands.length === 0),
  );
  if (hasUnspecified) {
    throw new Error(
      "The active Shell Provider requires exact process.exec commands",
    );
  }
  const unique = new Map(values.map((value) => [JSON.stringify(value), value]));
  return Object.freeze([...unique.values()]);
}

function validateContext(
  input: SandboxAuthorizationInput,
  policy: SandboxPolicyDescriptor,
): void {
  const permissions = input.context.permissions;
  if (permissions.sandboxPolicyVersion !== policy.version) {
    throw new Error("Permission Snapshot belongs to another SandboxPolicy generation");
  }
  if (
    permissions.filesystemPolicyVersion !== policy.filesystemPolicyVersion ||
    permissions.shellPolicyVersion !== policy.shellPolicyVersion
  ) {
    throw new Error(
      "SandboxPolicy, Filesystem, and Shell generations do not match",
    );
  }
  if (
    permissions.workspace.fingerprint !== input.context.workspace.fingerprint ||
    permissions.workspace.revision !== input.context.workspace.revision
  ) {
    throw new Error("Permission Snapshot belongs to another Workspace Snapshot");
  }
}

function stableEffective(value: EffectiveSandboxCallPolicy): string {
  return JSON.stringify(value);
}

function denied(reason: string): SandboxPreflightResult {
  return Object.freeze({
    status: "denied" as const,
    reason: `Sandbox preflight denied the call: ${reason}`,
  });
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Sandbox preflight was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default DefaultSandboxPolicy;
