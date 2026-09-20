import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelRef,
  ModelRequest,
} from "../core/model/model.js";

export interface ModelRequestTokenizerInput {
  /** Complete final request immediately before Provider conversion. */
  readonly request: ModelRequest;
  readonly signal?: AbortSignal;
}

/** Request-only tokenizer for one exact provider/model identity. */
export interface ModelRequestTokenizer {
  readonly method: string;
  count(
    input: ModelRequestTokenizerInput,
  ): Promise<number> | number;
}

export interface ModelRequestTokenCount {
  readonly inputTokens: number;
  readonly method: string;
}

interface RegisteredTokenizer {
  readonly method: string;
  readonly count: ModelRequestTokenizer["count"];
}

/**
 * Models-owned adapter for preflight input counting. It is deliberately
 * separate from usage estimation, which also needs a completed ModelOutput.
 */
export class ModelRequestTokenCounter {
  private readonly tokenizers = new Map<string, RegisteredTokenizer>();

  register(model: ModelRef, tokenizer: ModelRequestTokenizer): void {
    const reference = freezeModelRef(model);
    const method = requireIdentifier(tokenizer.method, "Model tokenizer method");
    if (typeof tokenizer.count !== "function") {
      throw new Error("Model request tokenizer count must be a function");
    }
    const key = modelKey(reference);
    if (this.tokenizers.has(key)) {
      throw new Error(
        `Request tokenizer for ${displayModel(reference)} is already registered`,
      );
    }
    this.tokenizers.set(key, Object.freeze({
      method,
      count: tokenizer.count.bind(tokenizer),
    }));
  }

  has(model: ModelRef): boolean {
    return this.tokenizers.has(modelKey(freezeModelRef(model)));
  }

  async count(
    input: ModelRequestTokenizerInput,
  ): Promise<ModelRequestTokenCount | undefined> {
    throwIfAborted(input.signal);
    const request = snapshotRequest(input.request);
    const tokenizer = this.tokenizers.get(modelKey(request.model));
    if (tokenizer === undefined) return undefined;

    let inputTokens: number;
    try {
      inputTokens = await tokenizer.count(Object.freeze({
        request,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }));
    } catch {
      throwIfAborted(input.signal);
      return undefined;
    }
    throwIfAborted(input.signal);
    requireTokenCount(inputTokens, "Model request inputTokens");
    return Object.freeze({ inputTokens, method: tokenizer.method });
  }
}

function snapshotRequest(request: ModelRequest): ModelRequest {
  if (request === null || typeof request !== "object") {
    throw new Error("Model request tokenizer requires a ModelRequest");
  }
  if (!Array.isArray(request.instructions) || !Array.isArray(request.messages) || !Array.isArray(request.tools)) {
    throw new Error("Model request tokenizer requires instruction, message and Tool arrays");
  }
  return Object.freeze({
    model: freezeModelRef(request.model),
    instructions: Object.freeze(request.instructions.map((instruction) =>
      snapshotInstruction(instruction)
    )),
    messages: Object.freeze(request.messages.map(snapshotMessage)),
    tools: Object.freeze(request.tools.map((tool) => Object.freeze({
      name: requireIdentifier(tool.name, "Model Tool name"),
      description: typeof tool.description === "string"
        ? tool.description
        : (() => { throw new Error("Model Tool description must be a string"); })(),
      inputSchemaJson: typeof tool.inputSchemaJson === "string"
        ? tool.inputSchemaJson
        : (() => { throw new Error("Model Tool schema must be a string"); })(),
    }))),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.metadata === undefined
      ? {}
      : { metadata: snapshotPlainRecord(request.metadata) }),
    ...(request.invocationScope === undefined
      ? {}
      : { invocationScope: Object.freeze({ ...request.invocationScope }) }),
  });
}

function snapshotInstruction(
  instruction: ModelRequest["instructions"][number],
): ModelRequest["instructions"][number] {
  if (instruction === null || typeof instruction !== "object") {
    throw new Error("Model request tokenizer received an invalid instruction");
  }
  if (instruction.role !== "system" && instruction.role !== "developer") {
    throw new Error("Model request tokenizer instruction role is invalid");
  }
  if (typeof instruction.content !== "string") {
    throw new Error("Model request tokenizer instruction content must be a string");
  }
  return Object.freeze({ role: instruction.role, content: instruction.content });
}

function snapshotMessage(message: ModelMessage): ModelMessage {
  if (message === null || typeof message !== "object") {
    throw new Error("Model request tokenizer received an invalid message");
  }
  if (typeof message.content !== "string") {
    throw new Error("Model request tokenizer message content must be a string");
  }
  return Object.freeze({
    role: message.role,
    content: message.content,
    ...(message.contentParts === undefined
      ? {}
      : { contentParts: snapshotContentParts(message.contentParts) }),
    ...(message.toolCallId === undefined
      ? {}
      : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
        toolCalls: Object.freeze(message.toolCalls.map((call) => Object.freeze({
          id: call.id,
          name: call.name,
          argumentsJson: call.argumentsJson,
        }))),
      }),
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoningContent: message.reasoningContent }),
  });
}

function snapshotContentParts(
  parts: readonly ModelMessageContentPart[],
): readonly ModelMessageContentPart[] {
  if (!Array.isArray(parts)) {
    throw new Error("Model request tokenizer contentParts must be an array");
  }
  return Object.freeze(parts.map((part) =>
    part.type === "text"
      ? Object.freeze({ type: "text" as const, text: part.text })
      : Object.freeze({
        type: "image_url" as const,
        imageUrl: Object.freeze({ ...part.imageUrl }),
      })
  ));
}

function snapshotPlainRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, snapshotPlainValue(item)]),
  ));
}

function snapshotPlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotPlainValue));
  if (isPlainRecord(value)) return snapshotPlainRecord(value);
  return value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeModelRef(model: ModelRef): ModelRef {
  if (model === null || typeof model !== "object") {
    throw new Error("Model reference must be an object");
  }
  return Object.freeze({
    provider: requireIdentifier(model.provider, "Model Provider id"),
    model: requireIdentifier(model.model, "Model id"),
  });
}

function modelKey(model: ModelRef): string {
  return `${model.provider}\u0000${model.model}`;
}

function displayModel(model: ModelRef): string {
  return `${model.provider}/${model.model}`;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Model request token counting was aborted", {
    cause: signal.reason,
  });
}
