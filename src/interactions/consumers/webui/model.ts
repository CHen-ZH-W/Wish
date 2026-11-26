import type { FeaturesClientModel } from "../../../apps/webui/client/model/features.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import type { ToolExecutionEvent } from "../../../core/tools/executor.js";
import type { ConversationInteraction, InteractionAnswer, InteractionState } from "../../types.js";

export const INTERACTION_VIEW = "conversation-interactions";
export interface InteractionDraft { readonly optionIds: readonly string[]; readonly text: string }
function questionCall(call: { readonly name: string }): boolean {
  return call.name === "ask_user";
}
/** Module-owned drafts survive navigation and UI remounts; Host owns submitted answers. */
export class InteractionClientModel extends SnapshotStore<readonly LedgerBlock[]> {
  private readonly remove: Array<() => void>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly drafts = new Map<string, Readonly<Record<string, InteractionDraft>>>();
  private readonly draftListeners = new Set<() => void>();
  private readonly emptyDraft = Object.freeze({});
  private lastData: unknown;
  private lastSession: string | null = null;
  private toolState = "";
  constructor(readonly features: FeaturesClientModel, readonly sessions: SessionClientModel) {
    super(Object.freeze([]));
    this.remove = [features.subscribe(this.sync), sessions.subscribe(this.sync), sessions.run.subscribe(() => {
      const run = sessions.run.getSnapshot();
      const state = [run.runId, ...run.events.filter(e => e.type === "tool.lifecycle" && e.runId === run.runId && questionCall(e.payload.call)).map(e => e.eventId)].join("/");
      if (state !== this.toolState) { this.toolState = state; void features.refresh(); }
    })];
    this.timer = setInterval(() => {
      const run = sessions.run.getSnapshot();
      if (run.terminal) return;
      const recorded = new Set(this.getSnapshot().map(block => (block.data as ConversationInteraction).toolCallId));
      const latest = new Map<string, ToolExecutionEvent>();
      for (const event of run.events) if (event.type === "tool.lifecycle" && event.runId === run.runId) latest.set(event.payload.call.id, event.payload);
      if ([...latest.values()].some(event => event.type === "tool.dispatched" && questionCall(event.call) && !recorded.has(event.call.id))) void features.poll();
    }, 500);
    this.sync(); void features.poll();
  }
  private readonly sync = () => {
    const selected = this.sessions.getSnapshot().selectedId, feature = this.features.getSnapshot();
    const data = feature.sessionId === selected ? feature.views.find(v => v.key === INTERACTION_VIEW)?.data as InteractionState | undefined : undefined;
    if (data === this.lastData && selected === this.lastSession) return;
    this.lastData = data; this.lastSession = selected;
    const requests = data?.schemaVersion === 1 && data.sessionId === selected && Array.isArray(data.requests) ? data.requests : [];
    this.publish(Object.freeze(requests.map(request => Object.freeze({ id: `interaction:${request.id}`, turnId: `${request.runId}/${request.userTurnId}`, stepId: request.stepId, runId: request.runId,
      time: request.createdAt, kind: "system" as const, title: request.title, text: request.title, viewId: INTERACTION_VIEW, status: request.status === "pending" ? "waiting-input" : request.status, data: request }))));
    for (const request of requests) if (request.status !== "pending") this.clearDraft(request.id);
  };
  canRespond(request: ConversationInteraction): boolean {
    const selected = this.sessions.getSnapshot(), feature = this.features.getSnapshot();
    const state = feature.views.find(v => v.key === INTERACTION_VIEW)?.data as InteractionState | undefined;
    return feature.available && !feature.pending && selected.available && !selected.working && selected.selectedId === request.sessionId && feature.sessionId === request.sessionId
      && selected.sessions.some(s => s.sessionId === request.sessionId && s.status === "active") && request.status === "pending"
      && !!state?.requests.some(r => r.id === request.id && r.status === "pending" && r.revision === request.revision);
  }
  async respond(request: ConversationInteraction, response: { readonly answers?: readonly InteractionAnswer[]; readonly dismiss?: boolean }) {
    if (!this.canRespond(request)) throw new Error("interaction_unavailable");
    const view = this.features.getSnapshot().views.find(v => v.key === INTERACTION_VIEW)!;
    await this.features.act(request.sessionId, view, "respond", JSON.stringify({ requestId: request.id, revision: request.revision, ...response }));
    this.clearDraft(request.id);
  }
  readonly subscribeDrafts = (listener: () => void) => { this.draftListeners.add(listener); return () => { this.draftListeners.delete(listener); }; };
  draft = (id: string): Readonly<Record<string, InteractionDraft>> => {
    if (this.drafts.has(id)) return this.drafts.get(id)!;
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(`wish.interaction.draft:${id}`) ?? "null");
      if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => v && typeof v === "object" && Array.isArray(v.optionIds) && v.optionIds.every((s: unknown) => typeof s === "string") && typeof v.text === "string")) {
        const draft = Object.freeze(value as Record<string, InteractionDraft>); this.drafts.set(id, draft); return draft;
      }
    } catch { /* Storage can be unavailable; in-memory drafts still work. */ }
    return this.emptyDraft;
  };
  updateDraft(id: string, questionId: string, value: InteractionDraft) {
    this.drafts.set(id, Object.freeze({ ...this.draft(id), [questionId]: Object.freeze(value) }));
    try { sessionStorage.setItem(`wish.interaction.draft:${id}`, JSON.stringify(this.drafts.get(id))); } catch { /* Keep the in-memory draft. */ }
    for (const listener of this.draftListeners) listener();
  }
  private clearDraft(id: string) {
    try { sessionStorage.removeItem(`wish.interaction.draft:${id}`); } catch { /* Optional draft persistence. */ }
    if (this.drafts.delete(id)) for (const listener of this.draftListeners) listener();
  }
  close() { for (const remove of this.remove) remove(); clearInterval(this.timer); this.draftListeners.clear(); this.drafts.clear(); }
}
