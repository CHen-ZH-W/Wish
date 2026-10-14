import type { SystemPromptSnapshot } from "../history/types.js";

export interface SessionSystemPromptHistoryView {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly snapshots: readonly SystemPromptSnapshot[];
}
