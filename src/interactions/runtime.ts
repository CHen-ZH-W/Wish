import { createHash } from "node:crypto";
import type { ConversationInteraction, InteractionState, InteractionStore, OpenInteraction, RespondInteraction } from "./types.js";
import { answers, input, InteractionError, text } from "./validation.js";

/** Durable human choices; waiting consumes no model turns and has no interaction timeout. */
export class InteractionRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly stopped = new AbortController();
  private readonly listeners = new Map<string, Set<(request: ConversationInteraction) => void>>();
  constructor(private readonly store: InteractionStore) {}
  get waitingCount() { return this.listeners.size; }
  get(sessionId: string) { return this.store.get(text(sessionId)); }
  private edit<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new InteractionError("interaction_closed"));
    const pending = this.tail.then(action); this.tail = pending.catch(() => {}); return pending;
  }
  open(request: OpenInteraction): Promise<ConversationInteraction> {
    return this.edit(async () => {
      for (const value of [request.sessionId, request.runId, request.userTurnId, request.stepId, request.toolCallId]) text(value);
      const spec = input({ title: request.title, questions: request.questions, ...(request.description === undefined ? {} : { description: request.description }) });
      const id = createHash("sha256").update(JSON.stringify([request.sessionId, request.runId, request.toolCallId])).digest("hex");
      const current = await this.store.get(request.sessionId), existing = current?.requests.find(r => r.id === id);
      if (existing) {
        if (JSON.stringify({ title: existing.title, questions: existing.questions, ...(existing.description === undefined ? {} : { description: existing.description }) }) !== JSON.stringify(spec)) throw new InteractionError("interaction_identity_conflict");
        return existing;
      }
      const record: ConversationInteraction = Object.freeze({ ...request, ...spec, id, revision: 1, createdAt: new Date().toISOString(), status: "pending" });
      await this.store.put({ schemaVersion: 1, sessionId: request.sessionId, revision: (current?.revision ?? 0) + 1, requests: [...current?.requests ?? [], record] }, current?.revision ?? 0);
      return record;
    });
  }
  respond(sessionId: string, response: RespondInteraction): Promise<ConversationInteraction> {
    return this.edit(async () => {
      const current = await this.store.get(sessionId), request = current?.requests.find(r => r.id === response.requestId);
      if (!current || !request) throw new InteractionError("interaction_not_found");
      const result = response.dismiss ? undefined : answers(request, response.answers);
      if (request.status !== "pending") {
        if ((response.dismiss && request.status === "dismissed" || request.status === "answered" && !response.dismiss && JSON.stringify(request.answers) === JSON.stringify(result)) && response.revision === request.revision - 1) return request;
        throw new InteractionError("interaction_already_resolved");
      }
      if (response.revision !== request.revision) throw new InteractionError("interaction_conflict");
      const next: ConversationInteraction = Object.freeze({ ...request, revision: request.revision + 1, status: response.dismiss ? "dismissed" : "answered", resolvedAt: new Date().toISOString(), ...(result === undefined ? { reason: "user-dismissed" } : { answers: result }) });
      await this.store.put({ ...current, revision: current.revision + 1, requests: current.requests.map(r => r.id === request.id ? next : r) }, current.revision);
      this.notify(next); return next;
    });
  }
  interrupt(sessionId: string, reason: string, runId?: string): Promise<void> {
    return this.edit(async () => {
      const current = await this.store.get(sessionId); if (!current) return;
      const changed: ConversationInteraction[] = [];
      const requests = current.requests.map(r => {
        if (r.status !== "pending" || runId !== undefined && r.runId !== runId) return r;
        const next: ConversationInteraction = Object.freeze({ ...r, status: "interrupted", reason, resolvedAt: new Date().toISOString(), revision: r.revision + 1 }); changed.push(next); return next;
      });
      if (!changed.length) return;
      await this.store.put({ ...current, requests, revision: current.revision + 1 }, current.revision);
      for (const r of changed) this.notify(r);
    });
  }
  async wait(request: ConversationInteraction, signal?: AbortSignal): Promise<ConversationInteraction> {
    signal = signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const done = (value: ConversationInteraction) => { if (value.status === "pending") return; cleanup(); resolve(value); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      const cleanup = () => { signal?.removeEventListener("abort", abort); const set = this.listeners.get(request.id); set?.delete(done); if (!set?.size) this.listeners.delete(request.id); };
      const set = this.listeners.get(request.id) ?? new Set(); set.add(done); this.listeners.set(request.id, set);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (this.closed) { cleanup(); reject(new InteractionError("interaction_closed")); return; }
      void this.store.get(request.sessionId).then(state => {
        const current = state?.requests.find(r => r.id === request.id);
        if (current) done(current); else { cleanup(); reject(new InteractionError("interaction_not_found")); }
      }, error => { cleanup(); reject(error); });
    });
  }
  recover(): Promise<void> { return this.edit(async () => { for (const value of await this.store.list()) {
    const pending = value.requests.filter(r => r.status === "pending");
    if (pending.length) await this.store.put({ ...value, revision: value.revision + 1, requests: value.requests.map(r => r.status !== "pending" ? r : { ...r, status: "interrupted", reason: "host-restarted", resolvedAt: new Date().toISOString(), revision: r.revision + 1 }) }, value.revision);
  } }); }
  delete(sessionId: string): Promise<void> { return this.edit(async () => { const current = await this.store.get(sessionId); await this.store.delete(sessionId); for (const r of current?.requests ?? []) this.notify({ ...r, status: "interrupted", reason: "session-deleted" }); }); }
  private notify(request: ConversationInteraction) { for (const done of [...this.listeners.get(request.id) ?? []]) done(request); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.stopped.abort(new InteractionError("interaction_closed"));
    return this.closing = (async () => {
      await this.tail;
      for (const value of await this.store.list()) {
        const pending = value.requests.filter(r => r.status === "pending");
        if (!pending.length) continue;
        const requests = value.requests.map(r => r.status !== "pending" ? r : Object.freeze({ ...r, status: "interrupted" as const, reason: "module-closed", resolvedAt: new Date().toISOString(), revision: r.revision + 1 }));
        await this.store.put({ ...value, revision: value.revision + 1, requests }, value.revision);
        for (const request of requests) this.notify(request);
      }
    })();
  }
}
