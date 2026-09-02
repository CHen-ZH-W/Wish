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

export interface ContextItemResolutionInput {
  readonly request: ModelRequest;
  readonly groups: readonly ContextProviderGroup[];
  readonly signal?: AbortSignal;
}

/** Explicit collision and cross-provider merge policy. */
export interface ContextItemResolver {
  resolve(
    input: ContextItemResolutionInput,
  ): Promise<readonly ContextItem[]> | readonly ContextItem[];
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

/** Selects already-recorded history without owning its persistence. */
export interface ContextHistoryPolicy {
  select(
    input: ContextHistoryPolicyInput,
  ): Promise<ContextHistorySelection> | ContextHistorySelection;
}

export interface ContextItemRenderInput {
  readonly request: ModelRequest;
  readonly item: ContextItem;
  readonly signal?: AbortSignal;
}

/** Converts one structured item into its exact model-visible message. */
export interface ContextItemRenderer {
  render(
    input: ContextItemRenderInput,
  ): Promise<ModelMessage> | ModelMessage;
}

export interface ContextMessageNormalizationInput {
  readonly request: ModelRequest;
  readonly messages: readonly ModelMessage[];
  readonly signal?: AbortSignal;
}

/** Repairs or rejects cross-message structure such as tool-call history. */
export interface ContextMessageNormalizer {
  normalize(
    input: ContextMessageNormalizationInput,
  ): Promise<readonly ModelMessage[]> | readonly ModelMessage[];
}

export interface ContextAdmissionInput {
  readonly request: ModelRequest;
  readonly message: ModelMessage;
  readonly messageIndex: number;
  readonly signal?: AbortSignal;
}

/** Final per-message admission boundary before content becomes model-visible. */
export interface ContextAdmissionPolicy {
  admit(
    input: ContextAdmissionInput,
  ): Promise<ModelMessage> | ModelMessage;
}

export type ContextBudgetStatus = "within_budget" | "over_budget" | "unknown";

export interface ContextBudgetAssessment {
  readonly status: ContextBudgetStatus;
  readonly estimatedInputTokens?: number;
  readonly inputLimitTokens?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ContextBudgetPolicyInput {
  readonly request: ModelRequest;
  readonly signal?: AbortSignal;
}

/** Model-aware sizing and budget policy supplied outside Context Core. */
export interface ContextBudgetPolicy {
  assess(
    input: ContextBudgetPolicyInput,
  ): Promise<ContextBudgetAssessment> | ContextBudgetAssessment;
}

export interface ContextProjectorServices {
  readonly itemResolver?: ContextItemResolver;
  readonly historyPolicy?: ContextHistoryPolicy;
  readonly itemRenderer?: ContextItemRenderer;
  readonly messageNormalizer?: ContextMessageNormalizer;
  readonly admissionPolicy?: ContextAdmissionPolicy;
  readonly budgetPolicy?: ContextBudgetPolicy;
}

/**
 * `currentUserMessageIndex` addresses the unprojected request and is explicit
 * whenever placement depends on the current UserTurn input.
 */
export interface ContextProjectionInput {
  readonly request: ModelRequest;
  readonly groups: readonly ContextProviderGroup[];
  readonly currentUserMessageIndex?: number;
  readonly signal?: AbortSignal;
}

export interface ContextProviderProjectionInput<Input = unknown> {
  readonly request: ModelRequest;
  readonly providers: readonly ContextProvider<Input>[];
  readonly providerInput: Input;
  readonly currentUserMessageIndex?: number;
  readonly signal?: AbortSignal;
}

/** Complete immutable result of the Context main pipeline. */
export interface ContextProjection {
  readonly request: ModelRequest;
  readonly providerGroups: readonly ContextProviderGroup[];
  readonly includedItems: readonly ContextItem[];
  readonly history: ContextHistorySelection;
  readonly budget?: ContextBudgetAssessment;
}
