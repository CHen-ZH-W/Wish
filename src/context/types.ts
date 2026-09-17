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
import type { AgentLoopInputSource, AgentLoopRequestView } from "../core/agent-loop/types.js";
import type { ToolResultArchiveReference } from "../tools/results/types.js";
import type {
  WorkspaceFingerprint,
  WorkspaceRepository,
  WorkspaceRevision,
} from "../workspace/index.js";

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
  readonly fingerprint: WorkspaceFingerprint;
  readonly revision: WorkspaceRevision;
  readonly instructions: readonly ContextWorkspaceInstruction[];
  readonly repository?: WorkspaceRepository;
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
  /** Optional for legacy hosts; absence must not be treated as human input. */
  readonly request?: ContextRequestView;
}

/** Read-only request facts, never an execution grant or instruction authority. */
export interface ContextRequestView extends AgentLoopRequestView {}

export interface ContextHistoryMessageRecord {
  readonly kind: "message";
  readonly sequence: number;
  /** Allows Context to exclude facts already supplied by the active UserTurn. */
  readonly userTurnId?: UserTurnId;
  /** Optional provenance metadata; never copied into the model wire message. */
  readonly inputSource?: AgentLoopInputSource;
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

/**
 * Durable bridge between pre-render archival and later Context projection.
 * Session adapters may persist this beside a Tool message, never in its text.
 */
export interface ContextToolResultArchiveReceipt
  extends ToolResultArchiveReference {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
}

/** Compatibility exports; canonical ownership is `src/tools/results/types.ts`. */
export type {
  ToolResultArchiveInput,
  ToolResultArchivePort,
  ToolResultArchiveReference,
} from "../tools/results/types.js";

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
