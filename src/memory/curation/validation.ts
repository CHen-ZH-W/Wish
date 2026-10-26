import type { MemoryContent } from "../types.js";
import { content, hash, identity, memoryPath, text, version } from "../validation.js";
import type { ConsolidationInput, ConsolidationPlan, CurationEvidence, CurationState, ExtractedMemory, MemoryChanges } from "./types.js";

export function snapshotEvidence(input: CurationEvidence): CurationEvidence {
  if (!input || !["completed", "failed", "cancelled", "unknown"].includes(input.outcome)) throw new Error("Invalid curation evidence outcome");
  if (input.occurredAt !== undefined && !Number.isFinite(Date.parse(input.occurredAt))) throw new Error("Invalid curation evidence time");
  const body = content({ title: "Evidence", content: text(input.text, "evidence text", Infinity),
    appliesTo: input.appliesTo, keywords: [], evidence: input.references });
  return Object.freeze({ id: identity(input.id), sourceId: identity(input.sourceId), outcome: input.outcome,
    text: body.content, appliesTo: body.appliesTo, references: body.evidence,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.sessionId === undefined ? {} : { sessionId: text(input.sessionId, "evidence sessionId") }),
    ...(input.runId === undefined ? {} : { runId: text(input.runId, "evidence runId") }) });
}
export function evidenceJobId(evidence: CurationEvidence): string {
  const { occurredAt: _occurredAt, ...identity } = snapshotEvidence(evidence);
  return `curation-${hash(identity)}`;
}
export function snapshotChanges(value: MemoryChanges): MemoryChanges {
  if (!value || !Array.isArray(value.upserts) || !Array.isArray(value.retirements)) throw new Error("Invalid memory consolidation changes");
  const upserts = value.upserts.map(item => Object.freeze({ ...content(item), id: identity(item.id), expectedVersion: version(item.expectedVersion) }));
  const retirements = value.retirements.map(item => Object.freeze({ id: identity(item.id), expectedVersion: version(item.expectedVersion),
    ...(item.supersededBy === undefined ? {} : { supersededBy: identity(item.supersededBy) }) }));
  const ids = [...upserts, ...retirements].map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate consolidation target");
  if (value.files !== undefined && (!value.files || typeof value.files !== "object" || Array.isArray(value.files))) throw new Error("Invalid workspace artifacts");
  const files = value.files === undefined ? undefined : Object.fromEntries(Object.entries(value.files).map(([path, body]) => {
    memoryPath(path); if (typeof body !== "string" || body.includes("\0")) throw new Error("Invalid workspace artifact"); return [path, body];
  }));
  if (value.workspaceBefore !== undefined && (!value.workspaceBefore || typeof value.workspaceBefore !== "object" || Array.isArray(value.workspaceBefore))) throw new Error("Invalid workspace baseline");
  const workspaceBefore = value.workspaceBefore === undefined ? undefined : Object.fromEntries(Object.entries(value.workspaceBefore).map(([path, body]) => {
    memoryPath(path); if (typeof body !== "string" || body.includes("\0")) throw new Error("Invalid workspace baseline"); return [path, body];
  }));
  return Object.freeze({ upserts: Object.freeze(upserts), retirements: Object.freeze(retirements), ...(files === undefined ? {} : { files: Object.freeze(files) }),
    ...(workspaceBefore === undefined ? {} : { workspaceBefore: Object.freeze(workspaceBefore) }) });
}
export function validateConsolidation(value: MemoryChanges, input: ConsolidationInput): MemoryChanges {
  const changes = snapshotChanges(value);
  const documents = new Map(input.documents.map(item => [item.id, item]));
  const references = new Set([...input.rawMemories, ...input.documents].flatMap(item => item.evidence.map(reference => hash(reference))));
  for (const item of changes.upserts) {
    if (item.expectedVersion !== (documents.get(item.id)?.version ?? 0)) throw new Error("Consolidator invented a document version");
    if (item.evidence.some(reference => !references.has(hash(reference)))) throw new Error("Consolidator invented evidence references");
  }
  for (const item of changes.retirements) {
    if (!documents.has(item.id) || item.expectedVersion !== documents.get(item.id)!.version) throw new Error("Consolidator invented a retirement target");
    if (item.supersededBy && (item.id === item.supersededBy || changes.retirements.some(other => other.id === item.supersededBy) ||
        (!documents.has(item.supersededBy) && !changes.upserts.some(other => other.id === item.supersededBy)))) throw new Error("Invalid consolidation replacement");
  }
  if (changes.files) {
    const final = new Map(input.documents.filter(item => item.status === "accepted" && item.path).map(item => [item.id, item]));
    for (const item of changes.retirements) final.delete(item.id);
    for (const item of changes.upserts) if (item.path) final.set(item.id, { ...item, version: item.expectedVersion + 1, status: "accepted", digest: hash(content(item)), updatedAt: "" });
    const byPath = new Map([...final.values()].map(item => [item.path!, item.content]));
    if (byPath.size !== final.size || byPath.size !== Object.keys(changes.files).length || Object.entries(changes.files).some(([path, body]) => byPath.get(path) !== body)) throw new Error("Workspace files do not match consolidated documents");
  }
  return changes;
}
export function snapshotPlan(plan: ConsolidationPlan): ConsolidationPlan {
  if (!Array.isArray(plan.jobIds) || new Set(plan.jobIds).size !== plan.jobIds.length) throw new Error("Invalid consolidation inputs");
  return Object.freeze({ ...snapshotChanges(plan), operationId: text(plan.operationId, "consolidation operationId", 256),
    jobIds: Object.freeze(plan.jobIds.map(identity)), expectedRevision: version(plan.expectedRevision),
    ...(plan.inputDigest === undefined ? {} : { inputDigest: text(plan.inputDigest, "inputDigest") }),
    ...(plan.workspaceFingerprint === undefined ? {} : { workspaceFingerprint: text(plan.workspaceFingerprint, "workspaceFingerprint") }) });
}
export function snapshotCurationState(input: unknown): CurationState {
  const state = input as CurationState;
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.jobs)) throw new Error("Invalid curation state");
  const ids = new Set<string>();
  const jobs = state.jobs.map(job => {
    const evidence = snapshotEvidence(job.evidence);
    if (job.id !== evidenceJobId(evidence) || ids.has(job.id) || !["queued", "running", "extracted", "consolidating", "proposing", "completed", "failed", "cancelled"].includes(job.status) ||
        !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt)) || !Array.isArray(job.candidateIds)) throw new Error("Invalid curation job");
    ids.add(job.id);
    const raw = job.rawMemories ?? job.proposals;
    if (raw !== undefined && !Array.isArray(raw)) throw new Error("Invalid raw memories");
    if (["extracted", "consolidating", "proposing", "completed"].includes(job.status) && raw === undefined) throw new Error("Missing raw memories");
    const rawMemories: readonly ExtractedMemory[] | undefined = raw?.map(snapshotRawMemory);
    const references = new Set(evidence.references.map(reference => hash(reference)));
    if (rawMemories?.some(item => item.evidence.some(reference => !references.has(hash(reference))))) throw new Error("Raw memory evidence does not match its captured source");
    return Object.freeze({ id: job.id, evidence, status: job.status, attempts: version(job.attempts), createdAt: job.createdAt, updatedAt: job.updatedAt,
      candidateIds: Object.freeze(job.candidateIds.map(identity)),
      ...(rawMemories === undefined ? {} : { rawMemories: Object.freeze(rawMemories) }),
      ...(job.documentIds === undefined ? {} : { documentIds: Object.freeze(job.documentIds.map(identity)) }),
      ...(job.usageCount === undefined ? {} : { usageCount: version(job.usageCount) }),
      ...(job.lastUsedAt === undefined ? {} : { lastUsedAt: checkedDate(job.lastUsedAt) }),
      ...(job.error === undefined ? {} : { error: text(job.error, "curation error", Infinity) }) });
  });
  const consolidation = state.consolidation === undefined ? undefined : snapshotPlan(state.consolidation);
  if (consolidation?.jobIds.some(id => !ids.has(id))) throw new Error("Unknown consolidation job");
  return Object.freeze({ schemaVersion: 1, libraryId: identity(state.libraryId), revision: version(state.revision), jobs: Object.freeze(jobs),
    ...(consolidation === undefined ? {} : { consolidation }),
    ...(state.inputDigest === undefined ? {} : { inputDigest: text(state.inputDigest, "inputDigest") }),
    ...(state.libraryRevision === undefined ? {} : { libraryRevision: version(state.libraryRevision) }),
    ...(state.retiredEvidenceIds === undefined ? {} : { retiredEvidenceIds: Object.freeze(state.retiredEvidenceIds.map(identity)) }),
    ...(state.selectedJobIds === undefined ? {} : { selectedJobIds: Object.freeze(state.selectedJobIds.map(identity)) }) });
}

export function snapshotRawMemory(item: ExtractedMemory): ExtractedMemory {
  return Object.freeze({ ...content(item), ...(item.rolloutSummary === undefined ? {} : { rolloutSummary: text(item.rolloutSummary, "rollout summary", Infinity) }),
    ...(item.rolloutSlug === undefined ? {} : { rolloutSlug: typeof item.rolloutSlug === "string" ? item.rolloutSlug : (() => { throw new Error("Invalid rollout slug"); })() }) });
}
function checkedDate(value: string): string { if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid memory usage date"); return value; }
