import type { AgentRunId, UserTurnId } from "../../core/agent/agent.js";
import type { AgentStepId } from "../../core/runtime/runtime.js";
import type { ToolResult } from "../../core/tools/scheduler.js";

/** Complete executor result captured before model-facing rendering or trimming. */
export interface ToolResultArchiveInput {
  readonly sessionId: string;
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly stepId: AgentStepId;
  readonly result: ToolResult;
  readonly signal?: AbortSignal;
}

/** Stable provider-neutral identity for one archived complete Tool Result. */
export interface ToolResultArchiveReference {
  readonly locator: string;
  readonly hash: string;
}

/** Tool-owned persistence Port used before a result is rendered for the model. */
export interface ToolResultArchivePort {
  archive(
    input: ToolResultArchiveInput,
  ):
    | Promise<ToolResultArchiveReference>
    | ToolResultArchiveReference;
}
