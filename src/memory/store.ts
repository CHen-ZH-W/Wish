import type { Journal, JournalEntry } from "../storage/journal.js";
import { JOURNAL_ANY } from "../storage/journal.js";
import type { MemoryAudit, MemoryCandidate, MemoryDocument, MemoryState, MemoryStateStore } from "./types.js";
import { candidate, content, emptyState, hash, identity, snapshotState } from "./validation.js";

const tails = new WeakMap<Journal, Promise<void>>();
interface MemoryJournalChange {
  readonly schemaVersion: 1;
  readonly libraryId: string;
  readonly revision: number;
  readonly document?: MemoryDocument;
  readonly candidate?: MemoryCandidate;
  readonly audit: MemoryAudit;
}
/** The Journal owns durable commits; each entry commits a change and its audit together. */
export class JournalMemoryStore implements MemoryStateStore {
  readonly libraryId: string;
  private closed = false;
  constructor(private readonly journal: Journal, libraryId = "default") { this.libraryId = identity(libraryId); }
  async read(signal?: AbortSignal): Promise<MemoryState> {
    this.assertOpen();
    return (await this.load(signal)).state;
  }
  commit(value: MemoryState, expectedRevision: number, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const state = snapshotState(value);
    const previous = tails.get(this.journal) ?? Promise.resolve();
    const work = previous.then(async () => {
      this.assertOpen(); signal?.throwIfAborted();
      const loaded = await this.load(signal);
      if (loaded.state.revision !== expectedRevision || state.revision !== expectedRevision + 1 || state.libraryId !== this.libraryId) throw new Error("Memory store revision conflict");
      // Audit prefixes cannot be rewritten; all mutations have exactly one new receipt.
      if (JSON.stringify(state.audit.slice(0, -1)) !== JSON.stringify(loaded.state.audit)) throw new Error("Memory audit history is immutable");
      const audit = state.audit.at(-1)!;
      const documents = state.documents.filter(item => JSON.stringify(item) !== JSON.stringify(loaded.state.documents.find(old => old.id === item.id)));
      const candidates = state.candidates.filter(item => JSON.stringify(item) !== JSON.stringify(loaded.state.candidates.find(old => old.id === item.id)));
      if (documents.length > 1 || candidates.length > 1 || loaded.state.documents.some(item => !state.documents.some(next => next.id === item.id)) || loaded.state.candidates.some(item => !state.candidates.some(next => next.id === item.id))) throw new Error("Memory commits must change one document/candidate without removing history");
      const change: MemoryJournalChange = { schemaVersion: 1, libraryId: this.libraryId, revision: state.revision,
        ...(documents[0] === undefined ? {} : { document: documents[0] }), ...(candidates[0] === undefined ? {} : { candidate: candidates[0] }), audit };
      validateChange(loaded.state, change);
      await this.journal.append({ idempotencyKey: `memory:${this.libraryId}:${audit.operationId}`, entries: [new TextEncoder().encode(JSON.stringify(change))] },
        loaded.last === undefined ? JOURNAL_ANY : { kind: "revision", revision: loaded.last.revision }, signal);
    });
    tails.set(this.journal, work.then(() => undefined, () => undefined));
    return work;
  }
  async close(): Promise<void> { this.closed = true; await tails.get(this.journal); }
  private assertOpen(): void { if (this.closed) throw new Error("Memory store is closed"); }
  private async load(signal?: AbortSignal): Promise<{ state: MemoryState; last?: JournalEntry }> {
    let state = emptyState(this.libraryId), last: JournalEntry | undefined;
    for await (const entry of this.journal.read({ ...(signal === undefined ? {} : { signal }) })) {
      const change = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.value)) as MemoryJournalChange;
      validateChange(state, change);
      const next = snapshotState({ ...state, revision: change.revision,
        documents: change.document === undefined ? state.documents : [...state.documents.filter(item => item.id !== change.document!.id), change.document],
        candidates: change.candidate === undefined ? state.candidates : [...state.candidates.filter(item => item.id !== change.candidate!.id), change.candidate],
        audit: [...state.audit, change.audit] });
      state = next; last = entry;
    }
    return { state, ...(last === undefined ? {} : { last }) };
  }
}

function validateChange(state: MemoryState, change: MemoryJournalChange): void {
  if (!change || change.schemaVersion !== 1 || change.libraryId !== state.libraryId || change.revision !== state.revision + 1 || change.audit?.revision !== change.revision) throw new Error("Memory Journal is corrupt");
  const doc = change.document, item = change.candidate, audit = change.audit;
  if (doc && doc.version !== (state.documents.find(old => old.id === doc.id)?.version ?? 0) + 1) throw new Error("Memory document revision is corrupt");
  if (item && item.version !== (state.candidates.find(old => old.id === item.id)?.version ?? 0) + 1) throw new Error("Memory candidate revision is corrupt");
  if (audit.action === "propose") {
    if (doc || !item || item.status !== "pending" || item.version !== 1 || item.id !== audit.targetId ||
        item.id !== `candidate-${hash(audit.operationId).slice(0, 32)}` || hash(item.actor) !== hash(audit.actor) || item.reason !== audit.reason || item.createdAt !== audit.at ||
        item.expectedDocumentVersion !== (state.documents.find(value => value.id === item.targetId)?.version ?? 0)) throw new Error("Invalid Memory proposal commit");
  } else if (audit.action === "accept" || audit.action === "reject") {
    const old = state.candidates.find(value => value.id === item?.id);
    if (audit.actor.kind !== "human" || !item || old?.status !== "pending" || item.id !== audit.targetId || item.status !== (audit.action === "accept" ? "accepted" : "rejected") ||
        (audit.action === "accept" ? !doc || doc.id !== item.targetId || doc.status !== "accepted" || doc.version !== item.expectedDocumentVersion + 1 : doc !== undefined)) throw new Error("Invalid Memory decision commit");
    if (hash(candidate(item)) !== hash(candidate({ ...old, version: item.version, status: item.status, ...(item.decidedAt === undefined ? {} : { decidedAt: item.decidedAt }) })) || item.decidedAt !== audit.at ||
        (doc && (hash(content(doc)) !== hash(content(item)) || doc.updatedAt !== audit.at))) throw new Error("Memory decision cannot rewrite the reviewed proposal");
  } else if (audit.action === "status") {
    if (audit.actor.kind !== "human" || item || !doc || doc.status === "accepted" || doc.id !== audit.targetId) throw new Error("Invalid Memory status commit");
    const old = state.documents.find(value => value.id === doc.id);
    if (!old || old.status === "deleted" || hash(content(old)) !== hash(content(doc)) || doc.updatedAt !== audit.at ||
        (doc.status === "superseded" && (doc.supersededBy === doc.id || !state.documents.some(value => value.id === doc.supersededBy && value.status === "accepted")))) throw new Error("Memory status cannot rewrite document content or history");
  } else throw new Error("Unknown Memory change");
}

export class InMemoryStateStore implements MemoryStateStore {
  private value: MemoryState;
  constructor(readonly libraryId = "default") { this.value = emptyState(libraryId); }
  async read(signal?: AbortSignal) { signal?.throwIfAborted(); return this.value; }
  async commit(state: MemoryState, expectedRevision: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.value.revision !== expectedRevision || state.revision !== expectedRevision + 1 || state.libraryId !== this.libraryId) throw new Error("Memory store revision conflict");
    this.value = snapshotState(state);
  }
  async close() {}
}
