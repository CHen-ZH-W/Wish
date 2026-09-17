import { createHash } from "node:crypto";

export type CapabilityKind =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.connect"
  | "web.search"
  | "web.fetch"
  | "external.side_effect"
  | "runtime.read"
  | "runtime.control";

export type CapabilityRequirement =
  | {
      readonly capability: "filesystem.read" | "filesystem.write";
      readonly paths: readonly string[];
    }
  | {
      readonly capability: "process.exec";
      readonly commands?: readonly string[];
      readonly cwd?: string;
      readonly timeoutSeconds?: number;
    }
  | {
      readonly capability: "network.connect";
      readonly hosts: readonly string[];
    }
  | {
      readonly capability: "web.search";
      readonly providers: readonly string[];
    }
  | {
      readonly capability: "web.fetch";
      readonly providers: readonly string[];
      readonly origins: readonly string[];
    }
  | {
      readonly capability:
        | "external.side_effect"
        | "runtime.read"
        | "runtime.control";
      readonly resources: readonly string[];
    };

export interface CapabilityRequest {
  readonly requirements: readonly CapabilityRequirement[];
  readonly effects?: {
    readonly destructive?: boolean;
    readonly openWorld?: boolean;
  };
}

/** Stable identity of the runtime operation for which authority was issued. */
export interface CapabilityAuthorizationSubject {
  readonly kind: string;
  readonly id: string;
  readonly name?: string;
  readonly generation?: number;
}

/** One-shot runtime authority independent of the Consumer that requested it. */
export interface CapabilityAuthorizationGrant {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly subject: CapabilityAuthorizationSubject;
  readonly capabilities: CapabilityRequest;
  readonly policyVersion: string;
  readonly authorityVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CapabilityAuthorizationGrantExpectation {
  readonly subjectKind?: string;
  readonly subjectId?: string;
  readonly subjectName?: string;
  readonly subjectGeneration?: number;
  readonly policyVersion?: string;
  readonly authorityVersion?: string;
}

export interface CapabilityClock {
  now(): Date;
}

export interface IssueCapabilityAuthorizationGrantInput {
  readonly grantId: string;
  readonly subject: CapabilityAuthorizationSubject;
  readonly capabilities: CapabilityRequest;
  readonly policyVersion: string;
  readonly authorityVersion: string;
  readonly clock: CapabilityClock;
  readonly issuedAtEpochMs: number;
  readonly ttlMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const activeGrants = new WeakSet<CapabilityAuthorizationGrant>();
const consumedGrants = new WeakSet<CapabilityAuthorizationGrant>();
const issuedGrants = new WeakSet<CapabilityAuthorizationGrant>();
const issuedClocks = new WeakMap<CapabilityAuthorizationGrant, CapabilityClock>();

/** @internal Called by an authority owner after its final policy checks. */
export function issueCapabilityAuthorizationGrant(
  input: IssueCapabilityAuthorizationGrantInput,
): CapabilityAuthorizationGrant {
  const clock = requireCapabilityClock(input.clock);
  const issuedAtEpochMs = requireEpochMilliseconds(
    input.issuedAtEpochMs,
    "Grant issuedAt",
  );
  const ttlMs = positiveSafeInteger(input.ttlMs, "Grant ttlMs");
  const expiresAtEpochMs = requireEpochMilliseconds(
    issuedAtEpochMs + ttlMs,
    "Grant expiresAt",
  );
  const grant: CapabilityAuthorizationGrant = Object.freeze({
    schemaVersion: 1 as const,
    grantId: requireIdentifier(input.grantId, "Grant id"),
    subject: normalizeSubject(input.subject),
    capabilities: normalizeCapabilityRequest(input.capabilities),
    policyVersion: requireIdentifier(input.policyVersion, "Policy version"),
    authorityVersion: requireIdentifier(
      input.authorityVersion,
      "Authority version",
    ),
    issuedAt: new Date(issuedAtEpochMs).toISOString(),
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
    ...(input.metadata === undefined
      ? {}
      : {
          metadata: deepFreezePlainValue({ ...input.metadata }) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
  issuedGrants.add(grant);
  issuedClocks.set(grant, clock);
  return grant;
}

/** Activates one Grant exactly once for the dynamic extent of an operation. */
export async function withActiveCapabilityAuthorizationGrant<Output>(
  grant: CapabilityAuthorizationGrant,
  execute: () => Promise<Output> | Output,
): Promise<Output> {
  if (!issuedGrants.has(grant)) {
    throw new Error("Authorization Grant was not issued by Core");
  }
  if (activeGrants.has(grant) || consumedGrants.has(grant)) {
    throw new Error(`Authorization Grant ${grant.grantId} cannot be reused`);
  }
  consumedGrants.add(grant);
  activeGrants.add(grant);
  try {
    assertActiveCapabilityAuthorizationGrant(grant);
    return await execute();
  } finally {
    activeGrants.delete(grant);
  }
}

/** Concrete capability Providers call this immediately before side effects. */
export function assertActiveCapabilityAuthorizationGrant(
  grant: CapabilityAuthorizationGrant,
  expected: CapabilityAuthorizationGrantExpectation = {},
): void {
  if (!issuedGrants.has(grant) || !activeGrants.has(grant)) {
    throw new Error(`Authorization Grant ${grant.grantId} is not active`);
  }
  const clock = issuedClocks.get(grant);
  if (clock === undefined) {
    throw new Error(`Authorization Grant ${grant.grantId} has no clock`);
  }
  if (Date.parse(grant.expiresAt) <= readClockEpochMilliseconds(clock)) {
    throw new Error(`Authorization Grant ${grant.grantId} has expired`);
  }
  if (
    expected.subjectKind !== undefined &&
    expected.subjectKind !== grant.subject.kind
  ) {
    throw new Error(`Authorization Grant ${grant.grantId} belongs to another subject kind`);
  }
  if (
    expected.subjectId !== undefined &&
    expected.subjectId !== grant.subject.id
  ) {
    throw new Error(`Authorization Grant ${grant.grantId} belongs to another subject`);
  }
  if (
    expected.subjectName !== undefined &&
    expected.subjectName !== grant.subject.name
  ) {
    throw new Error(`Authorization Grant ${grant.grantId} belongs to another operation`);
  }
  if (
    expected.subjectGeneration !== undefined &&
    expected.subjectGeneration !== grant.subject.generation
  ) {
    throw new Error(`Authorization Grant ${grant.grantId} generation is stale`);
  }
  if (
    expected.policyVersion !== undefined &&
    expected.policyVersion !== grant.policyVersion
  ) {
    throw new Error(`Authorization Grant ${grant.grantId} policy is stale`);
  }
  if (
    expected.authorityVersion !== undefined &&
    expected.authorityVersion !== grant.authorityVersion
  ) {
    throw new Error(`Authorization Grant ${grant.grantId} authority is stale`);
  }
}

export function normalizeCapabilityRequest(
  request: CapabilityRequest,
): CapabilityRequest {
  if (request === null || typeof request !== "object") {
    throw new Error("Capability request must be an object");
  }
  if (!Array.isArray(request.requirements)) {
    throw new Error("Capability requirements must be an array");
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
                "Capability destructive effect",
              ),
            }),
        ...(request.effects.openWorld === undefined
          ? {}
          : {
              openWorld: requireBoolean(
                request.effects.openWorld,
                "Capability openWorld effect",
              ),
            }),
      });
  return Object.freeze({
    requirements: Object.freeze(requirements),
    ...(effects === undefined ? {} : { effects }),
  });
}

/** Order-insensitive identity for an exact capability/resource decision. */
export function capabilityRequestDigest(request: CapabilityRequest): string {
  const normalized = normalizeCapabilityRequest(request);
  const requirements = normalized.requirements.map((requirement) => {
    switch (requirement.capability) {
      case "filesystem.read":
      case "filesystem.write":
        return {
          capability: requirement.capability,
          paths: [...requirement.paths].sort(),
        };
      case "process.exec":
        return {
          capability: requirement.capability,
          commands: requirement.commands === undefined
            ? null
            : [...requirement.commands].sort(),
          cwd: requirement.cwd ?? null,
          timeoutSeconds: requirement.timeoutSeconds ?? null,
        };
      case "network.connect":
        return {
          capability: requirement.capability,
          hosts: [...requirement.hosts].sort(),
        };
      case "web.search":
        return {
          capability: requirement.capability,
          providers: [...requirement.providers].sort(),
        };
      case "web.fetch":
        return {
          capability: requirement.capability,
          providers: [...requirement.providers].sort(),
          origins: [...requirement.origins].sort(),
        };
      case "external.side_effect":
      case "runtime.read":
      case "runtime.control":
        return {
          capability: requirement.capability,
          resources: [...requirement.resources].sort(),
        };
    }
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = {
    requirements,
    effects: {
      destructive: normalized.effects?.destructive === true,
      openWorld: normalized.effects?.openWorld === true,
    },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function normalizeSubject(
  subject: CapabilityAuthorizationSubject,
): CapabilityAuthorizationSubject {
  if (subject === null || typeof subject !== "object") {
    throw new Error("Authorization subject must be an object");
  }
  return Object.freeze({
    kind: requireIdentifier(subject.kind, "Authorization subject kind"),
    id: requireIdentifier(subject.id, "Authorization subject id"),
    ...(subject.name === undefined
      ? {}
      : { name: requireIdentifier(subject.name, "Authorization subject name") }),
    ...(subject.generation === undefined
      ? {}
      : {
          generation: nonNegativeSafeInteger(
            subject.generation,
            "Authorization subject generation",
          ),
        }),
  });
}

function normalizeRequirement(
  requirement: CapabilityRequirement,
): CapabilityRequirement {
  if (requirement === null || typeof requirement !== "object") {
    throw new Error("Capability requirement must be an object");
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
        ...(requirement.cwd === undefined
          ? {}
          : { cwd: normalizeProcessCwd(requirement.cwd) }),
        ...(requirement.timeoutSeconds === undefined
          ? {}
          : {
              timeoutSeconds: positiveFiniteNumber(
                requirement.timeoutSeconds,
                "process.exec timeoutSeconds",
              ),
            }),
      });
    case "network.connect":
      return Object.freeze({
        capability: requirement.capability,
        hosts: normalizeResources(requirement.hosts, "network.connect hosts"),
      });
    case "web.search":
      return Object.freeze({
        capability: requirement.capability,
        providers: normalizeResources(
          requirement.providers,
          "web.search providers",
        ),
      });
    case "web.fetch":
      return Object.freeze({
        capability: requirement.capability,
        providers: normalizeResources(
          requirement.providers,
          "web.fetch providers",
        ),
        origins: normalizeWebOrigins(requirement.origins),
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
      throw new Error("Unknown capability");
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

function normalizeWebOrigins(origins: readonly string[]): readonly string[] {
  const values = normalizeResources(origins, "web.fetch origins");
  return Object.freeze(values.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`web.fetch origin ${JSON.stringify(value)} is invalid`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `web.fetch origin ${JSON.stringify(value)} must use HTTP or HTTPS`,
      );
    }
    if (
      url.username.length > 0 || url.password.length > 0 ||
      url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0 ||
      url.origin !== value
    ) {
      throw new Error(
        `web.fetch origin ${JSON.stringify(value)} must be an exact URL origin`,
      );
    }
    return url.origin;
  }));
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

function normalizeProcessCwd(value: string): string {
  const cwd = requireIdentifier(value, "process.exec cwd");
  if (cwd.includes("\0")) throw new Error("process.exec cwd contains a null byte");
  return cwd;
}

function requireCapabilityClock(clock: CapabilityClock): CapabilityClock {
  if (clock === null || typeof clock !== "object" || typeof clock.now !== "function") {
    throw new Error("Capability clock must provide now()");
  }
  return clock;
}

function readClockEpochMilliseconds(clock: CapabilityClock): number {
  const now = clock.now();
  if (!(now instanceof Date)) {
    throw new Error("Capability clock now() must return a valid Date");
  }
  return requireEpochMilliseconds(now.getTime(), "Capability clock now()");
}

function requireEpochMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new Error(`${label} must be valid epoch milliseconds`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
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
