import { digest, freezeJson } from "../agent-profiles/validation.js";
import { ProfileRecordStore } from "../agent-profiles/store.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { object, sha, text, fail } from "./validation.js";
import { validateTrace, type TraceRecord } from "./observations.js";
import type { MemoryCurationService } from "../memory/curation/service.js";

export interface ExperienceEvidence {
  readonly traceId: string; readonly traceDigest: string; readonly taskId: string;
  readonly outcome: "passed" | "failed" | "unknown"; readonly refs: readonly string[];
}
export interface ExperienceEntry {
  readonly schemaVersion: 1; readonly id: string; readonly digest: string;
  readonly scope: string; readonly topic: string; readonly claim: string;
  readonly conditions: readonly string[]; readonly actions: readonly string[]; readonly warnings: readonly string[];
  readonly evidence: readonly ExperienceEvidence[];
  /** An observed outcome does not establish that a proposed strategy caused it. */
  readonly status: "hypothesis"; readonly contradicts: readonly string[];
}
export interface ExperienceReview {
  readonly schemaVersion: 1; readonly digest: string; readonly subjectDigest: string;
  readonly decision: "accepted" | "rejected"; readonly actorId: string; readonly reason: string;
}
export interface ExperienceDraft {
  readonly scope: string; readonly topic: string; readonly claim: string;
  readonly conditions: readonly string[]; readonly actions: readonly string[]; readonly warnings: readonly string[];
  readonly traceIds: readonly string[]; readonly contradicts?: readonly string[];
}
function phrases(value: unknown, maximum = 16): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || new Set(value).size !== value.length || value.some(item => text(item).length > 1000)) fail("evolution_experience_invalid_phrases");
  return value;
}
export function createExperience(draft: ExperienceDraft, traces: readonly TraceRecord[]): ExperienceEntry {
  if (Object.keys(draft).some(key => !["scope", "topic", "claim", "conditions", "actions", "warnings", "traceIds", "contradicts"].includes(key))) fail("evolution_experience_untrusted_status");
  if (text(draft.scope).length > 4096 || text(draft.topic).length > 500 || text(draft.claim).length > 4000 || !draft.traceIds.length || draft.traceIds.length > 100 || new Set(draft.traceIds).size !== draft.traceIds.length) fail("evolution_experience_invalid");
  const evidence = [...draft.traceIds].sort().map(id => {
    const trace = traces.find(item => item.id === id);
    if (!trace) fail("evolution_experience_evidence_missing");
    const row = validateTrace(trace);
    if (["held-out", "evolution"].includes(row.sourceKind)) fail("evolution_experience_partition_forbidden");
    return { traceId: row.id, traceDigest: row.digest, taskId: row.taskId, outcome: row.taskOutcome, refs: row.evidenceRefs };
  });
  const contradicts = [...(draft.contradicts ?? [])].sort(); contradicts.forEach(sha);
  if (contradicts.length > 32 || new Set(contradicts).size !== contradicts.length) fail("evolution_experience_invalid");
  const body = { schemaVersion: 1 as const, scope: draft.scope, topic: draft.topic, claim: draft.claim,
    conditions: phrases(draft.conditions), actions: phrases(draft.actions), warnings: phrases(draft.warnings), evidence,
    status: "hypothesis" as const, contradicts };
  const key = digest(body); return freezeJson({ ...body, id: `experience-${key}`, digest: key });
}
export function validateExperience(value: unknown): ExperienceEntry {
  const row = object(value);
  if (row.schemaVersion !== 1 || row.status !== "hypothesis" || !Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > 100 || text(row.scope).length > 4096 || text(row.topic).length > 500 || text(row.claim).length > 4000) fail("evolution_experience_invalid");
  phrases(row.conditions); phrases(row.actions); phrases(row.warnings); phrases(row.contradicts, 32).forEach(sha);
  for (const raw of row.evidence) {
    const evidence = object(raw); text(evidence.traceId); sha(evidence.traceDigest); text(evidence.taskId); phrases(evidence.refs, 4096);
    if (!["passed", "failed", "unknown"].includes(String(evidence.outcome))) fail("evolution_experience_invalid");
  }
  const { id, digest: key, ...body } = row;
  if (sha(key) !== digest(body) || id !== `experience-${key}`) fail("evolution_experience_digest_mismatch");
  return freezeJson(row) as unknown as ExperienceEntry;
}
function review(value: unknown): ExperienceReview {
  const row = object(value); sha(row.subjectDigest); text(row.actorId); text(row.reason);
  const { digest: key, ...body } = row;
  if (row.schemaVersion !== 1 || !["accepted", "rejected"].includes(String(row.decision)) || digest(body) !== sha(key)) fail("evolution_experience_review_invalid");
  return freezeJson(row) as unknown as ExperienceReview;
}
/** Append-only research Wiki. Rejecting a proposal never deletes the observations that inspired it. */
export class ExperienceWiki {
  private readonly entries: ProfileRecordStore<ExperienceEntry>;
  private readonly reviews: ProfileRecordStore<ExperienceReview>;
  constructor(storage: StorageBackendResolver, backendId: string) {
    this.entries = new ProfileRecordStore(storage, backendId, "evolution/experience/v1", validateExperience);
    this.reviews = new ProfileRecordStore(storage, backendId, "evolution/experience-reviews/v1", review);
  }
  async record(draft: ExperienceDraft, traces: readonly TraceRecord[]) {
    const entry = createExperience(draft, traces);
    for (const key of entry.contradicts) { const prior = await this.entries.get(key); if (!prior || prior.scope !== entry.scope) fail("evolution_experience_contradiction_missing"); }
    return this.entries.create(entry.digest, entry);
  }
  async get(key: string) { sha(key); return this.entries.get(key); }
  async list(scope?: string) { return (await this.entries.list()).filter(entry => scope === undefined || entry.scope === scope).sort((a, b) => a.digest.localeCompare(b.digest)); }
  async inspect(scope: string) {
    const entries = await this.list(scope), reviews = await this.reviews.list();
    return entries.map(entry => ({ entry, reviews: reviews.filter(item => item.subjectDigest === entry.digest),
      contradictions: entries.filter(item => item.contradicts.includes(entry.digest) || entry.contradicts.includes(item.digest)).map(item => item.digest) }));
  }
  /** Trusted operator adapter only. No automatic acceptance from Run status or model text. */
  async review(input: { readonly subjectDigest: string; readonly decision: "accepted" | "rejected"; readonly actorId: string; readonly reason: string }) {
    if (!await this.get(input.subjectDigest)) fail("evolution_experience_missing");
    const body = { schemaVersion: 1 as const, ...input }, value = review({ ...body, digest: digest(body) });
    return this.reviews.create(value.digest, value);
  }
  /** Compatibility method name; transfers evidence to automatic Memory consolidation. */
  async proposeMemory(memory: Pick<MemoryCurationService, "addNote">, input: { readonly subjectDigest: string; readonly operationId: string; readonly targetId?: string; readonly expectedDocumentVersion?: number; readonly actorId?: string }) {
    const entry = await this.get(input.subjectDigest); if (!entry) fail("evolution_experience_missing");
    const reviews = (await this.reviews.list()).filter(item => item.subjectDigest === entry.digest);
    const contradictions = (await this.inspect(entry.scope)).find(item => item.entry.digest === entry.digest)?.contradictions ?? [];
    return memory.addNote({ operationId: input.operationId, appliesTo: entry.scope,
      text: "Research experience to integrate as evidence, not a proven strategy or an instruction to publish code. Preserve uncertainty, reviews and contradictions.\n" + JSON.stringify({ entry, reviews, contradictions }),
      evidence: [{ kind: "operator", id: entry.id, revision: "1", digest: entry.digest }] });
  }
}
