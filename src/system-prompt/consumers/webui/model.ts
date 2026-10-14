import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore, freezeWire } from "../../../apps/webui/client/model/store.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import type { SystemPromptSnapshot } from "../../history/types.js";
import type { SessionSystemPromptHistoryView } from "../webui-types.js";

export const SYSTEM_PROMPT_LEDGER_VIEW = "system-prompt-history";

/** Browser projection of durable snapshots into generic conversation blocks. */
export class SystemPromptHistoryClientModel extends SnapshotStore<readonly LedgerBlock[]> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private sessionId: string | null = null;
  private observedKey = "";
  private closed = false;

  constructor(private readonly connection: ClientConnection, private readonly sessions: SessionClientModel) {
    super(Object.freeze([]));
    this.queue = new RefreshQueue(async current => {
      const sessionId = this.sessionId;
      if (!sessionId || !this.available()) return;
      try {
        const response = freezeWire(await connection.request<{ value: SessionSystemPromptHistoryView }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/controls/system-prompt-history`,
        ));
        if (response.value.schemaVersion !== 1 || response.value.sessionId !== sessionId || !Array.isArray(response.value.snapshots)) throw new Error("系统提示词历史响应与当前会话不匹配");
        const blocks = projectSnapshots(response.value.snapshots);
        if (current() && this.sessionId === sessionId) this.publish(blocks);
      } catch {
        // The contribution disappears on adapter loss; other conversation history remains usable.
        if (current() && this.sessionId === sessionId) this.publish(Object.freeze([]));
      }
    });
    this.removers.push(
      sessions.subscribe(this.sync), sessions.run.subscribe(this.sync), connection.subscribe(this.sync),
      connection.onInvalidation(() => { void this.refresh(); }),
    );
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();
  close(): void { this.closed = true; this.queue.close(); for (const remove of this.removers.splice(0)) remove(); }

  private readonly sync = (): void => {
    if (this.closed) return;
    const connection = this.connection.getSnapshot(), sessions = this.sessions.getSnapshot(), run = this.sessions.run.getSnapshot();
    const active = connection.online && connection.businessAvailable;
    const sessionId = active ? sessions.selectedId : null;
    const requestBoundaries = run.events.filter(event => event.type === "model.stream" && (event.payload.type === "start" || event.payload.type === "done" || event.payload.type === "error")).length;
    const key = `${connection.instanceId ?? ""}:${active}:${sessionId ?? ""}:${run.runId ?? ""}:${requestBoundaries}:${run.terminal}`;
    if (key === this.observedKey) return;
    const changed = sessionId !== this.sessionId;
    this.observedKey = key; this.sessionId = sessionId;
    if (changed || !sessionId) this.publish(Object.freeze([]));
    if (sessionId) void this.refresh();
  };
  private available(): boolean { const state = this.connection.getSnapshot(); return !this.closed && state.online && state.businessAvailable; }
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
  return !!value && value.schemaVersion === 1 && typeof value.runId === "string" && typeof value.userTurnId === "string" && typeof value.stepId === "string"
    && typeof value.capturedAt === "string" && /^[a-f0-9]{64}$/u.test(value.digest)
    && !!value.model && typeof value.model.provider === "string" && typeof value.model.model === "string"
    && Array.isArray(value.sections) && value.sections.every(section =>
      (section.channel === "instructions" || section.channel === "dynamic_tail")
      && (section.role === "system" || section.role === "developer")
      && typeof section.content === "string");
}
