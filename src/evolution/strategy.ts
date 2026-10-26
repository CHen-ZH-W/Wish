import { digest, freezeJson } from "../agent-profiles/validation.js";
import { object, sha, text, fail } from "./validation.js";
import type { ExperienceEntry } from "./experience.js";
import { validateExperience } from "./experience.js";
import { ProfileRecordStore } from "../agent-profiles/store.js";
import type { StorageBackendResolver } from "../storage/backend.js";
export type SkillLayer = "planning" | "functional" | "atomic";
export interface LayeredSkillMetadata {
  readonly schemaVersion: 1; readonly layer: SkillLayer; readonly scope: string;
  readonly dependencies: readonly { readonly packageDigest: string; readonly layer: SkillLayer }[];
  readonly experienceDigests: readonly string[];
}
export interface StrategyGene {
  readonly schemaVersion: 1; readonly id: string; readonly version: number; readonly digest: string;
  readonly scope: string; readonly applicability: readonly string[]; readonly actions: readonly string[];
  readonly warnings: readonly { readonly condition: string; readonly avoid: string; readonly instead: string }[];
  readonly experienceDigests: readonly string[]; readonly skillDigests: readonly string[]; readonly parentDigest?: string;
  readonly status: "proposal";
}
const layers: readonly SkillLayer[] = ["planning", "functional", "atomic"];
export function layeredSkillMetadata(value: LayeredSkillMetadata): LayeredSkillMetadata {
  const row = object(value);
  if (Object.keys(row).some(key => !["schemaVersion", "layer", "scope", "dependencies", "experienceDigests"].includes(key)) || row.schemaVersion !== 1 || !layers.includes(value.layer) || text(value.scope).length > 4096 || !Array.isArray(value.dependencies) || value.dependencies.length > 32 || !Array.isArray(value.experienceDigests) || value.experienceDigests.length > 32) fail("evolution_skill_layer_invalid");
  for (const dependency of value.dependencies) {
    sha(dependency.packageDigest);
    if (!layers.includes(dependency.layer) || layers.indexOf(dependency.layer) <= layers.indexOf(value.layer)) fail("evolution_skill_layer_dependency_invalid");
  }
  value.experienceDigests.forEach(sha);
  if (new Set(value.dependencies.map(item => item.packageDigest)).size !== value.dependencies.length || new Set(value.experienceDigests).size !== value.experienceDigests.length) fail("evolution_skill_layer_duplicate");
  return freezeJson(value);
}
export function proposeStrategyGene(input: Omit<StrategyGene, "schemaVersion" | "digest" | "status">, experiences: readonly ExperienceEntry[], availableSkillDigests: readonly string[] = []): StrategyGene {
  if (Object.keys(input).some(key => !["id", "version", "scope", "applicability", "actions", "warnings", "experienceDigests", "skillDigests", "parentDigest"].includes(key)) || !/^[a-zA-Z0-9_.-]{1,128}$/u.test(input.id) || !Number.isSafeInteger(input.version) || input.version < 1 || text(input.scope).length > 4096) fail("evolution_gene_invalid");
  for (const values of [input.applicability, input.actions]) if (!Array.isArray(values) || !values.length || values.length > 8 || values.some(value => text(value).length > 500)) fail("evolution_gene_invalid");
  if (!Array.isArray(input.warnings) || input.warnings.length > 8 || input.warnings.some(row => [row.condition, row.avoid, row.instead].some(value => text(value).length > 500))) fail("evolution_gene_warning_invalid");
  if (!Array.isArray(input.experienceDigests) || !input.experienceDigests.length || input.experienceDigests.length > 32 || !Array.isArray(input.skillDigests) || input.skillDigests.length > 32) fail("evolution_gene_provenance_required");
  for (const key of input.experienceDigests) {
    sha(key); const experience = experiences.find(entry => entry.digest === key);
    if (!experience || validateExperience(experience).scope !== input.scope) fail("evolution_gene_provenance_missing");
  }
  for (const key of input.skillDigests) if (!availableSkillDigests.includes(sha(key))) fail("evolution_gene_skill_missing");
  if (input.parentDigest !== undefined) sha(input.parentDigest);
  if ((input.version > 1) !== (input.parentDigest !== undefined)) fail("evolution_gene_lineage_required");
  const body = { schemaVersion: 1 as const, ...input, status: "proposal" as const };
  if (JSON.stringify(body).length > 8000) fail("evolution_gene_compact_limit");
  return freezeJson({ ...body, digest: digest(body) });
}
/** Compact retrieval returns suggestions. It never activates a strategy or executes a Skill. */
export function retrieveStrategyGenes(genes: readonly StrategyGene[], input: { readonly scope: string; readonly query: string; readonly limit?: number }): readonly StrategyGene[] {
  const maximum = input.limit ?? 3;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20) fail("evolution_gene_retrieval_limit");
  const query = text(input.query).toLocaleLowerCase();
  return genes.filter(gene => gene.scope === input.scope).map(gene => {
    const { digest: key, ...body } = gene; if (digest(body) !== key || gene.status !== "proposal") fail("evolution_gene_digest_mismatch");
    const score = gene.applicability.filter(condition => query.includes(condition.toLocaleLowerCase())).length;
    return { gene, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.gene.digest.localeCompare(b.gene.digest)).slice(0, maximum).map(row => row.gene);
}
export function validateStrategyGene(value: unknown): StrategyGene {
  const row = object(value), { digest: key, status, schemaVersion, ...input } = row;
  if (schemaVersion !== 1 || status !== "proposal" || digest({ schemaVersion, ...input, status }) !== sha(key)) fail("evolution_gene_digest_mismatch");
  if (Object.keys(input).some(key => !["id", "version", "scope", "applicability", "actions", "warnings", "experienceDigests", "skillDigests", "parentDigest"].includes(key)) || !/^[a-zA-Z0-9_.-]{1,128}$/u.test(String(input.id)) || !Number.isSafeInteger(input.version) || Number(input.version) < 1 || text(input.scope).length > 4096 || JSON.stringify(row).length > 8100) fail("evolution_gene_invalid");
  for (const items of [input.applicability, input.actions]) if (!Array.isArray(items) || !items.length || items.length > 8 || items.some(value => text(value).length > 500)) fail("evolution_gene_invalid");
  if (!Array.isArray(input.warnings) || input.warnings.length > 8 || input.warnings.some(raw => { const row = object(raw); return Object.keys(row).some(key => !["condition", "avoid", "instead"].includes(key)) || [row.condition, row.avoid, row.instead].some(value => text(value).length > 500); })) fail("evolution_gene_warning_invalid");
  for (const refs of [input.experienceDigests, input.skillDigests]) { if (!Array.isArray(refs) || refs.length > 32 || new Set(refs).size !== refs.length) fail("evolution_gene_provenance_required"); refs.forEach(sha); }
  if (!(input.experienceDigests as unknown[]).length || (Number(input.version) > 1) !== (input.parentDigest !== undefined)) fail("evolution_gene_lineage_required");
  if (input.parentDigest !== undefined) sha(input.parentDigest);
  return freezeJson(row) as unknown as StrategyGene;
}
/** Immutable proposed genes share Wiki provenance; no active production-policy alias is created. */
export class StrategyGeneStore {
  private readonly genes: ProfileRecordStore<StrategyGene>;
  constructor(storage: StorageBackendResolver, backendId: string) { this.genes = new ProfileRecordStore(storage, backendId, "evolution/strategy-genes/v1", validateStrategyGene); }
  async propose(input: Parameters<typeof proposeStrategyGene>[0], experiences: readonly ExperienceEntry[], availableSkillDigests: readonly string[]) {
    const gene = proposeStrategyGene(input, experiences, availableSkillDigests);
    if (gene.parentDigest) { const parent = await this.genes.get(gene.parentDigest); if (!parent || parent.id !== gene.id || parent.scope !== gene.scope || gene.version !== parent.version + 1) fail("evolution_gene_parent_missing"); }
    return this.genes.create(gene.digest, validateStrategyGene(gene));
  }
  async list(scope: string) { return (await this.genes.list()).filter(gene => gene.scope === scope).sort((a, b) => a.digest.localeCompare(b.digest)); }
  async retrieve(input: Parameters<typeof retrieveStrategyGenes>[1]) { return retrieveStrategyGenes(await this.list(input.scope), input); }
}
