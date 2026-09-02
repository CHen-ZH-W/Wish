import type {
  ModelMessage,
  ModelRequest,
  ModelRole,
} from "../model/types.js";

export type ContextAuthority = Exclude<ModelRole, "tool">;
export type ContextLaneKind = "instruction" | "state" | "reference";
export type ContextLanePlacement =
  | "stable_prefix"
  | "before_current_user"
  | "dynamic_tail";

export type ContextLaneMessage = Omit<ModelMessage, "role"> & {
  readonly role: ContextAuthority;
};

/** Named context whose content and authority were decided by its provider. */
export interface ContextLaneItem {
  readonly id: string;
  readonly kind: ContextLaneKind;
  readonly placement: ContextLanePlacement;
  readonly message: ContextLaneMessage;
}

/** One ordered message from an external or process-local history source. */
export interface ContextHistoryItem {
  readonly id: string;
  readonly kind: "history";
  readonly placement: "history";
  readonly sequence: number;
  readonly message: ModelMessage;
}

/** Summary metadata is structural; deciding whether to use it is policy. */
export interface ContextSummaryItem {
  readonly id: string;
  readonly kind: "summary";
  readonly placement: "history";
  readonly sequence: number;
  readonly coveredThroughSequence: number;
  readonly message: ModelMessage;
}

export type ContextItem =
  | ContextLaneItem
  | ContextHistoryItem
  | ContextSummaryItem;

/** Read-only source Port. Provider registration order remains observable. */
export interface ContextProvider<Input = unknown> {
  readonly id: string;
  provide(
    input: Input,
    signal?: AbortSignal,
  ): Promise<readonly ContextItem[]> | readonly ContextItem[];
}

export interface ContextProviderGroup {
  readonly providerId: string;
  readonly items: readonly ContextItem[];
}

export type ContextHistorySourceItem = ContextHistoryItem | ContextSummaryItem;

export interface ContextHistoryPolicyInput {
  readonly request: ModelRequest;
  readonly items: readonly ContextHistorySourceItem[];
  readonly signal?: AbortSignal;
}

export interface ContextHistorySelection {
  readonly items: readonly ContextHistorySourceItem[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Selects already-provided history without owning persistence or rewriting it. */
export interface ContextHistoryPolicy {
  select(
    input: ContextHistoryPolicyInput,
  ): Promise<ContextHistorySelection> | ContextHistorySelection;
}

export type ContextToolResultMessage = ModelMessage & {
  readonly role: "tool";
  readonly toolCallId: string;
};

/** Stable locator returned by an external raw Tool Result archive. */
export interface ContextToolResultArchive {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextToolResultArchiveInput {
  readonly request: ModelRequest;
  readonly message: ContextToolResultMessage;
  readonly messageIndex: number;
  readonly signal?: AbortSignal;
}

export interface ContextToolResultProjectionInput
  extends ContextToolResultArchiveInput {
  readonly archive: ContextToolResultArchive;
}

/**
 * External Tool Result capability. Core always awaits `archive` before it asks
 * for a possibly smaller model-visible copy.
 */
export interface ContextToolResultPipeline {
  archive(
    input: ContextToolResultArchiveInput,
  ):
    | Promise<ContextToolResultArchive>
    | ContextToolResultArchive;
  toModelMessage(
    input: ContextToolResultProjectionInput,
  ): Promise<ContextToolResultMessage> | ContextToolResultMessage;
}

export type ContextBudgetStatus = "within_budget" | "over_budget" | "unknown";

export interface ContextBudgetAssessment {
  readonly status: ContextBudgetStatus;
  readonly estimatedInputTokens?: number;
  readonly inputLimitTokens?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ContextBudgetEvaluationInput {
  readonly request: ModelRequest;
  readonly signal?: AbortSignal;
}

/** Model-aware sizing remains external; Core owns the resulting decision. */
export interface ContextBudgetEvaluator {
  assess(
    input: ContextBudgetEvaluationInput,
  ): Promise<ContextBudgetAssessment> | ContextBudgetAssessment;
}

export interface ContextProjectorServices {
  readonly historyPolicy?: ContextHistoryPolicy;
  readonly toolResults?: ContextToolResultPipeline;
  readonly budget?: ContextBudgetEvaluator;
}

/**
 * The index addresses the unprojected request. Every Agent projection names
 * the current UserTurn message so Core can prove that it survived unchanged.
 */
export interface ContextProjectionInput {
  readonly request: ModelRequest;
  readonly groups: readonly ContextProviderGroup[];
  readonly currentUserMessageIndex: number;
  readonly signal?: AbortSignal;
}

export interface ContextProviderProjectionInput<Input = unknown> {
  readonly request: ModelRequest;
  readonly providers: readonly ContextProvider<Input>[];
  readonly providerInput: Input;
  readonly currentUserMessageIndex: number;
  readonly signal?: AbortSignal;
}

interface ContextProjectionBase {
  readonly providerGroups: readonly ContextProviderGroup[];
  readonly includedItems: readonly ContextItem[];
  readonly history: ContextHistorySelection;
  readonly budget: ContextBudgetAssessment;
}

/** A request that passed every Context invariant and may be sent to Model. */
export interface ContextReadyProjection extends ContextProjectionBase {
  readonly status: "ready";
  readonly request: ModelRequest;
}

/** Explicit non-runnable projection; callers must choose the next action. */
export interface ContextRejectedProjection extends ContextProjectionBase {
  readonly status: "rejected";
  readonly reason: "over_budget";
  readonly candidateRequest: ModelRequest;
  readonly budget: ContextBudgetAssessment & { readonly status: "over_budget" };
}

/** Complete immutable result of the Context main pipeline. */
export type ContextProjection =
  | ContextReadyProjection
  | ContextRejectedProjection;
