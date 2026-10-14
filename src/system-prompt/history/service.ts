import { Service, type Context } from "@deepseek-ai/cordis";
import type { SystemPromptHistory, SystemPromptSnapshot, SystemPromptSnapshotInput } from "./types.js";

export abstract class SystemPromptHistoryService extends Service implements SystemPromptHistory {
  constructor(ctx: Context) { super(ctx, "systemPromptHistory"); }
  abstract record(input: SystemPromptSnapshotInput, signal?: AbortSignal): Promise<void>;
  abstract list(sessionId: string, signal?: AbortSignal): Promise<readonly SystemPromptSnapshot[]>;
  abstract close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { systemPromptHistory: SystemPromptHistoryService; }
}

export default SystemPromptHistoryService;
