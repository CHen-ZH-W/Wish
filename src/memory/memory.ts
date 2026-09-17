import type { ChangeMemoryStatusRequest, DecideMemoryRequest, Memory, MemoryAudit, MemoryCandidate, MemoryDocument, MemoryOperation, MemoryQuery, MemoryState, MemoryStateStore, ProposeMemoryRequest } from "./types.js";
import { actor, candidate, content, document, hash, identity, snapshotState, text, version } from "./validation.js";
import { retrieve } from "./retrieval.js";

/** Domain authority. Only explicit human decisions can publish persistent knowledge. */
export class MemoryRuntime implements Memory {
  readonly libraryId: string;
  private tail = Promise.resolve();
  private closed = false;
  constructor(private readonly store: MemoryStateStore, private readonly now: () => Date = () => new Date()) { this.libraryId = store.libraryId; }
  async state(signal?: AbortSignal) { this.assertOpen(); return this.store.read(signal); }
  async read(id: string, signal?: AbortSignal) { identity(id); return (await this.state(signal)).documents.find(item => item.id === id); }
  async query(input: MemoryQuery = {}) { return retrieve((await this.state(input.signal)).documents, input); }
  async snapshot(input: MemoryQuery = {}) {
    const state = await this.state(input.signal);
    return Object.freeze({ schemaVersion: 1 as const, libraryId: this.libraryId, revision: state.revision, documents: retrieve(state.documents, input) });
  }
  propose(input: ProposeMemoryRequest): Promise<MemoryCandidate> {
    const operation = normalizeOperation(input), body = content(input), targetId = identity(input.targetId), expectedDocumentVersion = version(input.expectedDocumentVersion);
    const reviewSessionId = input.reviewSessionId === undefined ? undefined : text(input.reviewSessionId, "reviewSessionId");
    const review = reviewSessionId === undefined ? {} : { reviewSessionId };
    const requestDigest = hash({ ...operation, body, targetId, expectedDocumentVersion, ...review });
    return this.transact(input.signal, state => {
      const replay = receipt(state, operation.operationId, requestDigest);
      if (replay) return { result: state.candidates.find(item => item.id === replay.targetId)! };
      if ((state.documents.find(item => item.id === targetId)?.version ?? 0) !== expectedDocumentVersion) throw new Error("Memory document version conflict");
      const at = this.now().toISOString();
      const item = candidate({ ...body, ...review, id: `candidate-${hash(operation.operationId).slice(0, 32)}`, version: 1, status: "pending", targetId, expectedDocumentVersion, actor: operation.actor, reason: operation.reason, createdAt: at });
      return { result: item, state: commitState(state, { ...state, candidates: [...state.candidates, item] }, { ...operation, requestDigest, action: "propose", targetId: item.id, at }) };
    });
  }
  decide(input: DecideMemoryRequest): Promise<MemoryCandidate> {
    const operation = normalizeOperation(input), candidateId = identity(input.candidateId), expectedCandidateVersion = version(input.expectedCandidateVersion);
    if (operation.actor.kind !== "human") throw new Error("Only a human decision can accept or reject Memory candidates");
    if (input.decision !== "accept" && input.decision !== "reject") throw new TypeError("Invalid Memory decision");
    const requestDigest = hash({ ...operation, candidateId, expectedCandidateVersion, decision: input.decision });
    return this.transact(input.signal, state => {
      const replay = receipt(state, operation.operationId, requestDigest);
      if (replay) return { result: state.candidates.find(item => item.id === replay.targetId)! };
      const current = state.candidates.find(item => item.id === candidateId);
      if (!current || current.version !== expectedCandidateVersion || current.status !== "pending") throw new Error("Memory candidate version conflict");
      const at = this.now().toISOString(), accepted = input.decision === "accept";
      const next = candidate({ ...current, version: current.version + 1, status: accepted ? "accepted" : "rejected", decidedAt: at });
      let documents = state.documents;
      if (accepted) {
        const previous = documents.find(item => item.id === current.targetId);
        if ((previous?.version ?? 0) !== current.expectedDocumentVersion) throw new Error("Memory target changed since proposal; review a new candidate");
        const body = content(current);
        const saved = document({ ...body, id: current.targetId, version: current.expectedDocumentVersion + 1, status: "accepted", digest: hash(body), updatedAt: at });
        documents = [...documents.filter(item => item.id !== saved.id), saved];
      }
      return { result: next, state: commitState(state, { ...state, documents, candidates: state.candidates.map(item => item.id === next.id ? next : item) }, { ...operation, requestDigest, action: input.decision, targetId: next.id, at }) };
    });
  }
  changeStatus(input: ChangeMemoryStatusRequest): Promise<MemoryDocument> {
    const operation = normalizeOperation(input), id = identity(input.id), expectedVersion = version(input.expectedVersion);
    if (operation.actor.kind !== "human") throw new Error("Only a human decision can change accepted Memory status");
    if (!["stale", "superseded", "deleted"].includes(input.status)) throw new TypeError("Invalid Memory status transition");
    const supersededBy = input.supersededBy === undefined ? undefined : identity(input.supersededBy);
    if ((input.status === "superseded") !== (supersededBy !== undefined)) throw new TypeError("Supersession requires an exact replacement");
    const requestDigest = hash({ ...operation, id, expectedVersion, status: input.status, supersededBy });
    return this.transact(input.signal, state => {
      const replay = receipt(state, operation.operationId, requestDigest);
      if (replay) return { result: state.documents.find(item => item.id === replay.targetId)! };
      const current = state.documents.find(item => item.id === id);
      if (!current || current.version !== expectedVersion || current.status === "deleted") throw new Error("Memory document version conflict");
      if (supersededBy !== undefined && (supersededBy === id || !state.documents.some(item => item.id === supersededBy && item.status === "accepted"))) throw new Error("Memory replacement must be another accepted document");
      const at = this.now().toISOString();
      const next = document({ ...content(current), id, digest: current.digest, version: current.version + 1, status: input.status, updatedAt: at, ...(supersededBy === undefined ? {} : { supersededBy }) });
      return { result: next, state: commitState(state, { ...state, documents: state.documents.map(item => item.id === id ? next : item) }, { ...operation, requestDigest, action: "status", targetId: id, at }) };
    });
  }
  async close() { this.closed = true; await this.tail; await this.store.close(); }
  private assertOpen() { if (this.closed) throw new Error("Memory is closed"); }
  private transact<T>(signal: AbortSignal | undefined, update: (state: MemoryState) => { result: T; state?: MemoryState }): Promise<T> {
    this.assertOpen();
    const operation = this.tail.then(async () => {
      signal?.throwIfAborted();
      const state = await this.store.read(signal), changed = update(state);
      if (changed.state) await this.store.commit(changed.state, state.revision, signal);
      return changed.result;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
function normalizeOperation(input: MemoryOperation) { return Object.freeze({ operationId: text(input.operationId, "operationId", 256), actor: actor(input.actor), reason: text(input.reason, "reason", 2000) }); }
function receipt(state: MemoryState, operationId: string, requestDigest: string) {
  const audit = state.audit.find(item => item.operationId === operationId);
  if (audit && audit.requestDigest !== requestDigest) throw new Error("Memory idempotency conflict");
  return audit;
}
function commitState(before: MemoryState, after: MemoryState, audit: Omit<MemoryAudit, "revision">): MemoryState {
  return snapshotState({ ...after, revision: before.revision + 1, audit: [...before.audit, { ...audit, revision: before.revision + 1 }] });
}
