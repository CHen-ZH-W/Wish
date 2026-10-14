import type { ModelRef } from "../../core/model/model.js";

export type SystemPromptSnapshotChannel = "instructions" | "dynamic_tail";

export interface SystemPromptSnapshotSection {
  readonly channel: SystemPromptSnapshotChannel;
  readonly role: "system" | "developer";
  readonly content: string;
}

/** Exact model-visible System Prompt material fixed for one ready Step request. */
export interface SystemPromptSnapshot {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly capturedAt: string;
  readonly model: ModelRef;
  readonly digest: string;
  readonly sections: readonly SystemPromptSnapshotSection[];
}

export interface SystemPromptSnapshotInput extends Omit<SystemPromptSnapshot, "schemaVersion"> {}

export interface SystemPromptHistory {
  record(input: SystemPromptSnapshotInput, signal?: AbortSignal): Promise<void>;
  list(sessionId: string, signal?: AbortSignal): Promise<readonly SystemPromptSnapshot[]>;
  close(): Promise<void>;
}
