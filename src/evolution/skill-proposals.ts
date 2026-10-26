import { createHash } from "node:crypto";
import { digest, freezeJson, identifier } from "../agent-profiles/validation.js";
import { createSkillPackageSnapshot, validateSkillPackageSnapshot, FrozenSkills } from "../skills/local.js";
import { parseSkillMarkdown, skillName } from "../skills/markdown.js";
import { resourcePath } from "../skills/resources.js";
import type { SkillPackageSnapshot, SkillSummary } from "../skills/types.js";

export interface SkillProposalIdentity {
  readonly id: string;
  readonly version: number;
  readonly reason: string;
  readonly previousDigest?: string;
}
export interface SkillResourceChange { readonly path: string; readonly content: string | null }
export interface SkillProposalConflict {
  readonly kind: "competing-edits" | "unassigned-resource";
  readonly path: string;
  readonly variants: readonly { readonly proposalId: string; readonly content: string | null }[];
}
export interface SkillResourceDestination {
  readonly baseDigest: string;
  readonly sourcePath: string;
  readonly targetName: string;
  readonly targetPath: string;
}
/** Reviewable data only. Keeping complete bases preserves every previous resource on edits/retirement. */
export interface SkillChangeProposal extends SkillProposalIdentity {
  readonly schemaVersion: 1;
  readonly kind: "patch" | "merge-patches" | "merge-packages" | "split" | "retire";
  readonly status: "ready" | "conflicted";
  readonly bases: readonly SkillPackageSnapshot[];
  readonly outputs: readonly SkillPackageSnapshot[];
  readonly changes: readonly SkillResourceChange[];
  readonly conflicts: readonly SkillProposalConflict[];
  readonly resourceMap: readonly SkillResourceDestination[];
  readonly inputProposalDigests: readonly string[];
  readonly digest: string;
}

export function proposeSkillPatch(input: SkillProposalIdentity & {
  readonly base: SkillPackageSnapshot; readonly expectedBaseDigest: string; readonly changes: readonly SkillResourceChange[];
}): SkillChangeProposal {
  const base = pinned(input.base, input.expectedBaseDigest), changes = validateChanges(input.changes);
  const output = applyChanges(base, changes);
  return proposal(input, "patch", [base], [output], changes);
}

/** Same-base edits are merged by resource, never by silently choosing the newest proposal. */
export function mergeSkillPatches(input: SkillProposalIdentity & {
  readonly base: SkillPackageSnapshot; readonly expectedBaseDigest: string; readonly proposals: readonly SkillChangeProposal[];
}): SkillChangeProposal {
  const base = pinned(input.base, input.expectedBaseDigest);
  if (!input.proposals.length || input.proposals.length > 32) throw new Error("Skill patch merge requires 1-32 proposals");
  const inputs = input.proposals.map(validateSkillChangeProposal), variants = new Map<string, { proposalId: string; content: string | null }[]>();
  for (const item of inputs) {
    if (!["patch", "merge-patches"].includes(item.kind) || item.status !== "ready" || item.bases.length !== 1 || item.bases[0]!.digest !== base.digest) throw new Error("Skill patches must share the exact complete baseDigest");
    for (const change of item.changes) {
      const entries = variants.get(change.path) ?? [];
      entries.push({ proposalId: `${item.id}@${item.version}`, content: change.content }); variants.set(change.path, entries);
    }
  }
  const changes: SkillResourceChange[] = [], conflicts: SkillProposalConflict[] = [];
  for (const [path, entries] of [...variants].sort(([a], [b]) => a.localeCompare(b))) {
    if (new Set(entries.map(entry => entry.content)).size > 1) conflicts.push({ kind: "competing-edits", path, variants: entries });
    else changes.push({ path, content: entries[0]!.content });
  }
  return proposal(input, "merge-patches", [base], conflicts.length ? [] : [applyChanges(base, changes)], changes, conflicts, [], inputs.map(item => item.digest));
}

export function resolveSkillPatchConflicts(input: {
  readonly proposal: SkillChangeProposal; readonly expectedProposalDigest: string; readonly resolutions: readonly SkillResourceChange[]; readonly reason: string;
}): SkillChangeProposal {
  const previous = validateSkillChangeProposal(input.proposal);
  if (previous.digest !== input.expectedProposalDigest || previous.kind !== "merge-patches" || previous.status !== "conflicted") throw new Error("Skill proposal is stale or has no patch conflicts");
  const resolutions = validateChanges(input.resolutions), paths = previous.conflicts.map(item => item.path);
  if (resolutions.length !== paths.length || resolutions.some(item => !paths.includes(item.path))) throw new Error("Resolve every conflicting resource exactly once");
  const changes = [...previous.changes, ...resolutions].sort((a, b) => a.path.localeCompare(b.path));
  return proposal({ id: previous.id, version: previous.version + 1, previousDigest: previous.digest, reason: input.reason }, "merge-patches", previous.bases,
    [applyChanges(previous.bases[0]!, changes)], changes, [], [], previous.inputProposalDigests);
}

/** Merge keeps each original manifest and namespaces resources; all moves are explicit in resourceMap. */
export function proposeSkillMerge(input: SkillProposalIdentity & {
  readonly bases: readonly SkillPackageSnapshot[]; readonly expectedBaseDigests: readonly string[]; readonly name: string; readonly manifest: string;
}): SkillChangeProposal {
  const bases = pinMany(input.bases, input.expectedBaseDigests);
  if (bases.length < 2) throw new Error("Skill package merge requires at least two bases");
  skillName(input.name);
  const files: Record<string, string> = { "SKILL.md": input.manifest }, moves: SkillResourceDestination[] = [];
  for (const base of bases) for (const resource of base.resources) {
    const separator = resource.path.indexOf("/");
    const path = resource.path === "SKILL.md" ? `references/merged/${base.skill.name}/SKILL.md`
      : `${resource.path.slice(0, separator)}/${base.skill.name}/${resource.path.slice(separator + 1)}`;
    resourcePath(path);
    if (Object.hasOwn(files, path)) throw new Error("Merged Skill resource path collision");
    files[path] = resource.content;
    moves.push({ baseDigest: base.digest, sourcePath: resource.path, targetName: input.name, targetPath: path });
  }
  return proposal(input, "merge-packages", bases, [newPackage(input.id, input.name, input.manifest, files, bases)], [], [], moves);
}

export function proposeSkillSplit(input: SkillProposalIdentity & {
  readonly base: SkillPackageSnapshot; readonly expectedBaseDigest: string;
  readonly parts: readonly { readonly name: string; readonly manifest: string; readonly paths: readonly string[] }[];
}): SkillChangeProposal {
  const base = pinned(input.base, input.expectedBaseDigest);
  if (input.parts.length < 2 || input.parts.length > 16 || new Set(input.parts.map(part => part.name)).size !== input.parts.length) throw new Error("Skill split requires 2-16 distinct packages");
  const outputs: SkillPackageSnapshot[] = [], moves: SkillResourceDestination[] = [], assigned = new Set<string>();
  for (const part of input.parts) {
    skillName(part.name);
    if (!Array.isArray(part.paths) || new Set(part.paths).size !== part.paths.length) throw new Error("Duplicate Skill split assignment");
    const files: Record<string, string> = { "SKILL.md": part.manifest };
    for (const path of part.paths) {
      resourcePath(path);
      const resource = base.resources.find(item => item.path === path);
      if (!resource || path === "SKILL.md") throw new Error("Skill split must assign existing non-manifest resources");
      files[path] = resource.content; assigned.add(path);
      moves.push({ baseDigest: base.digest, sourcePath: path, targetName: part.name, targetPath: path });
    }
    outputs.push(newPackage(input.id, part.name, part.manifest, files, [base]));
  }
  const conflicts = base.resources.filter(item => item.path !== "SKILL.md" && !assigned.has(item.path)).map(item => ({ kind: "unassigned-resource" as const,
    path: item.path, variants: [{ proposalId: `${input.id}@${input.version}`, content: item.content }] }));
  return proposal(input, "split", [base], outputs, [], conflicts, moves);
}

/** Retirement proposes removal from visibility; it retains all source bytes and performs no deletion. */
export function proposeSkillRetirement(input: SkillProposalIdentity & { readonly base: SkillPackageSnapshot; readonly expectedBaseDigest: string }): SkillChangeProposal {
  return proposal(input, "retire", [pinned(input.base, input.expectedBaseDigest)], [], []);
}

export function validateSkillChangeProposal(value: unknown): SkillChangeProposal {
  const input = value as SkillChangeProposal;
  if (!input || input.schemaVersion !== 1 || !["patch", "merge-patches", "merge-packages", "split", "retire"].includes(input.kind) || !["ready", "conflicted"].includes(input.status) ||
    !Array.isArray(input.bases) || !Array.isArray(input.outputs) || !Array.isArray(input.changes) || !Array.isArray(input.conflicts) || !Array.isArray(input.resourceMap) || !Array.isArray(input.inputProposalDigests)) throw new Error("Invalid Skill change proposal");
  const rebuilt = proposal(input, input.kind, input.bases, input.outputs, validateChanges(input.changes), input.conflicts, input.resourceMap, input.inputProposalDigests);
  if (rebuilt.digest !== input.digest || rebuilt.status !== input.status) throw new Error("Skill change proposal digest mismatch");
  return rebuilt;
}

function pinned(value: SkillPackageSnapshot, expected: string): SkillPackageSnapshot {
  const base = validateSkillPackageSnapshot(value);
  if (base.digest !== expected) throw new Error("Skill complete baseDigest changed");
  return base;
}
function pinMany(values: readonly SkillPackageSnapshot[], expected: readonly string[]): readonly SkillPackageSnapshot[] {
  if (values.length !== expected.length || !values.length || values.length > 16) throw new Error("Pin every Skill merge base");
  const bases = values.map((value, index) => pinned(value, expected[index]!));
  if (new Set(bases.map(base => base.skill.name)).size !== bases.length) throw new Error("Skill merge bases need distinct names");
  return bases;
}
function validateChanges(values: readonly SkillResourceChange[]): readonly SkillResourceChange[] {
  if (!Array.isArray(values) || values.length > 256 || new Set(values.map(item => item.path)).size !== values.length) throw new Error("Invalid Skill resource changes");
  return values.map(item => {
    resourcePath(item.path);
    if (item.content !== null && (typeof item.content !== "string" || Buffer.byteLength(item.content) > 1_000_000)) throw new Error("Invalid Skill change bytes");
    return { path: item.path, content: item.content };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function applyChanges(base: SkillPackageSnapshot, changes: readonly SkillResourceChange[]): SkillPackageSnapshot {
  const files = Object.fromEntries(base.resources.map(item => [item.path, item.content]));
  for (const change of changes) {
    if (change.content === null) { if (!Object.hasOwn(files, change.path)) throw new Error("Cannot remove an absent Skill resource"); delete files[change.path]; }
    else files[change.path] = change.content;
  }
  if (!files["SKILL.md"]) throw new Error("A Skill patch cannot remove its manifest; propose retirement instead");
  const metadata = parseSkillMarkdown(files["SKILL.md"], base.skill.name);
  return createSkillPackageSnapshot({ ...base.skill, ...metadata, digest: textDigest(files["SKILL.md"]) }, files);
}
function newPackage(id: string, name: string, manifest: string, files: Readonly<Record<string, string>>, bases: readonly SkillPackageSnapshot[]): SkillPackageSnapshot {
  const metadata = parseSkillMarkdown(manifest, name);
  const skill: SkillSummary = { ...metadata, packageId: digest(["skill-proposal", id, name, bases.map(base => base.digest)]),
    source: bases.every(base => base.skill.source === "user") ? "user" : "workspace", location: `proposal:${id}/${name}/SKILL.md`, digest: textDigest(manifest) };
  return createSkillPackageSnapshot(skill, files);
}
function textDigest(text: string): string {
  // Package resources use raw UTF-8 SHA-256, unlike canonical JSON artifact digests.
  return createHash("sha256").update(text).digest("hex");
}
function proposal(identity: SkillProposalIdentity, kind: SkillChangeProposal["kind"], bases: readonly SkillPackageSnapshot[], outputs: readonly SkillPackageSnapshot[],
  changes: readonly SkillResourceChange[], conflicts: readonly SkillProposalConflict[] = [], resourceMap: readonly SkillResourceDestination[] = [], inputProposalDigests: readonly string[] = []): SkillChangeProposal {
  identifier(identity.id);
  if (!Number.isSafeInteger(identity.version) || identity.version < 1 || typeof identity.reason !== "string" || !identity.reason.trim() || identity.reason.length > 4000 ||
    (identity.previousDigest !== undefined && !/^[a-f0-9]{64}$/u.test(identity.previousDigest)) || bases.length < 1 || bases.length > 16 || outputs.length > 16 || conflicts.length > 256 || resourceMap.length > 4096 || inputProposalDigests.length > 32 || inputProposalDigests.some(value => !/^[a-f0-9]{64}$/u.test(value))) throw new Error("Invalid Skill proposal identity or limits");
  const stableBases = bases.map(validateSkillPackageSnapshot), stableOutputs = outputs.map(validateSkillPackageSnapshot);
  new FrozenSkills(stableBases); new FrozenSkills(stableOutputs);
  for (const conflict of conflicts) {
    resourcePath(conflict.path);
    if (!["competing-edits", "unassigned-resource"].includes(conflict.kind) || !Array.isArray(conflict.variants) || !conflict.variants.length || conflict.variants.length > 32 || conflict.variants.some(item => typeof item.proposalId !== "string" || item.proposalId.length > 256 || item.content !== null && (typeof item.content !== "string" || Buffer.byteLength(item.content) > 1_000_000))) throw new Error("Invalid Skill conflict state");
  }
  for (const move of resourceMap) {
    resourcePath(move.sourcePath); resourcePath(move.targetPath);
    const original = stableBases.find(base => base.digest === move.baseDigest)?.resources.find(item => item.path === move.sourcePath);
    const target = stableOutputs.find(output => output.skill.name === move.targetName)?.resources.find(item => item.path === move.targetPath);
    if (!original || !target || original.content !== target.content) throw new Error("Skill resource move lost or changed original bytes");
  }
  if (kind === "patch" || kind === "merge-patches") {
    if (stableBases.length !== 1 || resourceMap.length || (kind === "patch" && conflicts.length) || conflicts.some(item => item.kind !== "competing-edits") ||
      stableOutputs.length !== (conflicts.length ? 0 : 1) || new Set(conflicts.map(item => item.path)).size !== conflicts.length ||
      conflicts.some(item => changes.some(change => change.path === item.path) || new Set(item.variants.map(variant => variant.content)).size < 2)) throw new Error("Invalid Skill patch proposal state");
    if (!conflicts.length && applyChanges(stableBases[0]!, changes).digest !== stableOutputs[0]!.digest) throw new Error("Skill patch output does not match proposed changes");
  } else if (kind === "retire") {
    if (stableBases.length !== 1 || stableOutputs.length || changes.length || conflicts.length || resourceMap.length) throw new Error("Invalid Skill retirement proposal state");
  } else {
    if (changes.length || (kind === "merge-packages" ? stableBases.length < 2 || stableOutputs.length !== 1 || conflicts.length : stableBases.length !== 1 || stableOutputs.length < 2)) throw new Error("Invalid Skill merge/split proposal state");
    const unassigned = new Set<string>();
    for (const base of stableBases) for (const resource of base.resources) {
      if (kind === "split" && resource.path === "SKILL.md") continue;
      if (resourceMap.some(move => move.baseDigest === base.digest && move.sourcePath === resource.path)) continue;
      unassigned.add(resource.path);
      if (!conflicts.some(conflict => conflict.kind === "unassigned-resource" && conflict.path === resource.path && conflict.variants.some(item => item.content === resource.content))) throw new Error("Skill resource has no preserved destination or explicit conflict");
    }
    if (conflicts.length !== unassigned.size || conflicts.some(item => item.kind !== "unassigned-resource" || !unassigned.has(item.path))) throw new Error("Invalid unassigned Skill resource conflict");
  }
  const body = { schemaVersion: 1 as const, id: identity.id, version: identity.version, reason: identity.reason,
    ...(identity.previousDigest === undefined ? {} : { previousDigest: identity.previousDigest }), kind,
    status: conflicts.length ? "conflicted" as const : "ready" as const, bases: stableBases, outputs: stableOutputs, changes, conflicts, resourceMap, inputProposalDigests };
  if (Buffer.byteLength(JSON.stringify(body)) > 24 * 1024 * 1024) throw new Error("Skill proposal total size limit exceeded");
  return freezeJson({ ...body, digest: digest(body) });
}
