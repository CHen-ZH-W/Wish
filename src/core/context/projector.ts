import type { ModelMessage, ModelRequest } from "../model/types.js";
import type {
  ContextAdmissionPolicy,
  ContextBudgetAssessment,
  ContextHistoryPolicy,
  ContextHistorySelection,
  ContextHistorySourceItem,
  ContextHistoryItem,
  ContextItem,
  ContextItemRenderer,
  ContextItemResolver,
  ContextLaneItem,
  ContextMessageNormalizer,
  ContextProjection,
  ContextProjectionInput,
  ContextProjectorServices,
  ContextProvider,
  ContextProviderGroup,
  ContextProviderProjectionInput,
} from "./context.js";

export type {
  ContextAdmissionInput,
  ContextAdmissionPolicy,
  ContextAuthority,
  ContextBudgetAssessment,
  ContextBudgetPolicy,
  ContextBudgetPolicyInput,
  ContextBudgetStatus,
  ContextHistoryItem,
  ContextHistoryPolicy,
  ContextHistoryPolicyInput,
  ContextHistorySelection,
  ContextHistorySourceItem,
  ContextItem,
  ContextItemRenderInput,
  ContextItemRenderer,
  ContextItemResolutionInput,
  ContextItemResolver,
  ContextLaneItem,
  ContextLaneKind,
  ContextLaneMessage,
  ContextLanePlacement,
  ContextMessageNormalizationInput,
  ContextMessageNormalizer,
  ContextProjection,
  ContextProjectionInput,
  ContextProjectorServices,
  ContextProvider,
  ContextProviderGroup,
  ContextProviderProjectionInput,
  ContextSummaryItem,
} from "./context.js";

const STRICT_ITEM_RESOLVER: ContextItemResolver = {
  resolve(input) {
    return input.groups.flatMap((group) => group.items);
  },
};

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

const IDENTITY_ITEM_RENDERER: ContextItemRenderer = {
  render(input) {
    return input.item.message;
  },
};

const IDENTITY_MESSAGE_NORMALIZER: ContextMessageNormalizer = {
  normalize(input) {
    return input.messages;
  },
};

const IDENTITY_ADMISSION_POLICY: ContextAdmissionPolicy = {
  admit(input) {
    return input.message;
  },
};

interface WorkingMessage {
  readonly message: ModelMessage;
  readonly source: "request" | "context";
  readonly requestIndex?: number;
}

/**
 * Owns the complete Context pipeline while delegating every variable decision
 * to a narrow typed Service or Policy.
 */
export class ContextProjector {
  private readonly itemResolver: ContextItemResolver;
  private readonly historyPolicy: ContextHistoryPolicy;
  private readonly itemRenderer: ContextItemRenderer;
  private readonly messageNormalizer: ContextMessageNormalizer;
  private readonly admissionPolicy: ContextAdmissionPolicy;

  constructor(private readonly services: ContextProjectorServices = {}) {
    this.itemResolver = services.itemResolver ?? STRICT_ITEM_RESOLVER;
    this.historyPolicy = services.historyPolicy ?? EXPLICIT_HISTORY_POLICY;
    this.itemRenderer = services.itemRenderer ?? IDENTITY_ITEM_RENDERER;
    this.messageNormalizer =
      services.messageNormalizer ?? IDENTITY_MESSAGE_NORMALIZER;
    this.admissionPolicy = services.admissionPolicy ?? IDENTITY_ADMISSION_POLICY;
  }

  async project(input: ContextProjectionInput): Promise<ContextProjection> {
    throwIfAborted(input.signal);
    const sourceRequest = deepFreezePlainValue({
      ...input.request,
    }) as ModelRequest;
    const groups = validateProviderGroups(input.groups);
    const resolvedItems = validateUniqueItems(await this.itemResolver.resolve({
      request: sourceRequest,
      groups,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));

    throwIfAborted(input.signal);
    const sourceHistory = resolvedItems.filter(isHistoryItem);
    const history = validateHistorySelection(
      await this.historyPolicy.select({
        request: sourceRequest,
        items: sourceHistory,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
    const includedItems = validateUniqueItems([
      ...resolvedItems.filter((item) => !isHistoryItem(item)),
      ...history.items,
    ]);

    throwIfAborted(input.signal);
    const rendered = await Promise.all(includedItems.map(async (item) => ({
      item,
      message: validateModelMessage(await this.itemRenderer.render({
        request: sourceRequest,
        item,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })),
    })));

    throwIfAborted(input.signal);
    const structurallyProjected = projectPlacements(
      sourceRequest,
      rendered,
      input.currentUserMessageIndex,
    );
    const normalized = validateModelMessages(
      await this.messageNormalizer.normalize({
        request: sourceRequest,
        messages: structurallyProjected,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );

    throwIfAborted(input.signal);
    const admitted: ModelMessage[] = [];
    for (const [messageIndex, message] of normalized.entries()) {
      admitted.push(validateModelMessage(await this.admissionPolicy.admit({
        request: sourceRequest,
        message,
        messageIndex,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })));
      throwIfAborted(input.signal);
    }

    const request = deepFreezePlainValue({
      ...sourceRequest,
      messages: admitted,
    }) as ModelRequest;
    const budget = this.services.budgetPolicy === undefined
      ? undefined
      : validateBudgetAssessment(await this.services.budgetPolicy.assess({
          request,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
    throwIfAborted(input.signal);

    return Object.freeze({
      request,
      providerGroups: groups,
      includedItems: Object.freeze(includedItems.map(freezeContextItem)),
      history: freezeHistorySelection(history),
      ...(budget === undefined ? {} : { budget: freezeBudgetAssessment(budget) }),
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
      ...(input.currentUserMessageIndex === undefined
        ? {}
        : { currentUserMessageIndex: input.currentUserMessageIndex }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

function projectPlacements(
  request: ModelRequest,
  rendered: readonly {
    readonly item: ContextItem;
    readonly message: ModelMessage;
  }[],
  currentUserMessageIndex: number | undefined,
): readonly ModelMessage[] {
  const currentUser = validateCurrentUserMessageIndex(
    request,
    currentUserMessageIndex,
  );
  const stable = rendered.filter(
    (entry) => isLaneAt(entry.item, "stable_prefix"),
  );
  const history = rendered.filter((entry) => isHistoryItem(entry.item));
  const beforeCurrentUser = rendered.filter(
    (entry) => isLaneAt(entry.item, "before_current_user"),
  );
  const dynamicTail = rendered.filter(
    (entry) => isLaneAt(entry.item, "dynamic_tail"),
  );
  if (beforeCurrentUser.length > 0 && currentUser === undefined) {
    throw new Error(
      "currentUserMessageIndex is required for before_current_user context",
    );
  }

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

  if (beforeCurrentUser.length > 0 && currentUser !== undefined) {
    const boundary = findRequestMessage(messages, currentUser);
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
      currentUser,
    );
    messages = [
      ...messages.slice(0, boundary),
      ...dynamicTail.map(toWorkingMessage),
      ...messages.slice(boundary),
    ];
  }
  return messages.map((entry) => entry.message);
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
    return Object.freeze({
      providerId,
      items: Object.freeze([...group.items]),
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
): ContextHistorySelection {
  if (selection === null || typeof selection !== "object") {
    throw new Error("ContextHistoryPolicy must return a selection");
  }
  const items = Object.freeze(selection.items.map((item) => {
    const validated = validateContextItem(item);
    if (!isHistoryItem(validated)) {
      throw new Error("ContextHistoryPolicy may return only history items");
    }
    return validated;
  }));
  return {
    items,
    ...(selection.metadata === undefined
      ? {}
      : { metadata: deepFreezePlainValue({ ...selection.metadata }) as Readonly<Record<string, unknown>> }),
  };
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
  index: number | undefined,
): number | undefined {
  if (index === undefined) return undefined;
  if (!Number.isSafeInteger(index) || index < 0 || index >= request.messages.length) {
    throw new Error("currentUserMessageIndex must identify a request message");
  }
  if (request.messages[index]?.role !== "user") {
    throw new Error("currentUserMessageIndex must identify a user message");
  }
  return index;
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
  currentUserMessageIndex: number | undefined,
): number {
  if (
    currentUserMessageIndex !== undefined &&
    currentUserMessageIndex === requestMessageCount - 1
  ) {
    return findRequestMessage(messages, currentUserMessageIndex);
  }
  return messages.length;
}

function toWorkingMessage(input: {
  readonly message: ModelMessage;
}): WorkingMessage {
  return { message: input.message, source: "context" };
}

function validateModelMessages(
  messages: readonly ModelMessage[],
): readonly ModelMessage[] {
  if (!Array.isArray(messages)) {
    throw new Error("ContextMessageNormalizer must return messages");
  }
  return messages.map(validateModelMessage);
}

function validateModelMessage(message: ModelMessage): ModelMessage {
  if (message === null || typeof message !== "object") {
    throw new Error("Context stage must return a ModelMessage");
  }
  if (
    message.role !== "system" &&
    message.role !== "developer" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  ) {
    throw new Error("Context stage returned an unknown ModelMessage role");
  }
  if (typeof message.content !== "string") {
    throw new Error("Context stage returned a ModelMessage without string content");
  }
  return message;
}

function validateBudgetAssessment(
  assessment: ContextBudgetAssessment,
): ContextBudgetAssessment {
  if (
    assessment.status !== "within_budget" &&
    assessment.status !== "over_budget" &&
    assessment.status !== "unknown"
  ) {
    throw new Error("ContextBudgetPolicy returned an unknown status");
  }
  return assessment;
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
