import type { WishOutputEvent } from "../../../types.js";
import type { RuntimeControlReceipt } from "../../../../core/runtime/control.js";
import type { ClientConnection } from "../connection.js";
import { SnapshotStore, freezeWire } from "./store.js";

export interface PendingDelivery { readonly id: string; readonly text: string; readonly mode: "queue" | "steer"; readonly status: "queued" | "delivered" | "not-delivered" }
export interface RunClientSnapshot {
  readonly runId: string | null; readonly events: readonly WishOutputEvent[]; readonly deliveries: readonly PendingDelivery[];
  readonly connected: boolean; readonly terminal: boolean; readonly gap: boolean; readonly error: string | null;
}
const empty = (): RunClientSnapshot => ({ runId: null, events: [], deliveries: [], connected: false, terminal: false, gap: false, error: null });

/** One observer, not a Run owner. Closing or changing selection never cancels Host work. */
export class RunClientModel extends SnapshotStore<RunClientSnapshot> {
  private source: EventSource | undefined;
  private sequence = 0;
  private epoch = 0;
  private buffer: WishOutputEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(private readonly connection: ClientConnection, private readonly settled: () => void) { super(empty()); }
  observe(runId: string): void {
    if (this.closed || (this.getSnapshot().runId === runId && (this.source || this.getSnapshot().terminal))) return;
    if (this.getSnapshot().runId !== runId) { this.disconnect(); this.sequence = 0; this.buffer = []; this.publish({ ...empty(), runId }); }
    this.connect(runId);
  }
  suspend(): void { this.flush(); this.disconnect(); this.publish({ ...this.getSnapshot(), connected: false }); }
  clear(): void { this.disconnect(); this.sequence = 0; this.buffer = []; this.publish(empty()); }
  accepted(receipt: RuntimeControlReceipt, text: string, mode: "queue" | "steer"): void {
    if (receipt.runId !== this.getSnapshot().runId || !receipt.accepted) return;
    this.flush();
    const delivered = this.getSnapshot().events.some(event => event.type === "runtime.transition" &&
      (event.payload.type === "control.steering_delivered" && event.payload.controlIds.includes(receipt.controlId) || event.payload.type === "control.follow_up_dequeued" && event.payload.controlId === receipt.controlId));
    this.publish({ ...this.getSnapshot(), deliveries: Object.freeze([...this.getSnapshot().deliveries.filter(item => item.id !== receipt.controlId),
      Object.freeze({ id: receipt.controlId, text, mode, status: delivered ? "delivered" as const : this.getSnapshot().terminal ? "not-delivered" as const : "queued" as const })].slice(-100)) });
  }
  close(): void { this.closed = true; this.disconnect(); this.buffer = []; }
  private connect(runId: string): void {
    const epoch = ++this.epoch;
    const source = this.connection.stream(`/api/runs/${encodeURIComponent(runId)}/events?after=${this.sequence}`); this.source = source;
    const current = () => !this.closed && this.epoch === epoch;
    source.addEventListener("stream.ready", () => { if (current()) this.publish({ ...this.getSnapshot(), connected: true, error: null }); });
    for (const name of ["runtime.transition", "model.stream", "tool.lifecycle"]) source.addEventListener(name, event => {
      if (!current()) return;
      try {
        const value = freezeWire(JSON.parse((event as MessageEvent).data)) as WishOutputEvent;
        if (value.runId !== runId || value.type !== name || !Number.isSafeInteger(value.sequence) || value.sequence <= this.sequence) return;
        if (value.sequence !== this.sequence + 1) this.publish({ ...this.getSnapshot(), gap: true });
        this.sequence = value.sequence; this.buffer.push(value);
        const terminal = value.type === "runtime.transition" && ["run.completed", "run.failed", "run.aborted"].includes(value.payload.type);
        if (terminal) { this.flush(); this.disconnect(); this.settled(); }
        else this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 32);
      } catch { this.publish({ ...this.getSnapshot(), error: "收到无法识别的运行事件。请刷新会话核对结果。" }); }
    });
    source.addEventListener("stream.error", event => {
      if (!current()) return;
      this.flush(); this.disconnect();
      this.publish({ ...this.getSnapshot(), connected: false, gap: true, error: "运行事件窗口不可用；已保留收到的记录，正在重新读取规范历史。" });
      try {
        const value = JSON.parse((event as MessageEvent).data);
        if (value.error?.code === "event_cursor_expired" && Number.isSafeInteger(value.error.earliestAvailable) && value.error.earliestAvailable > this.sequence + 1) {
          this.sequence = value.error.earliestAvailable - 1; this.connect(runId);
        }
      } catch { /* A malformed error does not justify resetting the cursor or replaying work. */ }
      this.settled();
    });
    source.onerror = () => { if (current()) this.publish({ ...this.getSnapshot(), connected: false, error: "运行流已断开，正在按游标重连；没有取消任务。" }); };
  }
  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.buffer.length) return;
    const incoming = this.buffer; this.buffer = [];
    let events = [...this.getSnapshot().events, ...incoming], gap = this.getSnapshot().gap;
    if (events.length > 2048) { events = events.slice(-2048); gap = true; }
    // Bound retained payload bytes as well as event count; history remains Host-owned.
    let bytes = 0, start = events.length;
    while (start > 0) { const size = JSON.stringify(events[start - 1]).length * 2; if (bytes + size > 4_194_304) break; bytes += size; start--; }
    if (start > 0) { events = events.slice(start); gap = true; }
    const transitions = incoming.filter(event => event.type === "runtime.transition").map(event => event.payload);
    const terminal = this.getSnapshot().terminal || transitions.some(item => ["run.completed", "run.failed", "run.aborted"].includes(item.type));
    const deliveries = this.getSnapshot().deliveries.map(item => {
      if (item.status !== "queued") return item;
      const delivered = transitions.some(event => event.type === "control.steering_delivered" && event.controlIds.includes(item.id) || event.type === "control.follow_up_dequeued" && event.controlId === item.id);
      return delivered || terminal ? Object.freeze({ ...item, status: delivered ? "delivered" as const : "not-delivered" as const }) : item;
    });
    this.publish({ ...this.getSnapshot(), events: Object.freeze(events), deliveries: Object.freeze(deliveries), terminal, gap, ...(terminal ? { connected: false } : {}) });
  }
  private disconnect(): void { this.epoch++; this.source?.close(); this.source = undefined; if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
}
