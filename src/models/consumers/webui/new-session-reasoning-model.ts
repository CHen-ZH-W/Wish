import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import type { SessionReasoningView } from "../../session-reasoning.js";
import type { ModelReasoningEffort } from "../../types.js";

export interface NewSessionReasoningSnapshot {
  readonly view: SessionReasoningView | null;
  readonly selected: ModelReasoningEffort | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/** Models owns the pre-Session choice; it becomes durable only after the first send creates a Session. */
export class NewSessionReasoningClientModel extends SnapshotStore<NewSessionReasoningSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removers: Array<() => void> = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private instanceId: string | null = null;
  private closed = false;

  constructor(private readonly connection: ClientConnection, settings: SettingsClientModel) {
    super(Object.freeze({ view: null, selected: null, loading: false, error: null }));
    this.queue = new RefreshQueue(async current => {
      if (!this.available()) return;
      try {
        const { selection } = await this.connection.request<{ selection: SessionReasoningView }>("/api/model-reasoning/default");
        if (!current() || !this.available()) return;
        const before = this.getSnapshot();
        const sameModel = before.view?.model.provider === selection.model.provider && before.view.model.model === selection.model.model;
        const selected = sameModel && before.selected !== null && selection.control?.efforts.includes(before.selected) ? before.selected : null;
        this.publish({ view: selection, selected, loading: false, error: null });
      } catch (error) {
        if (current()) this.publish({ ...this.getSnapshot(), loading: false, error: error instanceof Error ? error.message : "思考选项读取失败" });
      }
    });
    this.removers.push(connection.subscribe(this.sync), connection.onInvalidation(() => { void this.refresh(); }), settings.subscribe(() => { void this.refresh(); }));
    this.timer = setInterval(() => { if (this.available()) void this.refresh(); }, 15_000);
    this.sync();
  }

  readonly refresh = (): Promise<void> => this.queue.request();

  select(effort: ModelReasoningEffort): void {
    const state = this.getSnapshot();
    if (!state.view?.control || !this.available() || !state.view.control.efforts.includes(effort)) {
      this.publish({ ...state, selected: null, error: "当前模型不能选择该思考强度" });
      return;
    }
    this.publish({ ...state, selected: effort === state.view.control.defaultEffort ? null : effort, error: null });
  }

  reset(): void {
    const state = this.getSnapshot();
    if (state.selected !== null) this.publish({ ...state, selected: null });
  }

  /** Snapshot the choice at submit; a subsequent plugin disposal cannot silently drop an already chosen effort. */
  capture(): ((sessionId: string) => Promise<void>) | undefined {
    const state = this.getSnapshot();
    if (state.selected === null) return undefined;
    if (!this.available() || !state.view?.control?.efforts.includes(state.selected)) throw new Error("思考选项暂不可用，请稍后重试");
    const { model } = state.view, effort = state.selected;
    return async sessionId => {
      await this.connection.request(`/api/sessions/${encodeURIComponent(sessionId)}/model-reasoning`, { model, effort });
    };
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.queue.close();
    for (const remove of this.removers.splice(0)) remove();
  }

  private readonly sync = (): void => {
    if (this.closed) return;
    const state = this.connection.getSnapshot();
    if (!state.online || !state.businessAvailable) {
      this.instanceId = null;
      this.publish({ ...this.getSnapshot(), loading: false });
      return;
    }
    if (state.instanceId !== this.instanceId) {
      this.instanceId = state.instanceId;
      this.publish({ ...this.getSnapshot(), loading: true });
      void this.refresh();
    }
  };

  private available(): boolean {
    const state = this.connection.getSnapshot();
    return !this.closed && state.online && state.businessAvailable;
  }
}
