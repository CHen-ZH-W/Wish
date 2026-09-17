import { createHash } from "node:crypto";
import type { MemoryActor, MemoryCandidate, MemoryContent, MemoryDocument, MemoryState } from "./types.js";

export function text(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new TypeError(`${label} must be non-empty text of at most ${max} characters`);
  return value;
}
export function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value)) throw new TypeError("Invalid Memory identity");
  return value;
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid Memory version");
  return value as number;
}
export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function actor(value: MemoryActor): MemoryActor {
  if (!value || !["human", "agent", "curation", "child"].includes(value.kind)) throw new TypeError("Invalid Memory actor");
  return Object.freeze({ kind: value.kind, id: text(value.id, "actor id"),
    ...(value.sessionId === undefined ? {} : { sessionId: text(value.sessionId, "sessionId") }),
    ...(value.runId === undefined ? {} : { runId: text(value.runId, "runId") }) });
}
export function content(value: MemoryContent): MemoryContent {
  if (!Array.isArray(value?.keywords) || value.keywords.length > 32 || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 32) throw new TypeError("Memory requires bounded keywords and at least one evidence reference");
  return Object.freeze({ title: text(value.title, "title", 200), content: text(value.content, "content", 32_000), appliesTo: text(value.appliesTo, "appliesTo", 1000),
    keywords: Object.freeze([...new Set(value.keywords.map(word => text(word, "keyword", 100)))]),
    evidence: Object.freeze(value.evidence.map(item => {
      if (!item || !["session", "workflow", "operator"].includes(item.kind) || !/^[a-f0-9]{64}$/u.test(item.digest)) throw new TypeError("Invalid Memory evidence");
      if (item.throughSequence !== undefined && (!version(item.throughSequence) || item.kind !== "session")) throw new TypeError("Invalid Memory evidence sequence");
      return Object.freeze({ kind: item.kind, id: text(item.id, "evidence id"), revision: text(item.revision, "evidence revision"), digest: item.digest,
        ...(item.throughSequence === undefined ? {} : { throughSequence: item.throughSequence }) });
    })),
  });
}
function date(value: string): string { if (!Number.isFinite(Date.parse(value))) throw new TypeError("Invalid Memory timestamp"); return value; }
export function document(value: MemoryDocument): MemoryDocument {
  const body = content(value);
  if (!version(value.version) || !["accepted", "stale", "superseded", "deleted"].includes(value.status) || value.digest !== hash(body)) throw new TypeError("Invalid Memory document");
  if ((value.status === "superseded") !== (value.supersededBy !== undefined)) throw new TypeError("Invalid Memory supersession");
  return Object.freeze({ ...body, id: identity(value.id), version: value.version, digest: value.digest, status: value.status, updatedAt: date(value.updatedAt),
    ...(value.supersededBy === undefined ? {} : { supersededBy: identity(value.supersededBy) }) });
}
export function candidate(value: MemoryCandidate): MemoryCandidate {
  if (!version(value.version) || !["pending", "accepted", "rejected"].includes(value.status) || ((value.status === "pending") !== (value.decidedAt === undefined))) throw new TypeError("Invalid Memory candidate");
  return Object.freeze({ ...content(value), id: identity(value.id), version: value.version, status: value.status, targetId: identity(value.targetId), expectedDocumentVersion: version(value.expectedDocumentVersion),
    actor: actor(value.actor), ...(value.reviewSessionId === undefined ? {} : { reviewSessionId: text(value.reviewSessionId, "reviewSessionId") }),
    reason: text(value.reason, "reason", 2000), createdAt: date(value.createdAt), ...(value.decidedAt === undefined ? {} : { decidedAt: date(value.decidedAt) }) });
}
export function emptyState(libraryId: string): MemoryState {
  return Object.freeze({ schemaVersion: 1, libraryId: identity(libraryId), revision: 0, documents: Object.freeze([]), candidates: Object.freeze([]), audit: Object.freeze([]) });
}
export function snapshotState(value: unknown): MemoryState {
  const state = value as MemoryState;
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.documents) || !Array.isArray(state.candidates) || !Array.isArray(state.audit)) throw new TypeError("Invalid Memory state");
  version(state.revision);
  if (state.documents.length > 1000 || state.candidates.length > 5000 || state.audit.length > 10_000 || state.audit.length !== state.revision) throw new TypeError("Memory state exceeds limits or has an incomplete audit");
  const documents = state.documents.map(document), candidates = state.candidates.map(candidate);
  if (new Set(documents.map(item => item.id)).size !== documents.length || new Set(candidates.map(item => item.id)).size !== candidates.length) throw new TypeError("Duplicate Memory identity");
  const operations = new Set<string>();
  const audit = state.audit.map((item, index) => {
    if (item.revision !== index + 1 || !["propose", "accept", "reject", "status"].includes(item.action) || !/^[a-f0-9]{64}$/u.test(item.requestDigest)) throw new TypeError("Invalid Memory audit");
    const operationId = text(item.operationId, "operationId", 256);
    if (operations.has(operationId)) throw new TypeError("Duplicate Memory operation");
    operations.add(operationId);
    return Object.freeze({ revision: item.revision, operationId, requestDigest: item.requestDigest, action: item.action, targetId: identity(item.targetId), actor: actor(item.actor), reason: text(item.reason, "reason", 2000), at: date(item.at) });
  });
  return Object.freeze({ schemaVersion: 1, libraryId: identity(state.libraryId), revision: state.revision, documents: Object.freeze(documents), candidates: Object.freeze(candidates), audit: Object.freeze(audit) });
}
