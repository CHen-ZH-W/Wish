import { SnapshotStore } from "../model/store.js";

/** Unsaved presentation state, scoped to this browser UI owner, never Session history. */
export class ComposerDraft extends SnapshotStore<string> {
  constructor() { super(""); }
  set = (text: string): void => this.publish(text);
  accepted(text: string): void { if (this.getSnapshot() === text) this.set(""); }
}
export class ComposerDrafts {
  private readonly sessions = new Map<string, ComposerDraft>();
  forSession(sessionId: string): ComposerDraft {
    let draft = this.sessions.get(sessionId);
    if (!draft) { draft = new ComposerDraft(); this.sessions.set(sessionId, draft); }
    return draft;
  }
  close(): void { this.sessions.clear(); }
  remove(sessionId: string): void { this.sessions.delete(sessionId); }
}
