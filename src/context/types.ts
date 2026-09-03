import type {
  AgentRunId,
  UserTurnId,
} from "../core/agent/agent.js";
import type {
  ModelMessage,
  ModelRef,
  ModelRequest,
} from "../core/model/model.js";
import type { AgentStepId } from "../core/runtime/runtime.js";
import type { ToolResult } from "../core/tools/scheduler.js";

export type ContextSessionId = string;
export type ContextProviderId = string;

/** One already-resolved instruction; Context never scans for its source. */
export interface ContextInstruction {
  readonly id: string;
  readonly authority: "system" | "developer";
  readonly content: string;
}

export type ContextWorkspaceInstruction = ContextInstruction;

/** Workspace facts captured outside Context for the current Step. */
export interface ContextWorkspaceFacts {
  readonly cwd: string;
  readonly instructions: readonly ContextWorkspaceInstruction[];
}

/** Runtime facts captured with the active immutable Step snapshot. */
export interface ContextRuntimeFacts {
  readonly capturedAt: string;
  readonly stateVersion: number;
  readonly userTurnOrdinal: number;
  readonly stepOrdinal: number;
}

/** Complete resolved input shared by the concrete Context providers. */
export interface ContextInput {
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly stepId: AgentStepId;
  readonly sessionId: ContextSessionId;
  readonly model: ModelRef;
  readonly workspace: ContextWorkspaceFacts;
  readonly runtime: ContextRuntimeFacts;
}

export interface ContextHistoryMessageRecord {
  readonly kind: "message";
  readonly sequence: number;
  /** Allows Context to exclude facts already supplied by the active UserTurn. */
  readonly userTurnId?: UserTurnId;
  readonly message: ModelMessage;
  /** Separate structural metadata; it is never emitted on the Provider wire. */
  readonly toolResultArchive?: ContextToolResultArchiveReceipt;
}

export interface ContextHistorySummaryRecord {
  readonly kind: "summary";
  readonly sequence: number;
  readonly coveredThroughSequence: number;
  readonly message: ModelMessage;
}

/** Storage-neutral normalized Session fact consumed by Context. */
export type ContextHistoryRecord =
  | ContextHistoryMessageRecord
  | ContextHistorySummaryRecord;

export interface ContextHistoryReadInput {
  readonly sessionId: ContextSessionId;
  readonly signal?: AbortSignal;
}

/** Session adapter Port; paths, JSONL and database rows stay behind it. */
export interface ContextHistorySource {
  read(
    input: ContextHistoryReadInput,
  ):
    | Promise<readonly ContextHistoryRecord[]>
    | readonly ContextHistoryRecord[];
}

export interface ToolResultArchiveInput {
  readonly sessionId: ContextSessionId;
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly stepId: AgentStepId;
  /** Complete executor result, before any model-facing rendering or trimming. */
  readonly result: ToolResult;
  readonly signal?: AbortSignal;
}

/** Stable opaque identity for one archived complete Tool Result. */
export interface ToolResultArchiveReference {
  readonly locator: string;
  readonly hash: string;
}

/**
 * Durable bridge between pre-render archival and later Context projection.
 * Session adapters may persist this beside a Tool message, never in its text.
 */
export interface ContextToolResultArchiveReceipt
  extends ToolResultArchiveReference {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
}

/** Storage adapter Port used by the pre-render Tool Result decorator. */
export interface ToolResultArchivePort {
  archive(
    input: ToolResultArchiveInput,
  ):
    | Promise<ToolResultArchiveReference>
    | ToolResultArchiveReference;
}

export interface ModelInputTokenCountInput {
  /** Final projected request, immediately before Model invocation. */
  readonly request: ModelRequest;
  readonly signal?: AbortSignal;
}

export interface ModelInputTokenCount {
  readonly inputTokens: number;
  readonly method: string;
}

/** Exact configured model metadata used on the request hot path. */
export interface ModelContextWindowSource {
  getContextWindowTokens(
    model: ModelRef,
    signal?: AbortSignal,
  ): Promise<number | undefined> | number | undefined;
}

/**
 * Models adapter Port for request-only counting. `undefined` means the exact
 * model or its tokenizer is unavailable; callers must report unknown.
 */
export interface ModelInputTokenCounter {
  count(
    input: ModelInputTokenCountInput,
  ):
    | Promise<ModelInputTokenCount | undefined>
    | ModelInputTokenCount
    | undefined;
}

export interface ContextToolResultAdmissionConfiguration {
  readonly thresholdChars: number;
  readonly headChars: number;
  readonly tailChars: number;
}

export interface ContextConfiguration {
  readonly reservedOutputTokens: number;
  readonly toolResultAdmission: ContextToolResultAdmissionConfiguration;
  /** Registration order; Core placement remains the final ordering authority. */
  readonly providerOrder: readonly ContextProviderId[];
}

export const DEFAULT_CONTEXT_TOOL_RESULT_ADMISSION = Object.freeze({
  thresholdChars: 8_192,
  headChars: 4_096,
  tailChars: 1_024,
}) satisfies ContextToolResultAdmissionConfiguration;
