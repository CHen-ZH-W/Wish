import { createHash } from "node:crypto";
import type { SpawnSubagentRequest, SubagentLaunchIdentity, SubagentOwner } from "./types.js";

export const MAX_SUBAGENT_RESOURCE_BYTES = 2_000_000;
export const MAX_SUBAGENT_RESOURCES = 32;

/** Bounded application data. Resource types never imply execution authority. */
export interface SubagentResource {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
}

export interface SubagentResourceManifest {
  readonly schemaVersion: 1;
  readonly identity: SubagentLaunchIdentity;
  readonly owner: SubagentOwner;
  readonly resources: readonly SubagentResource[];
  readonly digest: string;
}

/** Registered by a Host Consumer, never supplied by a model Tool argument. */
export interface SubagentResourceProvider {
  readonly id: string;
  prepare(request: SpawnSubagentRequest, identity: SubagentLaunchIdentity):
    Promise<readonly SubagentResource[]> | readonly SubagentResource[];
}

export function resourceType(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(value)) {
    throw new TypeError("Invalid Subagent resource type");
  }
  return value;
}

export function snapshotResources(value: unknown): readonly SubagentResource[] {
  if (!Array.isArray(value) || value.length > MAX_SUBAGENT_RESOURCES) throw new TypeError("Invalid Subagent resource list");
  const seen = new Set<string>();
  const resources = value.map((item: SubagentResource) => {
    const type = resourceType(item?.type);
    if (seen.has(type)) throw new TypeError("Duplicate Subagent resource type");
    seen.add(type);
    if (!Number.isSafeInteger(item.schemaVersion) || item.schemaVersion < 1) throw new TypeError("Invalid Subagent resource version");
    return Object.freeze({ type, schemaVersion: item.schemaVersion, payload: jsonValue(item.payload, 0) });
  });
  if (Buffer.byteLength(JSON.stringify(resources)) > MAX_SUBAGENT_RESOURCE_BYTES) throw new TypeError("Subagent resources exceed byte limit");
  return Object.freeze(resources);
}

export function createResourceManifest(
  identity: SubagentLaunchIdentity,
  owner: SubagentOwner,
  resources: readonly SubagentResource[],
): SubagentResourceManifest {
  const body = {
    schemaVersion: 1 as const,
    identity: Object.freeze({ id: identifier(identity.id), childSessionId: identifier(identity.childSessionId), childRunId: identifier(identity.childRunId) }),
    owner: Object.freeze({ parentAgentId: identifier(owner.parentAgentId), parentSessionId: identifier(owner.parentSessionId), parentRunId: identifier(owner.parentRunId), workspaceRoot: identifier(owner.workspaceRoot) }),
    resources: snapshotResources(resources),
  };
  return Object.freeze({ ...body, digest: resourceDigest(body) });
}

export function snapshotResourceManifest(value: unknown): SubagentResourceManifest {
  const input = value as SubagentResourceManifest;
  if (!input || input.schemaVersion !== 1 || !input.identity || !input.owner) throw new TypeError("Invalid Subagent resource manifest");
  const stable = createResourceManifest(input.identity, input.owner, input.resources);
  if (input.digest !== stable.digest) throw new TypeError("Subagent resource manifest digest mismatch");
  return stable;
}

export function assertResourceIdentity(manifest: SubagentResourceManifest, identity: SubagentLaunchIdentity): void {
  if (manifest.identity.id !== identity.id || manifest.identity.childSessionId !== identity.childSessionId || manifest.identity.childRunId !== identity.childRunId) {
    throw new Error("Subagent resource identity mismatch");
  }
}

export function resourceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 4096 || value.includes("\0")) throw new TypeError("Invalid Subagent resource identity");
  return value;
}

function jsonValue(value: unknown, depth: number): unknown {
  if (depth > 24) throw new TypeError("Subagent resource is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= MAX_SUBAGENT_RESOURCE_BYTES) return value;
  if (Array.isArray(value) && value.length <= 10_000) return Object.freeze(value.map(item => jsonValue(item, depth + 1)));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 1024) throw new TypeError("Subagent resource object is too large");
    return Object.freeze(Object.fromEntries(entries.map(([key, item]) => [key, jsonValue(item, depth + 1)])));
  }
  throw new TypeError("Subagent resources must contain bounded plain JSON");
}
