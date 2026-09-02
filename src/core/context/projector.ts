import type { ModelMessage, ModelRequest } from "../model/types.js";
import type {
  ContextBudgetAssessment,
  ContextHistoryPolicy,
  ContextHistorySelection,
  ContextHistorySourceItem,
  ContextItem,
  ContextLaneItem,
  ContextProjection,
  ContextProjectionInput,
  ContextProjectorServices,
  ContextProvider,
  ContextProviderGroup,
  ContextProviderProjectionInput,
  ContextToolResultArchive,
  ContextToolResultMessage,
} from "./context.js";

export type {
  ContextAuthority,
  ContextBudgetAssessment,
  ContextBudgetEvaluationInput,
  ContextBudgetEvaluator,
  ContextBudgetStatus,
  ContextHistoryItem,
  ContextHistoryPolicy,
  ContextHistoryPolicyInput,
  ContextHistorySelection,
  ContextHistorySourceItem,
  ContextItem,
  ContextLaneItem,
  ContextLaneKind,
  ContextLaneMessage,
  ContextLanePlacement,
  ContextProjection,
  ContextProjectionInput,
  ContextProjectorServices,
  ContextProvider,
  ContextProviderGroup,
  ContextProviderProjectionInput,
  ContextReadyProjection,
  ContextRejectedProjection,
  ContextSummaryItem,
  ContextToolResultArchive,
  ContextToolResultArchiveInput,
  ContextToolResultMessage,
  ContextToolResultPipeline,
  ContextToolResultProjectionInput,
} from "./context.js";

const EXPLICIT_HISTORY_POLICY: ContextHistoryPolicy = {
  select(input) {
    if (input.items.some((item) => item.kind === "summary")) {
      throw new Error(
        "Summary Context items require an explicit ContextHistoryPolicy",
      );
    }
    return { items: input.items };
  },
};

const UNKNOWN_BUDGET = Object.freeze({
  status: "unknown" as const,
});

interface WorkingMessage {
  readonly message: ModelMessage;
  readonly source: "request" | "context";
  readonly requestIndex?: number;
}

/**
 * Owns the invariant Context spine. External capabilities can supply history
 * selection, Tool Result persistence/projection, and model-aware sizing only.
 */
export class ContextProjector {
  private readonly historyPolicy: ContextHistoryPolicy;

  constructor(private readonly services: ContextProjectorServices = {}) {
    this.historyPolicy = services.historyPolicy ?? EXPLICIT_HISTORY_POLICY;
  }

  async project(input: ContextProjectionInput): Promise<ContextProjection> {
    throwIfAborted(input.signal);
    const sourceRequest = deepFreezePlainValue({
      ...input.request,
    }) as ModelRequest;
    validateToolTranscript(sourceRequest.messages);
    const currentUserMessageIndex = validateCurrentUserMessageIndex(
      sourceRequest,
      input.currentUserMessageIndex,
    );
    const groups = validateProviderGroups(input.groups);
    const sourceItems = validateUniqueItems(
      groups.flatMap((group) => group.items),
    );

    throwIfAborted(input.signal);
    const sourceHistory = sourceItems.filter(isHistoryItem);
    const history = validateHistorySelection(
      await this.historyPolicy.select({
        request: sourceRequest,
        items: sourceHistory,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
      sourceHistory,
    );
    const includedItems = validateUniqueItems([
      ...sourceItems.filter((item) => !isHistoryItem(item)),
      ...history.items,
    ]);

    throwIfAborted(input.signal);
    const structurallyProjected = projectPlacements(
      sourceRequest,
      includedItems,
      currentUserMessageIndex,
    );
    validateToolTranscript(
      structurallyProjected.map((entry) => entry.message),
    );
    assertCurrentUserPreserved(
      sourceRequest,
      structurallyProjected,
      currentUserMessageIndex,
    );

    const visibleMessages = await this.projectToolResults(
      sourceRequest,
      structurallyProjected,
      input.signal,
    );
    validateToolTranscript(visibleMessages.map((entry) => entry.message));
    assertCurrentUserPreserved(
      sourceRequest,
      visibleMessages,
      currentUserMessageIndex,
    );

    const request = deepFreezePlainValue({
      ...sourceRequest,
      messages: visibleMessages.map((entry) => entry.message),
    }) as ModelRequest;
    const budget = this.services.budget === undefined
      ? UNKNOWN_BUDGET
      : validateBudgetAssessment(await this.services.budget.assess({
          request,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
    throwIfAborted(input.signal);

    const projectionBase = {
      providerGroups: groups,
      includedItems: Object.freeze(includedItems.map(freezeContextItem)),
      history: freezeHistorySelection(history),
      budget: freezeBudgetAssessment(budget),
    };
    if (budget.status === "over_budget") {
      return Object.freeze({
        ...projectionBase,
        status: "rejected",
        reason: "over_budget",
        candidateRequest: request,
        budget: projectionBase.budget as ContextBudgetAssessment & {
          readonly status: "over_budget";
        },
      });
    }
    return Object.freeze({
      ...projectionBase,
      status: "ready",
      request,
    });
  }

  async projectFromProviders<Input>(
    input: ContextProviderProjectionInput<Input>,
  ): Promise<ContextProjection> {
    throwIfAborted(input.signal);
    const providers = validateProviders(input.providers);
    const itemGroups = await Promise.all(providers.map(async (provider) => ({
      providerId: provider.id,
      items: await provider.provide(input.providerInput, input.signal),
    })));
    throwIfAborted(input.signal);
    return this.project({
      request: input.request,
      groups: itemGroups,
      currentUserMessageIndex: input.currentUserMessageIndex,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  private async projectToolResults(
    sourceRequest: ModelRequest,
    messages: readonly WorkingMessage[],
    signal: AbortSignal | undefined,
  ): Promise<readonly WorkingMessage[]> {
    const pipeline = this.services.toolResults;
    if (pipeline === undefined) return messages;

    const rawRequest = deepFreezePlainValue({
      ...sourceRequest,
      messages: messages.map((entry) => entry.message),
    }) as ModelRequest;
    const visible: WorkingMessage[] = [];
    for (const [messageIndex, entry] of messages.entries()) {
      const rawMessage = rawRequest.messages[messageIndex];
      if (rawMessage?.role !== "tool") {
        visible.push(entry);
        continue;
      }
      const toolMessage = asToolResultMessage(rawMessage);
      const archive = validateToolResultArchive(await pipeline.archive({
        request: rawRequest,
        message: toolMessage,
        messageIndex,
        ...(signal === undefined ? {} : { signal }),
      }));
      throwIfAborted(signal);
      const projected = freezeModelMessage(asToolResultMessage(
        await pipeline.toModelMessage({
          request: rawRequest,
          message: toolMessage,
          messageIndex,
          archive,
          ...(signal === undefined ? {} : { signal }),
        }),
      ));
      if (projected.toolCallId !== toolMessage.toolCallId) {
        throw new Error(
          "Context Tool Result projection must preserve toolCallId",
        );
      }
      visible.push(Object.freeze({ ...entry, message: projected }));
      throwIfAborted(signal);
    }
    return Object.freeze(visible);
  }
}

function projectPlacements(
  request: ModelRequest,
  items: readonly ContextItem[],
  currentUserMessageIndex: number,
): readonly WorkingMessage[] {
  const stable = items.filter((item) => isLaneAt(item, "stable_prefix"));
  const history = items.filter(isHistoryItem);
  const beforeCurrentUser = items.filter(
    (item) => isLaneAt(item, "before_current_user"),
  );
  const dynamicTail = items.filter((item) => isLaneAt(item, "dynamic_tail"));
  const requestMessages = request.messages.map(
    (message, requestIndex): WorkingMessage => ({
      message,
      source: "request",
      requestIndex,
    }),
  );
  const prefixBoundary = stablePrefixBoundary(requestMessages);
  let messages: WorkingMessage[] = [
    ...requestMessages.slice(0, prefixBoundary),
    ...stable.map(toWorkingMessage),
    ...history.map(toWorkingMessage),
    ...requestMessages.slice(prefixBoundary),
  ];

  if (beforeCurrentUser.length > 0) {
    const boundary = findRequestMessage(messages, currentUserMessageIndex);
    messages = [
      ...messages.slice(0, boundary),
      ...beforeCurrentUser.map(toWorkingMessage),
      ...messages.slice(boundary),
    ];
  }
  if (dynamicTail.length > 0) {
    const boundary = dynamicTailBoundary(
      messages,
      request.messages.length,
      currentUserMessageIndex,
    );
    messages = [
      ...messages.slice(0, boundary),
      ...dynamicTail.map(toWorkingMessage),
      ...messages.slice(boundary),
    ];
  }
  return Object.freeze(messages);
}

function validateProviderGroups(
  groups: readonly ContextProviderGroup[],
): readonly ContextProviderGroup[] {
  const ids = new Set<string>();
  return Object.freeze(groups.map((group) => {
    const providerId = requireIdentifier(group.providerId, "Context provider id");
    if (ids.has(providerId)) {
      throw new Error(`Duplicate Context provider id: ${providerId}`);
    }
    ids.add(providerId);
    if (!Array.isArray(group.items)) {
      throw new Error("Context provider group items must be an array");
    }
    return Object.freeze({
      providerId,
      items: Object.freeze(group.items.map(validateContextItem)),
    });
  }));
}

function validateProviders<Input>(
  providers: readonly ContextProvider<Input>[],
): readonly ContextProvider<Input>[] {
  const ids = new Set<string>();
  for (const provider of providers) {
    const id = requireIdentifier(provider.id, "Context provider id");
    if (ids.has(id)) throw new Error(`Duplicate Context provider id: ${id}`);
    ids.add(id);
  }
  return providers;
}

function validateUniqueItems(items: readonly ContextItem[]): readonly ContextItem[] {
  const ids = new Set<string>();
  return Object.freeze(items.map((item) => {
    const validated = validateContextItem(item);
    if (ids.has(validated.id)) {
      throw new Error(`Duplicate Context item id: ${validated.id}`);
    }
    ids.add(validated.id);
    return validated;
  }));
}

function validateContextItem(item: ContextItem): ContextItem {
  if (item === null || typeof item !== "object") {
    throw new Error("Context provider must return Context items");
  }
  const id = requireIdentifier(item.id, "Context item id");
  validateModelMessage(item.message);
  if (item.kind === "history") {
    validateHistoryPlacement(item.placement);
    positiveSafeInteger(item.sequence, "Context history sequence");
  } else if (item.kind === "summary") {
    validateHistoryPlacement(item.placement);
    positiveSafeInteger(item.sequence, "Context summary sequence");
    nonNegativeSafeInteger(
      item.coveredThroughSequence,
      "coveredThroughSequence",
    );
    if (item.coveredThroughSequence >= item.sequence) {
      throw new Error("coveredThroughSequence must precede summary sequence");
    }
  } else if (isLane(item)) {
    validateLanePlacement(item.placement);
    if ((item.message as ModelMessage).role === "tool") {
      throw new Error("Context lane authority must not be tool");
    }
  } else {
    throw new Error("Unknown Context item kind");
  }
  return freezeContextItem({ ...item, id });
}

function validateHistorySelection(
  selection: ContextHistorySelection,
  sourceItems: readonly ContextHistorySourceItem[],
): ContextHistorySelection {
  if (selection === null || typeof selection !== "object") {
    throw new Error("ContextHistoryPolicy must return a selection");
  }
  if (!Array.isArray(selection.items)) {
    throw new Error("ContextHistoryPolicy selection items must be an array");
  }
  const sourceById = new Map(sourceItems.map((item) => [item.id, item]));
  const selectedIds = new Set<string>();
  const items = Object.freeze(selection.items.map((item) => {
    const id = requireIdentifier(item?.id, "Selected Context history item id");
    if (selectedIds.has(id)) {
      throw new Error(`Duplicate selected Context history item id: ${id}`);
    }
    selectedIds.add(id);
    const source = sourceById.get(id);
    if (source === undefined) {
      throw new Error(
        `ContextHistoryPolicy selected an unknown history item: ${id}`,
      );
    }
    return source;
  }));
  return Object.freeze({
    items,
    ...(selection.metadata === undefined
      ? {}
      : {
          metadata: deepFreezePlainValue({ ...selection.metadata }) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
}

function isHistoryItem(item: ContextItem): item is ContextHistorySourceItem {
  return item.kind === "history" || item.kind === "summary";
}

function isLane(item: ContextItem): item is ContextLaneItem {
  return item.kind === "instruction" ||
    item.kind === "state" ||
    item.kind === "reference";
}

function isLaneAt(
  item: ContextItem,
  placement: ContextLaneItem["placement"],
): item is ContextLaneItem {
  return isLane(item) && item.placement === placement;
}

function validateHistoryPlacement(placement: string): void {
  if (placement !== "history") {
    throw new Error("History Context item placement must be history");
  }
}

function validateLanePlacement(placement: string): void {
  if (
    placement !== "stable_prefix" &&
    placement !== "before_current_user" &&
    placement !== "dynamic_tail"
  ) {
    throw new Error("Unknown Context lane placement");
  }
}

function validateCurrentUserMessageIndex(
  request: ModelRequest,
  index: number,
): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= request.messages.length) {
    throw new Error("currentUserMessageIndex must identify a request message");
  }
  if (request.messages[index]?.role !== "user") {
    throw new Error("currentUserMessageIndex must identify a user message");
  }
  return index;
}

function assertCurrentUserPreserved(
  request: ModelRequest,
  messages: readonly WorkingMessage[],
  currentUserMessageIndex: number,
): void {
  const matches = messages.filter(
    (entry) =>
      entry.source === "request" &&
      entry.requestIndex === currentUserMessageIndex,
  );
  if (matches.length !== 1) {
    throw new Error("Current user message must appear exactly once in projection");
  }
  if (matches[0]?.message !== request.messages[currentUserMessageIndex]) {
    throw new Error("Current user message must remain unchanged in projection");
  }
}

function stablePrefixBoundary(messages: readonly WorkingMessage[]): number {
  let boundary = 0;
  while (boundary < messages.length) {
    const role = messages[boundary]?.message.role;
    if (role !== "system" && role !== "developer") break;
    boundary += 1;
  }
  return boundary;
}

function findRequestMessage(
  messages: readonly WorkingMessage[],
  requestIndex: number,
): number {
  const index = messages.findIndex(
    (entry) =>
      entry.source === "request" && entry.requestIndex === requestIndex,
  );
  if (index < 0) {
    throw new Error("Current user message is not present in projection input");
  }
  return index;
}

function dynamicTailBoundary(
  messages: readonly WorkingMessage[],
  requestMessageCount: number,
  currentUserMessageIndex: number,
): number {
  if (currentUserMessageIndex === requestMessageCount - 1) {
    return findRequestMessage(messages, currentUserMessageIndex);
  }
  return messages.length;
}

function toWorkingMessage(input: { readonly message: ModelMessage }): WorkingMessage {
  return Object.freeze({ message: input.message, source: "context" });
}

function validateToolTranscript(messages: readonly ModelMessage[]): void {
  if (!Array.isArray(messages)) {
    throw new Error("Context projection messages must be an array");
  }
  let pending: Set<string> | undefined;
  let toolCallMessageIndex: number | undefined;
  for (const [messageIndex, message] of messages.entries()) {
    const validated = validateModelMessage(message);
    if (validated.role === "tool") {
      const toolMessage = asToolResultMessage(validated);
      if (pending === undefined) {
        throw new Error(
          `Orphan Tool Result at message ${messageIndex}: ${toolMessage.toolCallId}`,
        );
      }
      if (!pending.delete(toolMessage.toolCallId)) {
        throw new Error(
          `Tool Result at message ${messageIndex} does not match a pending call: ${toolMessage.toolCallId}`,
        );
      }
      if (pending.size === 0) {
        pending = undefined;
        toolCallMessageIndex = undefined;
      }
      continue;
    }
    if (pending !== undefined) {
      throw new Error(
        `Assistant Tool calls at message ${toolCallMessageIndex} are missing results before message ${messageIndex}`,
      );
    }
    if (validated.role === "assistant" && (validated.toolCalls?.length ?? 0) > 0) {
      pending = new Set(validated.toolCalls?.map((call) => call.id));
      toolCallMessageIndex = messageIndex;
    }
  }
  if (pending !== undefined) {
    throw new Error(
      `Assistant Tool calls at message ${toolCallMessageIndex} are missing results at end of projection`,
    );
  }
}

function validateModelMessage(message: ModelMessage): ModelMessage {
  if (message === null || typeof message !== "object") {
    throw new Error("Context stage must produce a ModelMessage");
  }
  if (
    message.role !== "system" &&
    message.role !== "developer" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  ) {
    throw new Error("Context stage produced an unknown ModelMessage role");
  }
  if (typeof message.content !== "string") {
    throw new Error("Context stage produced a ModelMessage without string content");
  }
  if (message.reasoningContent !== undefined) {
    if (message.role !== "assistant" || typeof message.reasoningContent !== "string") {
      throw new Error("reasoningContent is valid only on assistant messages");
    }
  }
  if (message.toolCallId !== undefined && message.role !== "tool") {
    throw new Error("toolCallId is valid only on tool messages");
  }
  if (message.role === "tool") {
    requireIdentifier(message.toolCallId ?? "", "Tool Result toolCallId");
  }
  if (message.toolCalls !== undefined) {
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) {
      throw new Error("toolCalls are valid only on assistant messages");
    }
    const ids = new Set<string>();
    for (const call of message.toolCalls) {
      const id = requireIdentifier(call.id, "Assistant Tool call id");
      requireIdentifier(call.name, "Assistant Tool call name");
      if (typeof call.argumentsJson !== "string") {
        throw new Error("Assistant Tool call argumentsJson must be a string");
      }
      if (ids.has(id)) {
        throw new Error(`Duplicate Assistant Tool call id: ${id}`);
      }
      ids.add(id);
    }
  }
  validateContentParts(message);
  return message;
}

function validateContentParts(message: ModelMessage): void {
  if (message.contentParts === undefined) return;
  if (!Array.isArray(message.contentParts)) {
    throw new Error("ModelMessage contentParts must be an array");
  }
  for (const part of message.contentParts) {
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new Error("Text content part must contain text");
      }
      continue;
    }
    if (part.type === "image_url") {
      if (
        part.imageUrl === null ||
        typeof part.imageUrl !== "object" ||
        typeof part.imageUrl.url !== "string"
      ) {
        throw new Error("Image content part must contain an image URL");
      }
      if (
        part.imageUrl.detail !== undefined &&
        part.imageUrl.detail !== "auto" &&
        part.imageUrl.detail !== "low" &&
        part.imageUrl.detail !== "high"
      ) {
        throw new Error("Image content part has an unknown detail level");
      }
      continue;
    }
    throw new Error("ModelMessage contains an unknown content part");
  }
}

function asToolResultMessage(message: ModelMessage): ContextToolResultMessage {
  validateModelMessage(message);
  if (message.role !== "tool" || message.toolCallId === undefined) {
    throw new Error("Context Tool Result pipeline requires a tool message");
  }
  return message as ContextToolResultMessage;
}

function validateToolResultArchive(
  archive: ContextToolResultArchive,
): ContextToolResultArchive {
  if (archive === null || typeof archive !== "object") {
    throw new Error("Context Tool Result archive must return a receipt");
  }
  const id = requireIdentifier(archive.id, "Context Tool Result archive id");
  return deepFreezePlainValue({ ...archive, id }) as ContextToolResultArchive;
}

function validateBudgetAssessment(
  assessment: ContextBudgetAssessment,
): ContextBudgetAssessment {
  if (assessment === null || typeof assessment !== "object") {
    throw new Error("Context budget evaluator must return an assessment");
  }
  if (
    assessment.status !== "within_budget" &&
    assessment.status !== "over_budget" &&
    assessment.status !== "unknown"
  ) {
    throw new Error("Context budget evaluator returned an unknown status");
  }
  if (assessment.estimatedInputTokens !== undefined) {
    nonNegativeSafeInteger(
      assessment.estimatedInputTokens,
      "estimatedInputTokens",
    );
  }
  if (assessment.inputLimitTokens !== undefined) {
    nonNegativeSafeInteger(assessment.inputLimitTokens, "inputLimitTokens");
  }
  return freezeBudgetAssessment(assessment);
}

function freezeModelMessage(message: ModelMessage): ModelMessage {
  return deepFreezePlainValue({ ...message }) as ModelMessage;
}

function freezeContextItem<Item extends ContextItem>(item: Item): Item {
  return deepFreezePlainValue({ ...item }) as Item;
}

function freezeHistorySelection(
  selection: ContextHistorySelection,
): ContextHistorySelection {
  return deepFreezePlainValue({ ...selection }) as ContextHistorySelection;
}

function freezeBudgetAssessment(
  assessment: ContextBudgetAssessment,
): ContextBudgetAssessment {
  return deepFreezePlainValue({ ...assessment }) as ContextBudgetAssessment;
}

function deepFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezePlainValue));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreezePlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
