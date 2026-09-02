import type {
  ReadyToolCall,
  ToolDescriptor,
  ToolExecutionScope,
  ToolExecutionSnapshot,
} from "./tool.js";

export type ToolCapabilityKind =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.connect"
  | "external.side_effect"
  | "runtime.read"
  | "runtime.control";

export type ToolCapabilityRequirement =
  | {
      readonly capability: "filesystem.read" | "filesystem.write";
      readonly paths: readonly string[];
    }
  | {
      readonly capability: "process.exec";
      readonly commands?: readonly string[];
    }
  | {
      readonly capability: "network.connect";
      readonly hosts: readonly string[];
    }
  | {
      readonly capability:
        | "external.side_effect"
        | "runtime.read"
        | "runtime.control";
      readonly resources: readonly string[];
    };

export interface ToolCapabilityRequest {
  readonly requirements: readonly ToolCapabilityRequirement[];
  readonly effects?: {
    readonly destructive?: boolean;
    readonly openWorld?: boolean;
  };
}

export interface ToolAuthorizationInput<Context = unknown> {
  readonly call: ReadyToolCall;
  readonly descriptor: ToolDescriptor;
  readonly capabilities: ToolCapabilityRequest;
  readonly context: Context;
  readonly scope: ToolExecutionScope;
  readonly snapshot: ToolExecutionSnapshot;
}

export type ToolAuthorizationDecision =
  | {
      readonly status: "allowed";
      readonly policyVersion: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

export type ToolAuthorizationValidation =
  | {
      readonly status: "valid";
      readonly policyVersion: string;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

/**
 * External policy decides whether authority may be issued. Core always asks
 * again immediately before issuing its one-shot Grant.
 */
export interface ToolAuthorizationService<Context = unknown> {
  authorize(
    input: ToolAuthorizationInput<Context>,
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;

  revalidate(
    input: ToolAuthorizationInput<Context> & {
      readonly decision: Extract<ToolAuthorizationDecision, {
        readonly status: "allowed";
      }>;
    },
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationValidation> | ToolAuthorizationValidation;
}

/** Core-issued authority, bound to exactly one call and one Step snapshot. */
export interface ToolAuthorizationGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly capabilities: ToolCapabilityRequest;
  readonly policyVersion: string;
  readonly authorityVersion: string;
  readonly registryVersion: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolAuthorizationGrantExpectation {
  readonly call?: ReadyToolCall;
  readonly callId?: string;
  readonly toolName?: string;
  readonly policyVersion?: string;
  readonly authorityVersion?: string;
  readonly registryVersion?: number;
}

export interface IssueToolAuthorizationGrantInput {
  readonly grantId: string;
  readonly call: ReadyToolCall;
  readonly capabilities: ToolCapabilityRequest;
  readonly policyVersion: string;
  readonly snapshot: ToolExecutionSnapshot;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const activeGrants = new WeakSet<ToolAuthorizationGrant>();
const consumedGrants = new WeakSet<ToolAuthorizationGrant>();
const issuedGrants = new WeakSet<ToolAuthorizationGrant>();
const issuedCalls = new WeakMap<ToolAuthorizationGrant, ReadyToolCall>();

/** @internal Used by the Core ToolExecutor after final authorization checks. */
export function issueToolAuthorizationGrant(
  input: IssueToolAuthorizationGrantInput,
): ToolAuthorizationGrant {
  const issuedAt = requireTimestamp(input.issuedAt, "Grant issuedAt");
  const expiresAt = requireTimestamp(input.expiresAt, "Grant expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("Grant expiresAt must be later than issuedAt");
  }
  const grant: ToolAuthorizationGrant = Object.freeze({
    schemaVersion: 1 as const,
    grantId: requireIdentifier(input.grantId, "Grant id"),
    callId: requireIdentifier(input.call.id, "Tool call id"),
    toolName: requireIdentifier(input.call.name, "Tool name"),
    capabilities: normalizeToolCapabilityRequest(input.capabilities),
    policyVersion: requireIdentifier(input.policyVersion, "Policy version"),
    authorityVersion: requireIdentifier(
      input.snapshot.authorityVersion,
      "Authority version",
    ),
    registryVersion: nonNegativeSafeInteger(
      input.snapshot.registryVersion,
      "Registry version",
    ),
    issuedAt,
    expiresAt,
    ...(input.metadata === undefined
      ? {}
      : {
          metadata: deepFreezePlainValue({ ...input.metadata }) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
  issuedGrants.add(grant);
  issuedCalls.set(grant, input.call);
  return grant;
}

/** Activates a Grant exactly once and only for the dynamic extent of execute. */
export async function withActiveToolAuthorizationGrant<Output>(
  grant: ToolAuthorizationGrant,
  execute: () => Promise<Output> | Output,
): Promise<Output> {
  if (!issuedGrants.has(grant)) {
    throw new Error("Tool authorization Grant was not issued by Core");
  }
  if (activeGrants.has(grant) || consumedGrants.has(grant)) {
    throw new Error(`Tool authorization Grant ${grant.grantId} cannot be reused`);
  }
  consumedGrants.add(grant);
  activeGrants.add(grant);
  try {
    assertActiveToolAuthorizationGrant(grant);
    return await execute();
  } finally {
    activeGrants.delete(grant);
  }
}

/** Concrete enforcement backends may require this check before side effects. */
export function assertActiveToolAuthorizationGrant(
  grant: ToolAuthorizationGrant,
  expected: ToolAuthorizationGrantExpectation = {},
): void {
  if (!issuedGrants.has(grant) || !activeGrants.has(grant)) {
    throw new Error(`Tool authorization Grant ${grant.grantId} is not active`);
  }
  if (Date.parse(grant.expiresAt) <= Date.now()) {
    throw new Error(`Tool authorization Grant ${grant.grantId} has expired`);
  }
  if (expected.call !== undefined && issuedCalls.get(grant) !== expected.call) {
    throw new Error(`Tool authorization Grant ${grant.grantId} belongs to another input`);
  }
  if (expected.callId !== undefined && expected.callId !== grant.callId) {
    throw new Error(`Tool authorization Grant ${grant.grantId} belongs to another call`);
  }
  if (expected.toolName !== undefined && expected.toolName !== grant.toolName) {
    throw new Error(`Tool authorization Grant ${grant.grantId} belongs to another Tool`);
  }
  if (
    expected.policyVersion !== undefined &&
    expected.policyVersion !== grant.policyVersion
  ) {
    throw new Error(`Tool authorization Grant ${grant.grantId} policy is stale`);
  }
  if (
    expected.authorityVersion !== undefined &&
    expected.authorityVersion !== grant.authorityVersion
  ) {
    throw new Error(`Tool authorization Grant ${grant.grantId} authority is stale`);
  }
  if (
    expected.registryVersion !== undefined &&
    expected.registryVersion !== grant.registryVersion
  ) {
    throw new Error(`Tool authorization Grant ${grant.grantId} registry is stale`);
  }
}

export function normalizeToolCapabilityRequest(
  request: ToolCapabilityRequest,
): ToolCapabilityRequest {
  if (request === null || typeof request !== "object") {
    throw new Error("Tool capability request must be an object");
  }
  if (!Array.isArray(request.requirements)) {
    throw new Error("Tool capability requirements must be an array");
  }
  const requirements = request.requirements.map(normalizeRequirement);
  const effects = request.effects === undefined
    ? undefined
    : Object.freeze({
        ...(request.effects.destructive === undefined
          ? {}
          : {
              destructive: requireBoolean(
                request.effects.destructive,
                "Tool capability destructive effect",
              ),
            }),
        ...(request.effects.openWorld === undefined
          ? {}
          : {
              openWorld: requireBoolean(
                request.effects.openWorld,
                "Tool capability openWorld effect",
              ),
            }),
      });
  return Object.freeze({
    requirements: Object.freeze(requirements),
    ...(effects === undefined ? {} : { effects }),
  });
}

function normalizeRequirement(
  requirement: ToolCapabilityRequirement,
): ToolCapabilityRequirement {
  if (requirement === null || typeof requirement !== "object") {
    throw new Error("Tool capability requirement must be an object");
  }
  switch (requirement.capability) {
    case "filesystem.read":
    case "filesystem.write":
      return Object.freeze({
        capability: requirement.capability,
        paths: normalizeResources(requirement.paths, `${requirement.capability} paths`),
      });
    case "process.exec":
      return Object.freeze({
        capability: requirement.capability,
        ...(requirement.commands === undefined
          ? {}
          : {
              commands: normalizeResources(
                requirement.commands,
                "process.exec commands",
              ),
            }),
      });
    case "network.connect":
      return Object.freeze({
        capability: requirement.capability,
        hosts: normalizeResources(requirement.hosts, "network.connect hosts"),
      });
    case "external.side_effect":
    case "runtime.read":
    case "runtime.control":
      return Object.freeze({
        capability: requirement.capability,
        resources: normalizeResources(
          requirement.resources,
          `${requirement.capability} resources`,
        ),
      });
    default:
      throw new Error("Unknown Tool capability");
  }
}

function normalizeResources(
  resources: readonly string[],
  label: string,
): readonly string[] {
  if (!Array.isArray(resources)) throw new Error(`${label} must be an array`);
  const normalized = resources.map((resource) =>
    requireIdentifier(resource, `${label} entry`)
  );
  return Object.freeze([...new Set(normalized)]);
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

function requireTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireBoolean(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function deepFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezePlainValue));
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreezePlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
