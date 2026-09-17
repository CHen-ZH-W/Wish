import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ToolAuthorizationDecision,
  ToolAuthorizationInput,
  ToolAuthorizationValidation,
} from "../core/tools/authorization.js";
import type {
  PermissionAuthority,
  PermissionExecutionContext,
  PermissionPolicyContribution,
  PermissionPolicyDecision,
  PermissionPolicyProjectionInput,
  PermissionPolicyRegistration,
  PermissionPolicySnapshot,
  PermissionSnapshot,
  ResolvePermissionRequest,
} from "./types.js";

/** Service Definition implemented by replaceable permission-policy providers. */
export abstract class PermissionsService extends Service
  implements PermissionAuthority {
  private readonly policyContributions = new Map<
    string,
    PermissionPolicyContribution
  >();
  private currentPolicySetVersion = 0;

  constructor(ctx: Context) {
    super(ctx, "permissions");
  }

  abstract resolve(
    request: ResolvePermissionRequest,
  ): Promise<PermissionSnapshot> | PermissionSnapshot;

  abstract authorize(
    input: ToolAuthorizationInput<PermissionExecutionContext>,
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;

  abstract revalidate(
    input: ToolAuthorizationInput<PermissionExecutionContext> & {
      readonly decision: Extract<
        ToolAuthorizationDecision,
        { readonly status: "allowed" }
      >;
    },
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationValidation> | ToolAuthorizationValidation;

  /** Register one monotonic hard-policy contribution for the caller's Fiber. */
  registerPolicy(
    contribution: PermissionPolicyContribution,
  ): PermissionPolicyRegistration {
    const id = requireIdentifier(contribution?.id, "Permission policy id");
    if (
      typeof contribution.project !== "function" ||
      typeof contribution.authorize !== "function"
    ) {
      throw new TypeError(
        `Permission policy ${JSON.stringify(id)} must implement project() and authorize()`,
      );
    }
    if (this.policyContributions.has(id)) {
      throw new Error(`Permission policy ${JSON.stringify(id)} is already registered`);
    }
    this.policyContributions.set(id, contribution);
    this.currentPolicySetVersion += 1;
    let active = true;
    const registration: PermissionPolicyRegistration = Object.freeze({
      id,
      unregister: (): boolean => {
        if (!active) return false;
        active = false;
        if (this.policyContributions.get(id) !== contribution) return false;
        this.policyContributions.delete(id);
        this.currentPolicySetVersion += 1;
        return true;
      },
    });
    try {
      this.ctx.effect(
        () => () => registration.unregister(),
        `permissions.registerPolicy(${JSON.stringify(id)})`,
      );
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }

  protected get policySetVersion(): number {
    return this.currentPolicySetVersion;
  }

  protected projectPolicies(
    input: PermissionPolicyProjectionInput,
    signal?: AbortSignal,
  ):
    | Promise<readonly PermissionPolicySnapshot[]>
    | readonly PermissionPolicySnapshot[] {
    const policies = [...this.policyContributions.values()];
    const projected = policies.map((policy) =>
      policy.project(input, signal)
    );
    if (projected.some(isPromiseLike)) {
      return Promise.all(projected).then((snapshots) =>
        snapshotPolicySet(policies, snapshots)
      );
    }
    return snapshotPolicySet(
      policies,
      projected as PermissionPolicySnapshot[],
    );
  }

  /** Fail closed when the contribution set changed or any current policy denies. */
  protected async policyDenial(
    input: ToolAuthorizationInput<PermissionExecutionContext>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (
      (input.context.permissions.policySetVersion ?? 0) !==
        this.currentPolicySetVersion
    ) {
      return "Tool permission policy contributions changed before dispatch";
    }
    const snapshots = input.context.permissions.policies ?? [];
    if (snapshots.length !== this.policyContributions.size) {
      return "Tool Permission Snapshot has an incomplete policy projection";
    }
    for (const snapshot of snapshots) {
      throwIfAborted(signal);
      const policy = this.policyContributions.get(snapshot.id);
      if (policy === undefined) {
        return `Permission policy ${JSON.stringify(snapshot.id)} is unavailable`;
      }
      let decision: PermissionPolicyDecision;
      try {
        decision = await policy.authorize(input, snapshot, signal);
      } catch (error: unknown) {
        return `Permission policy ${JSON.stringify(snapshot.id)} failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      if (decision?.status === "denied") {
        return requireText(decision.reason, "Permission policy denial reason");
      }
      if (decision?.status !== "allowed") {
        return `Permission policy ${JSON.stringify(snapshot.id)} returned an invalid decision`;
      }
    }
    return undefined;
  }
}

function snapshotPolicySet(
  policies: readonly PermissionPolicyContribution[],
  snapshots: readonly PermissionPolicySnapshot[],
): readonly PermissionPolicySnapshot[] {
  if (snapshots.length !== policies.length) {
    throw new Error("Permission policy projection count changed unexpectedly");
  }
  return Object.freeze(snapshots.map((snapshot, index) => {
    const policy = policies[index]!;
    if (snapshot === null || typeof snapshot !== "object") {
      throw new TypeError(`Permission policy ${JSON.stringify(policy.id)} returned no snapshot`);
    }
    if (snapshot.id !== policy.id) {
      throw new TypeError(
        `Permission policy ${JSON.stringify(policy.id)} returned snapshot id ${JSON.stringify(snapshot.id)}`,
      );
    }
    return Object.freeze({
      id: requireIdentifier(snapshot.id, "Permission policy snapshot id"),
      revision: requireIdentifier(
        snapshot.revision,
        `Permission policy ${JSON.stringify(policy.id)} revision`,
      ),
      ...(snapshot.availableTools === undefined
        ? {}
        : { availableTools: identifiers(snapshot.availableTools, "Permission policy Tool") }),
      ...(snapshot.allowedCapabilities === undefined
        ? {}
        : { allowedCapabilities: Object.freeze([...snapshot.allowedCapabilities]) }),
      ...(snapshot.delegation === undefined ? {} : { delegation: Object.freeze({
        availableTools: identifiers(snapshot.delegation.availableTools, "Delegation Tool"),
        allowedCapabilities: Object.freeze([...snapshot.delegation.allowedCapabilities]),
      }) }),
      ...(snapshot.metadata === undefined
        ? {}
        : { metadata: freezePlainRecord(snapshot.metadata) }),
    });
  }));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function";
}

function identifiers(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label}s must be an array`);
  const result = values.map((value) => requireIdentifier(value, label));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label}s must not contain duplicates`);
  }
  return Object.freeze(result);
}

function freezePlainRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Permission policy metadata must be an object");
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(
    ([key, item]) => [key, freezePlainValue(item)],
  )));
}

function freezePlainValue(value: unknown): unknown {
  if (
    value === null || value === undefined || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean"
  ) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezePlainValue));
  return freezePlainRecord(value as Readonly<Record<string, unknown>>);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    permissions: PermissionsService;
  }
}

export default PermissionsService;
