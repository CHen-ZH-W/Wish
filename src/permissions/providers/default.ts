import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { createHash } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  ToolAuthorizationDecision,
  ToolAuthorizationInput,
  ToolAuthorizationValidation,
} from "../../core/tools/authorization.js";
import {
  capabilityRequestDigest,
  type CapabilityKind,
} from "../authorization.js";
import type { RetainedApprovalRuleScope } from
  "../rules/types.js";
import type { EffectiveSandboxCallPolicy } from "../../sandbox/types.js";
import { PermissionProfileUnavailableError } from "../errors.js";
import type { ShellPolicy } from "../../shell/types.js";
import { PermissionsService } from "../service.js";
import {
  PERMISSION_PROFILES,
  TOOL_CAPABILITY_KINDS,
  type PermissionExecutionContext,
  type PermissionProfile,
  type PermissionPolicySnapshot,
  type PermissionSnapshot,
  type PermissionSubject,
  type ResolvePermissionRequest,
} from "../types.js";

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile =
  "approval-required";
export const DEFAULT_PERMISSION_POLICY_VERSION =
  "wish-permissions-default-v1";
export const DEFAULT_MAX_PENDING_AUTHORIZATIONS = 1024;

/** Loader-owned defaults for the built-in policy provider. */
export interface Config {
  readonly defaultProfile?: PermissionProfile;
  readonly policyVersion?: string;
  readonly maxPendingAuthorizations?: number;
}

export const Config: s<Config> = s.object({
  defaultProfile: s.union(PERMISSION_PROFILES.map((profile) => s.const(profile))),
  policyVersion: s.string(),
  maxPendingAuthorizations: s.number().step(1).min(1),
});

interface PendingAuthorization {
  readonly policyVersion: string;
  readonly call: ToolAuthorizationInput<PermissionExecutionContext>["call"];
  readonly descriptor: ToolAuthorizationInput<PermissionExecutionContext>["descriptor"];
  readonly capabilities: ToolAuthorizationInput<PermissionExecutionContext>["capabilities"];
  readonly context: PermissionExecutionContext;
  readonly scope: ToolAuthorizationInput<PermissionExecutionContext>["scope"];
  readonly snapshot: ToolAuthorizationInput<PermissionExecutionContext>["snapshot"];
  readonly sandbox: EffectiveSandboxCallPolicy;
  readonly retain?: RetainedApprovalRuleScope;
}

type PolicyDisposition = "allow" | "ask" | "deny";

/** Default profile policy bound to the active filesystem and Shell enforcers. */
export class DefaultPermissions extends PermissionsService {
  static readonly inject = [
    "approval",
    "approvalRules",
    "filesystem",
    "shell",
    "sandboxPolicy",
  ];
  static readonly Config = Config;

  readonly defaultProfile: PermissionProfile;
  readonly policyVersion: string;
  private readonly maxPendingAuthorizations: number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly validated = new Map<string, PendingAuthorization>();
  private readonly work: PluginWorkOwner;
  private readonly retiring = new AbortController();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.work = new PluginWorkOwner(ctx, { code: "permissions", codeReload: true,
      beforeDrain: () => this.retiring.abort(new Error("permissions_closed")),
      close: () => { this.pending.clear(); this.validated.clear(); } });
    this.defaultProfile = permissionProfile(
      config.defaultProfile ?? DEFAULT_PERMISSION_PROFILE,
    );
    this.policyVersion = requireIdentifier(
      config.policyVersion ?? DEFAULT_PERMISSION_POLICY_VERSION,
      "Permission policy version",
    );
    this.maxPendingAuthorizations = positiveSafeInteger(
      config.maxPendingAuthorizations ?? DEFAULT_MAX_PENDING_AUTHORIZATIONS,
      "Permission maxPendingAuthorizations",
    );
  }

  resolve(
    request: ResolvePermissionRequest,
  ): PermissionSnapshot | Promise<PermissionSnapshot> {
    this.work.assertOpen();
    validateResolveRequest(request);
    throwIfAborted(request.signal);
    const profile = permissionProfile(
      request.agent?.profile ?? this.defaultProfile,
    );
    assertProfileIsEnforceable(profile, this.ctx.shell.policy);
    const registeredTools = uniqueIdentifiers(
      request.registeredTools,
      "Registered Tool",
    );
    const configuredTools = request.agent?.availableTools === undefined
      ? undefined
      : new Set(uniqueIdentifiers(
        request.agent.availableTools,
        "Available Tool",
      ));
    const availableTools = Object.freeze(
      registeredTools.filter((tool) => configuredTools?.has(tool) ?? true),
    );
    const allowedCapabilities = request.agent?.allowedCapabilities === undefined
      ? [...TOOL_CAPABILITY_KINDS]
      : uniqueCapabilities(request.agent.allowedCapabilities);
    const subject = snapshotSubject(request.subject);
    const workspace = Object.freeze({
      fingerprint: requireIdentifier(
        request.workspace.fingerprint,
        "Workspace fingerprint",
      ),
      revision: requireIdentifier(
        request.workspace.revision,
        "Workspace revision",
      ),
    });
    const filesystemPolicyVersion = requireIdentifier(
      this.ctx.filesystem.policy.version,
      "Filesystem policy version",
    );
    const shellPolicyVersion = requireIdentifier(
      this.ctx.shell.policy.version,
      "Shell policy version",
    );
    const sandboxPolicyVersion = requireIdentifier(
      this.ctx.sandboxPolicy.policy.version,
      "SandboxPolicy version",
    );
    const policySetVersion = this.policySetVersion;
    const policies = this.projectPolicies({
      request,
      availableTools,
      allowedCapabilities: Object.freeze([...allowedCapabilities]),
    }, request.signal);
    const finish = (
      projected: readonly PermissionPolicySnapshot[],
    ): PermissionSnapshot => createPermissionSnapshot({
      subject,
      profile,
      availableTools,
      allowedCapabilities,
      workspace,
      filesystemPolicyVersion,
      shellPolicyVersion,
      sandboxPolicyVersion,
      policyVersion: this.policyVersion,
      policySetVersion,
      policies: projected,
    });
    return isPromiseLike(policies) ? this.work.run(() => policies.then(finish)) : finish(policies);
  }

  async authorize(
    input: ToolAuthorizationInput<PermissionExecutionContext>,
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationDecision> {
    signal = AbortSignal.any([this.retiring.signal, ...(signal ? [signal] : [])]);
    return this.work.run(async () => {
      throwIfAborted(signal);
      const invalid = validateAuthorizationInput(
        input,
        this.policyVersion,
        this.ctx.shell.policy.version,
        this.ctx.sandboxPolicy.policy.version,
      );
      if (invalid !== undefined) return denied(invalid);
      const policyDenial = await this.policyDenial(input, signal);
      if (policyDenial !== undefined) return denied(policyDenial);
      const key = authorizationKey(input);
      this.pending.delete(key);
      this.validated.delete(key);
      const disposition = evaluate(input.context.permissions, input);
      if (disposition === "deny") {
        return denied(
          `Permission profile "${input.context.permissions.profile}" does not allow this Tool capability`,
        );
      }
      const preflight = await this.ctx.sandboxPolicy.preflight(input, signal);
      if (preflight.status === "denied") return denied(preflight.reason);

      let metadata: Readonly<Record<string, unknown>> = Object.freeze({
        permissionProfile: input.context.permissions.profile,
        authorizationSource: "profile",
      });
      if (disposition === "ask") {
        let retained: RetainedApprovalRuleScope | undefined;
        let rule;
        try {
          rule = await this.ctx.approvalRules.find(
            approvalRuleRequest(input, this.policyVersion, signal),
          );
        } catch (error: unknown) {
          return denied(`ApprovalRule lookup failed: ${errorMessage(error)}`);
        }
        if (rule !== undefined) {
          metadata = Object.freeze({
            permissionProfile: input.context.permissions.profile,
            authorizationSource: "approval-rule",
            approvalRuleId: rule.id,
            approvalScope: rule.scope,
          });
        } else {
          const response = await awaitApproval(this.ctx.approval.requestApproval(input, signal), signal!);
          throwIfAborted(signal);
          if (response.status === "denied") return denied(response.reason);
          const scope = response.scope ?? "once";
          retained = scope === "once" ? undefined : scope;
          metadata = Object.freeze({
            permissionProfile: input.context.permissions.profile,
            authorizationSource: "approval",
            approvalScope: scope,
            ...(response.metadata === undefined
              ? {}
              : { approval: response.metadata }),
          });
        }

        this.pending.set(key, Object.freeze({
          policyVersion: this.policyVersion,
          call: input.call,
          descriptor: input.descriptor,
          capabilities: input.capabilities,
          context: input.context,
          scope: input.scope,
          snapshot: input.snapshot,
          sandbox: preflight.effective,
          ...(retained === undefined ? {} : { retain: retained }),
        }));
      } else {
        this.pending.set(key, Object.freeze({
          policyVersion: this.policyVersion,
          call: input.call,
          descriptor: input.descriptor,
          capabilities: input.capabilities,
          context: input.context,
          scope: input.scope,
          snapshot: input.snapshot,
          sandbox: preflight.effective,
        }));
      }
      this.prunePending();
      return Object.freeze({
        status: "allowed" as const,
        policyVersion: this.policyVersion,
        metadata,
      });
    });
  }

  async revalidate(
    input: ToolAuthorizationInput<PermissionExecutionContext> & {
      readonly decision: Extract<
        ToolAuthorizationDecision,
        { readonly status: "allowed" }
      >;
    },
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationValidation> {
    return this.work.run(async () => {
      throwIfAborted(signal);
      const key = authorizationKey(input);
      const pending = this.pending.get(key);
      this.pending.delete(key);
      if (pending === undefined || !sameAuthorizationInput(pending, input)) {
        return denied("Tool permission is missing, stale, or already consumed");
      }
      if (
        pending.policyVersion !== this.policyVersion ||
        input.decision.policyVersion !== this.policyVersion ||
        input.context.permissions.policyVersion !== this.policyVersion
      ) {
        return denied("Tool permission policy changed before dispatch");
      }
      const invalid = validateAuthorizationInput(
        input,
        this.policyVersion,
        this.ctx.shell.policy.version,
        this.ctx.sandboxPolicy.policy.version,
      );
      if (invalid !== undefined) return denied(invalid);
      const policyDenial = await this.policyDenial(input, signal);
      if (policyDenial !== undefined) return denied(policyDenial);
      const sandbox = await this.ctx.sandboxPolicy.revalidate(
        pending.sandbox,
        input,
        signal,
      );
      if (sandbox.status === "denied") return denied(sandbox.reason);
      this.validated.set(key, pending);
      this.prunePending();
      throwIfAborted(signal);
      return Object.freeze({
        status: "valid" as const,
        policyVersion: this.policyVersion,
      });
    });
  }

  async commit(
    input: ToolAuthorizationInput<PermissionExecutionContext> & {
      readonly decision: Extract<
        ToolAuthorizationDecision,
        { readonly status: "allowed" }
      >;
    },
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationValidation> {
    return this.work.run(async () => {
      throwIfAborted(signal);
      const key = authorizationKey(input);
      const validated = this.validated.get(key);
      this.validated.delete(key);
      if (validated === undefined || !sameAuthorizationInput(validated, input)) {
        return denied("Tool permission commit is missing, stale, or already consumed");
      }
      const invalid = validateAuthorizationInput(
        input,
        this.policyVersion,
        this.ctx.shell.policy.version,
        this.ctx.sandboxPolicy.policy.version,
      );
      if (invalid !== undefined) return denied(invalid);
      const policyDenial = await this.policyDenial(input, signal);
      if (policyDenial !== undefined) return denied(policyDenial);
      if (
        validated.policyVersion !== this.policyVersion ||
        input.decision.policyVersion !== this.policyVersion
      ) return denied("Tool permission policy changed before rule commit");
      const sandbox = await this.ctx.sandboxPolicy.revalidate(
        validated.sandbox,
        input,
        signal,
      );
      if (sandbox.status === "denied") return denied(sandbox.reason);
      if (validated.retain !== undefined) {
        try {
          await this.ctx.approvalRules.remember({
            ...approvalRuleRequest(input, this.policyVersion, signal),
            scope: validated.retain,
          });
        } catch (error: unknown) {
          return denied(`ApprovalRule commit failed: ${errorMessage(error)}`);
        }
      }
      throwIfAborted(signal);
      return Object.freeze({
        status: "valid" as const,
        policyVersion: this.policyVersion,
      });
    });
  }

  private prunePending(): void {
    while (
      this.pending.size + this.validated.size > this.maxPendingAuthorizations
    ) {
      const pending = this.pending.keys().next().value as string | undefined;
      if (pending !== undefined) {
        this.pending.delete(pending);
        continue;
      }
      const validated = this.validated.keys().next().value as string | undefined;
      if (validated === undefined) return;
      this.validated.delete(validated);
    }
  }
}

function createPermissionSnapshot(input: {
  readonly subject: PermissionSubject;
  readonly profile: PermissionProfile;
  readonly availableTools: readonly string[];
  readonly allowedCapabilities: readonly CapabilityKind[];
  readonly workspace: PermissionSnapshot["workspace"];
  readonly filesystemPolicyVersion: string;
  readonly shellPolicyVersion: string;
  readonly sandboxPolicyVersion: string;
  readonly policyVersion: string;
  readonly policySetVersion: number;
  readonly policies: readonly PermissionPolicySnapshot[];
}): PermissionSnapshot {
  const availableTools = intersectTools(input.availableTools, input.policies);
  const delegationPolicies = input.policies.map(policy => policy.delegation ? { ...policy, ...policy.delegation } : policy);
  const delegation = Object.freeze({ availableTools: intersectTools(input.availableTools, delegationPolicies),
    allowedCapabilities: intersectCapabilities(input.allowedCapabilities, delegationPolicies) });
  const allowedCapabilities = intersectCapabilities(
    input.allowedCapabilities,
    input.policies,
  );
  const ceiling = Object.freeze({ allowedCapabilities });
  const authorityVersion = identity({
    delegation,
    schemaVersion: 1,
    subject: input.subject,
    profile: input.profile,
    availableTools,
    ceiling,
    workspace: input.workspace,
    filesystemPolicyVersion: input.filesystemPolicyVersion,
    shellPolicyVersion: input.shellPolicyVersion,
    sandboxPolicyVersion: input.sandboxPolicyVersion,
    policyVersion: input.policyVersion,
    policySetVersion: input.policySetVersion,
    policies: input.policies,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    delegation,
    subject: input.subject,
    profile: input.profile,
    availableTools,
    ceiling,
    workspace: input.workspace,
    filesystemPolicyVersion: input.filesystemPolicyVersion,
    shellPolicyVersion: input.shellPolicyVersion,
    sandboxPolicyVersion: input.sandboxPolicyVersion,
    policyVersion: input.policyVersion,
    policySetVersion: input.policySetVersion,
    policies: input.policies,
    authorityVersion,
  });
}

function intersectTools(
  base: readonly string[],
  policies: readonly PermissionPolicySnapshot[],
): readonly string[] {
  let result = [...base];
  const baseSet = new Set(base);
  for (const policy of policies) {
    if (policy.availableTools === undefined) continue;
    if (policy.availableTools.some((name) => !baseSet.has(name))) {
      throw new TypeError(
        `Permission policy ${JSON.stringify(policy.id)} attempted to add a Tool`,
      );
    }
    const allowed = new Set(policy.availableTools);
    result = result.filter((name) => allowed.has(name));
  }
  return Object.freeze(result);
}

function intersectCapabilities(
  base: readonly CapabilityKind[],
  policies: readonly PermissionPolicySnapshot[],
): readonly CapabilityKind[] {
  let result = [...base];
  const baseSet = new Set(base);
  for (const policy of policies) {
    if (policy.allowedCapabilities === undefined) continue;
    if (policy.allowedCapabilities.some((capability) => !baseSet.has(capability))) {
      throw new TypeError(
        `Permission policy ${JSON.stringify(policy.id)} attempted to add a capability`,
      );
    }
    const allowed = new Set(policy.allowedCapabilities);
    result = result.filter((capability) => allowed.has(capability));
  }
  return Object.freeze(result);
}

function isPromiseLike<Value>(
  value: Promise<Value> | Value,
): value is Promise<Value> {
  return value !== null && typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function";
}

function evaluate(
  permissions: PermissionSnapshot,
  input: ToolAuthorizationInput<PermissionExecutionContext>,
): PolicyDisposition {
  const capabilities = input.capabilities.requirements.map((item) =>
    item.capability
  );
  const ceiling = new Set(permissions.ceiling.allowedCapabilities);
  if (capabilities.some((capability) => !ceiling.has(capability))) return "deny";
  const elevatedEffect = input.capabilities.effects?.destructive === true ||
    input.capabilities.effects?.openWorld === true;
  const readOnly = capabilities.every((capability) =>
    capability === "filesystem.read" || capability === "runtime.read"
  );

  if (permissions.profile === "read-only") {
    if (readOnly && !elevatedEffect) return "allow";
    const approvalEligible = capabilities.every((capability) =>
      capability === "filesystem.read" ||
      capability === "process.exec" ||
      capability === "runtime.read"
    );
    return approvalEligible && !elevatedEffect ? "ask" : "deny";
  }
  if (permissions.profile === "approval-required") {
    return readOnly && !elevatedEffect ? "allow" : "ask";
  }
  if (permissions.profile === "workspace-write") {
    const localCapability = capabilities.every((capability) =>
      capability === "filesystem.read" ||
      capability === "filesystem.write" ||
      capability === "process.exec" ||
      capability === "runtime.read"
    );
    return localCapability && !elevatedEffect ? "allow" : "ask";
  }
  return "allow";
}

function validateAuthorizationInput(
  input: ToolAuthorizationInput<PermissionExecutionContext>,
  policyVersion: string,
  shellPolicyVersion: string,
  sandboxPolicyVersion: string,
): string | undefined {
  const permissions = input.context?.permissions;
  if (permissions === undefined || permissions.schemaVersion !== 1) {
    return "Tool execution has no valid Permission Snapshot";
  }
  if (permissions.policyVersion !== policyVersion) {
    return "Tool Permission Snapshot belongs to another policy generation";
  }
  if (permissions.shellPolicyVersion !== shellPolicyVersion) {
    return "Tool Permission Snapshot belongs to another Shell policy generation";
  }
  if (permissions.sandboxPolicyVersion !== sandboxPolicyVersion) {
    return "Tool Permission Snapshot belongs to another SandboxPolicy generation";
  }
  if (permissions.authorityVersion !== input.snapshot.authorityVersion) {
    return "Tool Permission Snapshot does not match the Tool snapshot";
  }
  if (!permissions.availableTools.includes(input.call.name)) {
    return `Tool "${input.call.name}" is not available to this Agent Step`;
  }
  if (
    permissions.subject.runId !== input.scope.runId ||
    permissions.subject.userTurnId !== input.scope.userTurnId ||
    permissions.subject.stepId !== input.scope.stepId
  ) {
    return "Tool Permission Snapshot belongs to another execution scope";
  }
  if (
    permissions.workspace.fingerprint !== input.context.workspace.fingerprint ||
    permissions.workspace.revision !== input.context.workspace.revision
  ) {
    return "Tool Permission Snapshot belongs to another Workspace Snapshot";
  }
  return undefined;
}

function approvalRuleRequest(
  input: ToolAuthorizationInput<PermissionExecutionContext>,
  policyVersion: string,
  signal?: AbortSignal,
) {
  const subject = input.context.permissions.subject;
  return Object.freeze({
    profile: input.context.permissions.profile,
    policyVersion,
    toolName: input.call.name,
    capabilityDigest: capabilityRequestDigest(input.capabilities),
    identity: Object.freeze({
      agentId: subject.agentId,
      sessionId: subject.sessionId,
      runId: subject.runId,
      workspaceFingerprint: input.context.workspace.fingerprint,
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function sameAuthorizationInput(
  pending: PendingAuthorization,
  input: ToolAuthorizationInput<PermissionExecutionContext>,
): boolean {
  return pending.call === input.call &&
    pending.descriptor === input.descriptor &&
    pending.capabilities === input.capabilities &&
    Object.is(pending.context, input.context) &&
    pending.scope === input.scope &&
    pending.snapshot === input.snapshot;
}

function authorizationKey(
  input: ToolAuthorizationInput<PermissionExecutionContext>,
): string {
  return JSON.stringify([
    input.scope.runId,
    input.scope.userTurnId,
    input.scope.stepId,
    input.call.id,
    input.call.name,
    input.snapshot.authorityVersion,
    input.snapshot.registryVersion,
  ]);
}

function validateResolveRequest(request: ResolvePermissionRequest): void {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Permission resolve request must be an object");
  }
  if (request.workspace === null || typeof request.workspace !== "object") {
    throw new TypeError("Permission resolve request requires a Workspace Snapshot");
  }
  if (
    request.agent !== undefined &&
    (request.agent === null || typeof request.agent !== "object" ||
      Array.isArray(request.agent))
  ) throw new TypeError("Permission Agent configuration must be an object");
  if (!Array.isArray(request.registeredTools)) {
    throw new TypeError("Permission registeredTools must be an array");
  }
}

function snapshotSubject(subject: PermissionSubject): PermissionSubject {
  if (subject === null || typeof subject !== "object") {
    throw new TypeError("Permission subject must be an object");
  }
  return Object.freeze({
    agentId: requireIdentifier(subject.agentId, "Permission Agent id"),
    sessionId: requireIdentifier(subject.sessionId, "Permission Session id"),
    runId: requireIdentifier(subject.runId, "Permission Run id"),
    userTurnId: requireIdentifier(subject.userTurnId, "Permission UserTurn id"),
    stepId: requireIdentifier(subject.stepId, "Permission Step id"),
  });
}

function uniqueIdentifiers(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} values must be an array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = requireIdentifier(value, label);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueCapabilities(
  values: readonly CapabilityKind[],
): CapabilityKind[] {
  if (!Array.isArray(values)) {
    throw new TypeError("Allowed capabilities must be an array");
  }
  const allowed = new Set<CapabilityKind>(TOOL_CAPABILITY_KINDS);
  const result: CapabilityKind[] = [];
  const seen = new Set<CapabilityKind>();
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new TypeError(`Unknown Tool capability ${JSON.stringify(value)}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function permissionProfile(value: PermissionProfile): PermissionProfile {
  if (!(PERMISSION_PROFILES as readonly string[]).includes(value)) {
    throw new TypeError(`Unknown Permission profile ${JSON.stringify(value)}`);
  }
  return value;
}

function assertProfileIsEnforceable(
  profile: PermissionProfile,
  shell: ShellPolicy,
): void {
  if (
    (profile === "workspace-write" || profile === "full-access") &&
    !shell.automaticPermissionProfiles.includes(profile)
  ) {
    throw new PermissionProfileUnavailableError(
      profile,
      `Shell backend ${shell.backend} cannot enforce automatic ${profile} execution`,
    );
  }
}

function identity(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function denied(reason: string): Extract<
  ToolAuthorizationDecision,
  { readonly status: "denied" }
> {
  return Object.freeze({ status: "denied" as const, reason });
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Permission operation was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default DefaultPermissions;

/** A UI transport may ignore abort, but its late answer can never authorize work. */
function awaitApproval<T>(answer: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve(answer).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
