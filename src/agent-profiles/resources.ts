import { isAbsolute } from "node:path";
import type { Skills, SkillPackageSnapshot } from "../skills/types.js";
import { FrozenSkills, validateSkillPackageSnapshot } from "../skills/local.js";
import type { MemorySnapshot } from "../memory/types.js";
import { document, identity, version } from "../memory/validation.js";
import { AgentProfileError, digest, exact, freezeJson, record } from "./validation.js";

/** Explicit initial state; capture never reads the production Memory service. */
export type ProfileMemoryInitialState = { readonly kind: "empty" }
  | { readonly kind: "accepted-snapshot"; readonly snapshot: MemorySnapshot; readonly digest: string };
export interface ProfileResources {
  readonly schemaVersion: 1;
  readonly coverage: "complete";
  readonly skills: { readonly packages: readonly SkillPackageSnapshot[]; readonly digest: string };
  readonly memory: ProfileMemoryInitialState;
  readonly digest: string;
}
export interface CaptureProfileResourcesInput {
  readonly cwd: string;
  readonly skills?: Skills | undefined;
  /** Must be explicit when no Skills Provider is supplied. */
  readonly emptySkills?: boolean;
  readonly memory?: ProfileMemoryInitialState;
  readonly signal?: AbortSignal;
}

export function freezeMemoryInitialState(snapshot: MemorySnapshot | null): ProfileMemoryInitialState {
  if (snapshot === null) return Object.freeze({ kind: "empty" });
  const stable = validateMemorySnapshot(snapshot);
  return freezeJson({ kind: "accepted-snapshot", snapshot: stable, digest: digest(stable) });
}

export function validateProfileResources(value: unknown): ProfileResources {
  const input = record(value); exact(input, ["schemaVersion", "coverage", "skills", "memory", "digest"]);
  if (input.schemaVersion !== 1 || input.coverage !== "complete") throw new AgentProfileError("profile_resources_invalid");
  const skills = record(input.skills); exact(skills, ["packages", "digest"]);
  if (!Array.isArray(skills.packages) || skills.packages.length > 1000) throw new AgentProfileError("profile_resources_limit");
  const packages = skills.packages.map(validateSkillPackageSnapshot);
  // Checks aggregate bytes and duplicate names/origins without touching live sources.
  new FrozenSkills(packages);
  if (digest(packages) !== skills.digest) throw new AgentProfileError("profile_skill_resources_digest_mismatch");
  const memory = record(input.memory);
  let initial: ProfileMemoryInitialState;
  if (memory.kind === "empty") { exact(memory, ["kind"]); initial = { kind: "empty" }; }
  else if (memory.kind === "accepted-snapshot") {
    exact(memory, ["kind", "snapshot", "digest"]);
    initial = freezeMemoryInitialState(memory.snapshot as MemorySnapshot);
    if (initial.kind !== "accepted-snapshot" || initial.digest !== memory.digest) throw new AgentProfileError("profile_memory_resources_digest_mismatch");
  } else throw new AgentProfileError("profile_memory_resources_invalid");
  const body = { schemaVersion: 1 as const, coverage: "complete" as const, skills: { packages, digest: skills.digest as string }, memory: initial };
  if (digest(body) !== input.digest) throw new AgentProfileError("profile_resources_digest_mismatch");
  if (Buffer.byteLength(JSON.stringify(body)) > 24 * 1024 * 1024) throw new AgentProfileError("profile_resources_limit");
  return freezeJson({ ...body, digest: input.digest as string });
}

/** Opt-in helper. Existing Profile capture/validation and normal Skills behavior are unchanged. */
export async function captureProfileResources(input: CaptureProfileResourcesInput): Promise<ProfileResources> {
  input.signal?.throwIfAborted();
  if (!isAbsolute(input.cwd)) throw new AgentProfileError("profile_resources_cwd_invalid");
  if (input.emptySkills && input.skills) throw new AgentProfileError("profile_resources_selection_ambiguous");
  if (!input.emptySkills && !input.skills?.snapshot) throw new AgentProfileError("profile_skills_snapshot_unavailable");
  const packages = input.emptySkills ? [] : [...await input.skills!.snapshot!({ cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) })];
  input.signal?.throwIfAborted();
  const body = { schemaVersion: 1 as const, coverage: "complete" as const,
    skills: { packages, digest: digest(packages) }, memory: input.memory ?? freezeMemoryInitialState(null) };
  return validateProfileResources({ ...body, digest: digest(body) });
}

/** Legacy snapshots keep their original digest; absence is never promoted to full coverage. */
export function profileResourceCoverage(snapshot: unknown): "complete" | "legacy-unfrozen" {
  const input = record(snapshot);
  if (input.resources === undefined) return "legacy-unfrozen";
  validateProfileResources(input.resources);
  return "complete";
}

function validateMemorySnapshot(value: unknown): MemorySnapshot {
  const input = record(value); exact(input, ["schemaVersion", "libraryId", "revision", "documents"]);
  if (input.schemaVersion !== 1 || !Array.isArray(input.documents) || input.documents.length > 1000) throw new AgentProfileError("profile_memory_resources_invalid");
  const documents = input.documents.map(item => document(item as Parameters<typeof document>[0]));
  if (documents.some(item => item.status !== "accepted") || new Set(documents.map(item => item.id)).size !== documents.length) throw new AgentProfileError("profile_memory_resources_not_accepted");
  const snapshot = { schemaVersion: 1 as const, libraryId: identity(input.libraryId as string), revision: version(input.revision as number), documents };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024 * 1024) throw new AgentProfileError("profile_resources_limit");
  return freezeJson(snapshot);
}
