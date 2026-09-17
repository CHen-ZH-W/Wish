import type { SessionClientModel } from "./session.js";
import { SnapshotStore } from "./store.js";

interface DraftHandoff {
  forSession(sessionId: string): { set(text: string): void; accepted(text: string): void };
}

export interface NewSessionSnapshot {
  readonly workspaceRoot: string | null;
  readonly draft: string;
  readonly phase: "ready" | "creating" | "sending" | "review" | "done";
  readonly createdSessionId: string | null;
  readonly error: string | null;
}

/** Browser-only new-session intent. Opening never creates a Host Session. */
export class NewSessionClientModel extends SnapshotStore<NewSessionSnapshot> {
  private closed = false;
  private readonly firstMessageSetups = new Map<string, () => ((sessionId: string) => Promise<void>) | undefined>();
  constructor(private readonly sessions: Pick<SessionClientModel, "startCreate" | "create" | "send">, private readonly drafts: DraftHandoff) {
    super({ workspaceRoot: null, draft: "", phase: "ready", createdSessionId: null, error: null });
  }
  start = (): void => {
    const state = this.getSnapshot();
    if (this.closed || state.phase === "creating" || state.phase === "sending") return;
    this.sessions.startCreate();
    if (state.phase === "ready") return;
    this.publish({ workspaceRoot: null, draft: "", phase: "ready", createdSessionId: null, error: null });
  };
  chooseWorkspace = (workspaceRoot: string): void => {
    if (this.closed || this.getSnapshot().phase !== "ready") return;
    this.publish({ ...this.getSnapshot(), workspaceRoot, error: null });
  };
  setDraft = (draft: string): void => {
    if (this.closed || this.getSnapshot().phase !== "ready") return;
    this.publish({ ...this.getSnapshot(), draft });
  };
  /** Optional capability owners capture their choice before creation, then apply it to the new Session before its first Run. */
  registerFirstMessageSetup(id: string, capture: () => ((sessionId: string) => Promise<void>) | undefined): () => void {
    if (this.closed || this.firstMessageSetups.has(id)) throw new Error(`Duplicate new-session setup: ${id}`);
    this.firstMessageSetups.set(id, capture);
    return () => { if (this.firstMessageSetups.get(id) === capture) this.firstMessageSetups.delete(id); };
  }
  submit = async (): Promise<void> => {
    const state = this.getSnapshot();
    if (this.closed || state.phase !== "ready") return;
    const text = state.draft.trim(), root = state.workspaceRoot;
    if (!root || !text) { this.publish({ ...state, error: !root ? "请先选择工作区" : "请先输入消息" }); return; }
    let setups: Array<(sessionId: string) => Promise<void>>;
    try { setups = [...this.firstMessageSetups.values()].map(capture => capture()).filter((setup): setup is (sessionId: string) => Promise<void> => setup !== undefined); }
    catch (cause) { this.publish({ ...state, error: cause instanceof Error ? cause.message : "无法应用新会话设置" }); return; }
    this.publish({ ...state, phase: "creating", error: null });
    let createdSessionId: string | null = null;
    let sendStarted = false;
    try {
      createdSessionId = await this.sessions.create(root);
      if (this.closed) return;
      this.drafts.forSession(createdSessionId).set(state.draft);
      for (const setup of setups) await setup(createdSessionId);
      if (this.closed) return;
      this.publish({ ...this.getSnapshot(), phase: "sending", createdSessionId });
      sendStarted = true;
      await this.sessions.send(text, "queue", createdSessionId);
      if (this.closed) return;
      this.drafts.forSession(createdSessionId).accepted(state.draft);
      this.publish({ ...this.getSnapshot(), draft: "", phase: "done", error: null });
    } catch (cause) {
      if (this.closed) return;
      const reason = cause instanceof Error ? cause.message : "请求未完成";
      this.publish({ ...this.getSnapshot(), phase: createdSessionId ? "review" : "ready", createdSessionId,
        error: createdSessionId ? sendStarted
          ? `${reason}。会话已创建，首条消息的结果需要核对；草稿保留在该会话。`
          : `${reason}。会话已创建，首条消息尚未发送；草稿保留在该会话，请打开会话后重试。` : reason });
    }
  };
  close(): void { this.closed = true; this.firstMessageSetups.clear(); }
}
