import { content, hash, identity, text, version } from "../validation.js";
import type { MemoryContent } from "../types.js";
import type { CurationEvidence, CurationState } from "./types.js";

/** Visible clipping metadata; the original evidence reference/digest stays unchanged. */
export function clipEvidenceText(value: string, limit = 30_000): string {
  if (value.length <= limit) return value;
  const marker = `\n[TRUNCATED EVIDENCE: original ${value.length} characters; read the committed source references for complete facts.]`;
  return value.slice(0, Math.max(0, limit - marker.length)) + marker;
}

export function snapshotEvidence(input: CurationEvidence): CurationEvidence {
  if (!input || !["completed", "failed", "cancelled", "unknown"].includes(input.outcome)) throw new Error("Invalid curation evidence outcome");
  const body = content({ title: "Evidence", content: text(input.text, "evidence text", 32_000),
    appliesTo: input.appliesTo, keywords: [], evidence: input.references });
  return Object.freeze({ id: identity(input.id), sourceId: identity(input.sourceId), outcome: input.outcome,
    text: body.content, appliesTo: body.appliesTo, references: body.evidence,
    ...(input.sessionId === undefined ? {} : { sessionId: text(input.sessionId, "evidence sessionId") }),
    ...(input.runId === undefined ? {} : { runId: text(input.runId, "evidence runId") }) });
}
export function evidenceJobId(evidence: CurationEvidence): string { return `curation-${hash(snapshotEvidence(evidence))}`; }
export function snapshotCurationState(input: unknown): CurationState {
  const state = input as CurationState;
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.jobs) || state.jobs.length > 1000) throw new Error("Invalid curation state");
  const ids = new Set<string>();
  const jobs = state.jobs.map(job => {
    const evidence = snapshotEvidence(job.evidence);
    if (job.id !== evidenceJobId(evidence) || ids.has(job.id) || !["queued", "running", "proposing", "completed", "failed", "cancelled"].includes(job.status) ||
        !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt)) || !Array.isArray(job.candidateIds) || job.candidateIds.length > 8 ||
        (job.proposals !== undefined && (!Array.isArray(job.proposals) || job.proposals.length > 8)) ||
        ((job.status === "proposing" || job.status === "completed") && job.proposals === undefined)) throw new Error("Invalid curation job");
    ids.add(job.id);
    const proposals: readonly MemoryContent[] | undefined = job.proposals?.map(content);
    const references = new Set(evidence.references.map(reference => hash(reference)));
    if (proposals?.some(proposal => proposal.evidence.some(reference => !references.has(hash(reference))))) throw new Error("Curation proposal evidence does not match its captured source");
    if (job.candidateIds.length > (proposals?.length ?? 0) || (job.status === "completed" && job.candidateIds.length !== proposals?.length)) throw new Error("Invalid curation proposal progress");
    return Object.freeze({ id: job.id, evidence, status: job.status, attempts: version(job.attempts), createdAt: job.createdAt, updatedAt: job.updatedAt,
      candidateIds: Object.freeze(job.candidateIds.map(identity)), ...(proposals === undefined ? {} : { proposals: Object.freeze(proposals) }),
      ...(job.error === undefined ? {} : { error: text(job.error, "curation error", 2000) }) });
  });
  return Object.freeze({ schemaVersion: 1, libraryId: identity(state.libraryId), revision: version(state.revision), jobs: Object.freeze(jobs) });
}
