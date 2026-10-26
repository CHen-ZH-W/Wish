import { ClientApiError, type ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore, freezeWire } from "../../../apps/webui/client/model/store.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import type { SystemPromptSnapshot } from "../../history/types.js";
import type { SessionSystemPromptHistoryView } from "../webui-types.js";

export const SYSTEM_PROMPT_LEDGER_VIEW = "system-prompt-history";
const MAX_CACHED_SESSIONS = 6;
const MAX_EXPANDED_PROMPTS = 128;

export interface SystemPromptDisclosureState {
  readonly identity: string;
  readonly open: boolean;
  setOpen(open: boolean): void;
}
interface CachedPrompts { readonly snapshots: readonly SystemPromptSnapshot[]; readonly blocks: readonly LedgerBlock[] }

/** Browser projection of durable snapshots into generic conversation blocks. */
export class SystemPromptHistoryClientModel extends SnapshotStore<readonly LedgerBlock[]> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private sessionId: string | null = null;
  private observedKey = "";
  private instanceId: string | null = null;
  private readonly cached = new Map<string, CachedPrompts>();
  private readonly expanded = new Map<string, Set<string>>();
  private presentationEpoch = 0;
  private closed = false;

  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super(Object.freeze([]));
    this.queue = new RefreshQueue(async current => {
      const sessionId = this.sessionId;
      const instanceId = this.instanceId;
      if (!sessionId || !this.available()) return;
      const fresh = () => current() && this.available() && this.sessionId === sessionId && this.instanceId === instanceId;
      try {
        const response = freezeWire(await connection.request<{ value: SessionSystemPromptHistoryView }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/controls/system-prompt-history`,
        ));
        if (response.value.schemaVersion !== 1 || response.value.sessionId !== sessionId || !Array.isArray(response.value.snapshots) ||
          response.value.snapshots.some(snapshot => !validSnapshot(snapshot) || snapshot.sessionId !== sessionId)) throw new Error("系统提示词历史响应与当前会话不匹配");
        if (fresh()) {
          // The endpoint reads the complete journal, exposing the latest snapshot
          // per Run/Step. Reject missing Steps, but accept newer digests for a Step.
          const previous = this.cached.get(sessionId);
          const identities = new Set(response.value.snapshots.map(snapshotIdentity));
          if (previous?.snapshots.some(snapshot => !identities.has(snapshotIdentity(snapshot)))) return;
          const cached = previous && sameSnapshots(previous.snapshots, response.value.snapshots)
            ? previous : { snapshots: response.value.snapshots, blocks: projectSnapshots(response.value.snapshots) };
          this.remember(sessionId, cached); this.publish(cached.blocks);
        }
      } catch (error) {
        if (!fresh()) return;
        // A failed freshness read must not unmount a verified historical disclosure.
        // Explicit adapter/session loss still revokes its cached presentation.
        if (error instanceof ClientApiError && (error.status === 401 || error.status === 403 ||
          ["control_not_found", "business_unavailable", "management_closed", "connection_closed"].includes(error.code))) {
          this.clearCache(); this.publish(Object.freeze([]));
        } else if (error instanceof ClientApiError && error.code === "session_not_found") {
          this.cached.delete(sessionId); this.expanded.delete(sessionId); this.publish(Object.freeze([]));
        }
      }
    });
    this.removers.push(
      sessions.subscribe(this.sync), sessions.run.subscribe(this.sync), connection.subscribe(this.sync),
      connection.onInvalidation(() => { void this.refresh(); }),
    );
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();
  close(): void { this.closed = true; this.queue.close(); for (const remove of this.removers.splice(0)) remove(); this.clearCache(); this.publish(Object.freeze([])); }

  /** Owned by this browser module, with stale handlers fenced at connection boundaries. */
  disclosure(blockId: string): SystemPromptDisclosureState {
    const sessionId = this.sessionId, epoch = this.presentationEpoch;
    return {
      identity: `${epoch}/${sessionId ?? ""}/${blockId}`,
      open: !!sessionId && !!this.expanded.get(sessionId)?.has(blockId),
      setOpen: open => {
        if (this.closed || epoch !== this.presentationEpoch || !sessionId || !this.cached.get(sessionId)?.blocks.some(block => block.id === blockId)) return;
        const expanded = this.expanded.get(sessionId) ?? new Set<string>();
        expanded.delete(blockId);
        if (open) expanded.add(blockId);
        while (expanded.size > MAX_EXPANDED_PROMPTS) expanded.delete(expanded.values().next().value!);
        if (expanded.size) this.expanded.set(sessionId, expanded); else this.expanded.delete(sessionId);
      },
    };
  }

  private remember(sessionId: string, cached: CachedPrompts): void {
    this.cached.delete(sessionId); this.cached.set(sessionId, cached);
    while (this.cached.size > MAX_CACHED_SESSIONS) {
      const oldest = this.cached.keys().next().value!;
      this.cached.delete(oldest); this.expanded.delete(oldest);
    }
  }
  private clearCache(): void { this.cached.clear(); this.expanded.clear(); this.presentationEpoch++; }

  private readonly sync = (): void => {
    if (this.closed) return;
    const connection = this.connection.getSnapshot(), sessions = this.sessions.getSnapshot(), run = this.sessions.run.getSnapshot();
    const active = connection.online && connection.businessAvailable;
    const sessionId = active ? sessions.selectedId : null;
    const changedInstance = this.instanceId !== connection.instanceId;
    this.instanceId = connection.instanceId;
    if (changedInstance || !active) this.clearCache();
    const requestBoundaries = run.events.filter(event => event.type === "model.stream" && (event.payload.type === "start" || event.payload.type === "done" || event.payload.type === "error")).length;
    const key = `${connection.instanceId ?? ""}:${active}:${sessionId ?? ""}:${run.runId ?? ""}:${requestBoundaries}:${run.terminal}`;
    if (key === this.observedKey) return;
    const changed = sessionId !== this.sessionId;
    this.observedKey = key; this.sessionId = sessionId;
    if (changedInstance || changed || !sessionId) {
      const cached = sessionId ? this.cached.get(sessionId) : undefined;
      if (cached && sessionId) this.remember(sessionId, cached);
      this.publish(cached?.blocks ?? Object.freeze([]));
    }
    if (sessionId) void this.refresh();
  };
  private available(): boolean { const state = this.connection.getSnapshot(); return !this.closed && state.online && state.businessAvailable; }
}

function snapshotIdentity(snapshot: SystemPromptSnapshot): string { return JSON.stringify([snapshot.runId, snapshot.stepId]); }
function sameSnapshots(left: readonly SystemPromptSnapshot[], right: readonly SystemPromptSnapshot[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]!;
    return item.schemaVersion === other.schemaVersion && item.sessionId === other.sessionId && item.runId === other.runId &&
      item.userTurnId === other.userTurnId && item.stepId === other.stepId && item.capturedAt === other.capturedAt && item.digest === other.digest &&
      item.model.provider === other.model.provider && item.model.model === other.model.model && item.sections.length === other.sections.length &&
      item.sections.every((section, sectionIndex) => { const next = other.sections[sectionIndex]!; return section.channel === next.channel && section.role === next.role && section.content === next.content; });
  });
}

function projectSnapshots(snapshots: readonly SystemPromptSnapshot[]): readonly LedgerBlock[] {
  const blocks: LedgerBlock[] = [];
  let previousDigest: string | undefined;
  for (const snapshot of [...snapshots].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))) {
    if (!validSnapshot(snapshot) || snapshot.digest === previousDigest) continue;
    const update = previousDigest !== undefined;
    blocks.push(Object.freeze({
      id: `system-prompt/${snapshot.runId}/${snapshot.stepId}/${snapshot.digest}`,
      turnId: `${snapshot.runId}/${snapshot.userTurnId}`,
      stepId: snapshot.stepId,
      runId: snapshot.runId,
      time: snapshot.capturedAt,
      kind: "system" as const,
      title: update ? "系统提示词更新" : "系统提示词",
      text: "",
      viewId: SYSTEM_PROMPT_LEDGER_VIEW,
      anchor: update ? "step-start" as const : "turn-start" as const,
      data: Object.freeze({ snapshot, update }),
    }));
    previousDigest = snapshot.digest;
  }
  return Object.freeze(blocks);
}

function validSnapshot(value: SystemPromptSnapshot): boolean {
  return !!value && value.schemaVersion === 1 && typeof value.sessionId === "string" && typeof value.runId === "string" && typeof value.userTurnId === "string" && typeof value.stepId === "string"
    && typeof value.capturedAt === "string" && /^[a-f0-9]{64}$/u.test(value.digest)
    && !!value.model && typeof value.model.provider === "string" && typeof value.model.model === "string"
    && Array.isArray(value.sections) && value.sections.every(section =>
      (section.channel === "instructions" || section.channel === "dynamic_tail")
      && (section.role === "system" || section.role === "developer")
      && typeof section.content === "string");
}
