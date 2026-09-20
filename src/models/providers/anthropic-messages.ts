import type {
  Model,
  ModelError,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from "../../core/model/model.js";
import type { ModelAdapterFactoryInput } from "../types.js";
import {
  AnthropicRequestError,
  mapAnthropicRequest,
} from "./anthropic-messages-request.js";
import {
  abortedError,
  contextOverflow,
  errorEvent,
  isSignalAborted,
  jsonRecord,
  networkError,
  optionalRecord,
  record,
  safeProviderMessage,
  StreamParseError,
  tokenCount,
} from "./shared.js";
import { decodeSse } from "./sse.js";

export const ANTHROPIC_MESSAGES_PROTOCOL = "anthropic-messages";

interface ContentBlockState {
  readonly type: "text" | "thinking" | "tool_use";
  readonly id?: string;
  readonly name?: string;
  readonly initialInput?: unknown;
  partialJson: string;
  emitted: boolean;
}

interface UsageAccumulator {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export function createAnthropicMessagesAdapter(
  input: ModelAdapterFactoryInput,
): Model {
  return new AnthropicMessagesModel(input);
}

class AnthropicMessagesModel implements Model {
  constructor(private readonly input: ModelAdapterFactoryInput) {}

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let body: Readonly<Record<string, unknown>>;
    let authorityDegraded: boolean;
    try {
      const mapped = mapAnthropicRequest(request, this.input);
      body = mapped.body;
      authorityDegraded = mapped.authorityDegraded;
    } catch (error: unknown) {
      yield errorEvent(requestError(error));
      return;
    }
    if (signal?.aborted === true) {
      yield errorEvent(abortedError(signal.reason));
      return;
    }

    let response: Response;
    try {
      response = await this.input.fetch(`${this.input.model.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...this.input.headers,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      yield errorEvent(networkError(
        error,
        signal,
        "Anthropic network request failed",
      ));
      return;
    }
    if (!response.ok) {
      yield errorEvent(await httpError(response));
      return;
    }
    if (response.body === null) {
      yield errorEvent({
        code: "stream_parse_error",
        message: "Anthropic response has no stream body",
        retryable: true,
      });
      return;
    }

    const blocks = new Map<number, ContentBlockState>();
    const usage: UsageAccumulator = {};
    let started = false;
    let stopped = false;
    let finishReason: string | undefined;
    try {
      for await (const sse of decodeSse(response)) {
        const event = jsonRecord(sse.data, "Anthropic SSE data");
        const type = typeof event.type === "string" ? event.type : sse.event;
        switch (type) {
          case "message_start": {
            if (started) throw new StreamParseError("Anthropic emitted message_start twice");
            const message = record(event.message, "Anthropic message_start.message");
            mergeUsage(usage, message.usage);
            const actualModel = typeof message.model === "string" && message.model.length > 0
              ? message.model
              : this.input.model.ref.model;
            started = true;
            yield Object.freeze({
              type: "start" as const,
              model: Object.freeze({
                provider: this.input.model.ref.provider,
                model: actualModel,
              }),
              developerRoleMode: "system-fallback" as const,
              ...(authorityDegraded ? { authorityDegraded: true } : {}),
            });
            break;
          }
          case "content_block_start": {
            requireStarted(started, type);
            const index = tokenCount(event.index, "Anthropic content block index");
            if (blocks.has(index)) {
              throw new StreamParseError("Anthropic content block index was started twice");
            }
            const block = record(event.content_block, "Anthropic content block");
            const state = startBlock(block);
            blocks.set(index, state);
            if (state.type === "text" && typeof block.text === "string" && block.text.length > 0) {
              yield Object.freeze({ type: "text_delta" as const, text: block.text });
            }
            if (
              state.type === "thinking" && typeof block.thinking === "string" &&
              block.thinking.length > 0
            ) {
              yield Object.freeze({
                type: "reasoning_delta" as const,
                text: block.thinking,
              });
            }
            break;
          }
          case "content_block_delta": {
            requireStarted(started, type);
            const index = tokenCount(event.index, "Anthropic content block index");
            const state = blocks.get(index);
            if (state === undefined) {
              throw new StreamParseError("Anthropic content delta has no started block");
            }
            const delta = record(event.delta, "Anthropic content block delta");
            if (delta.type === "text_delta") {
              if (state.type !== "text" || typeof delta.text !== "string") {
                throw new StreamParseError("Anthropic text delta does not match its block");
              }
              if (delta.text.length > 0) {
                yield Object.freeze({ type: "text_delta" as const, text: delta.text });
              }
            } else if (delta.type === "thinking_delta") {
              if (state.type !== "thinking" || typeof delta.thinking !== "string") {
                throw new StreamParseError("Anthropic thinking delta does not match its block");
              }
              if (delta.thinking.length > 0) {
                yield Object.freeze({
                  type: "reasoning_delta" as const,
                  text: delta.thinking,
                });
              }
            } else if (delta.type === "input_json_delta") {
              if (state.type !== "tool_use" || typeof delta.partial_json !== "string") {
                throw new StreamParseError("Anthropic Tool input delta does not match its block");
              }
              state.partialJson += delta.partial_json;
            } else if (delta.type !== "signature_delta") {
              throw new StreamParseError("Anthropic content delta type is unsupported");
            }
            break;
          }
          case "content_block_stop": {
            requireStarted(started, type);
            const index = tokenCount(event.index, "Anthropic content block index");
            const state = blocks.get(index);
            if (state === undefined) {
              throw new StreamParseError("Anthropic stopped an unknown content block");
            }
            if (state.type === "tool_use") {
              yield Object.freeze({
                type: "tool_call" as const,
                call: completeToolCall(state),
              });
            }
            break;
          }
          case "message_delta": {
            requireStarted(started, type);
            const delta = record(event.delta, "Anthropic message delta");
            if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
              if (typeof delta.stop_reason !== "string") {
                throw new StreamParseError("Anthropic stop_reason must be a string or null");
              }
              finishReason = delta.stop_reason;
            }
            mergeUsage(usage, event.usage);
            break;
          }
          case "message_stop":
            requireStarted(started, type);
            stopped = true;
            break;
          case "ping":
            break;
          case "error":
            yield errorEvent(providerStreamError(event.error));
            return;
          default:
            throw new StreamParseError("Anthropic SSE event type is unsupported");
        }
        if (stopped) break;
      }
      if (!started || !stopped) {
        throw new StreamParseError("Anthropic stream ended before message_stop");
      }
      if ([...blocks.values()].some((block) => block.type === "tool_use" && !block.emitted)) {
        throw new StreamParseError("Anthropic Tool block ended without content_block_stop");
      }
    } catch (error: unknown) {
      yield errorEvent(isSignalAborted(signal)
        ? abortedError(signal?.reason)
        : {
          code: "stream_parse_error",
          message: error instanceof StreamParseError
            ? error.message
            : "Anthropic stream could not be parsed",
          retryable: false,
        });
      return;
    }
    const normalizedUsage = completeUsage(usage);
    yield Object.freeze({
      type: "done" as const,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
    });
  }
}

function startBlock(block: Record<string, unknown>): ContentBlockState {
  if (block.type === "text") {
    if (block.text !== undefined && typeof block.text !== "string") {
      throw new StreamParseError("Anthropic text block has invalid text");
    }
    return { type: "text", partialJson: "", emitted: false };
  }
  if (block.type === "thinking") {
    if (block.thinking !== undefined && typeof block.thinking !== "string") {
      throw new StreamParseError("Anthropic thinking block is invalid");
    }
    return { type: "thinking", partialJson: "", emitted: false };
  }
  if (block.type === "tool_use") {
    if (
      typeof block.id !== "string" || block.id.length === 0 ||
      typeof block.name !== "string" || block.name.length === 0
    ) {
      throw new StreamParseError("Anthropic Tool block is missing id or name");
    }
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      initialInput: block.input,
      partialJson: "",
      emitted: false,
    };
  }
  throw new StreamParseError("Anthropic content block type is unsupported");
}

function completeToolCall(state: ContentBlockState): ModelToolCall {
  if (state.emitted) throw new StreamParseError("Anthropic Tool Call was emitted twice");
  if (state.type !== "tool_use" || state.id === undefined || state.name === undefined) {
    throw new StreamParseError("Anthropic Tool Call is incomplete");
  }
  const argumentsJson = state.partialJson.length > 0
    ? state.partialJson
    : JSON.stringify(state.initialInput ?? {});
  if (argumentsJson === undefined) {
    throw new StreamParseError("Anthropic Tool Call input is not serializable");
  }
  try {
    JSON.parse(argumentsJson);
  } catch {
    throw new StreamParseError("Anthropic Tool Call arguments are malformed JSON");
  }
  state.emitted = true;
  return Object.freeze({ id: state.id, name: state.name, argumentsJson });
}

function mergeUsage(accumulator: UsageAccumulator, value: unknown): void {
  if (value === undefined || value === null) return;
  const usage = record(value, "Anthropic usage");
  if (usage.input_tokens !== undefined) {
    accumulator.inputTokens = tokenCount(usage.input_tokens, "usage.input_tokens");
  }
  if (usage.output_tokens !== undefined) {
    accumulator.outputTokens = tokenCount(usage.output_tokens, "usage.output_tokens");
  }
  if (usage.cache_read_input_tokens !== undefined) {
    accumulator.cachedInputTokens = tokenCount(
      usage.cache_read_input_tokens,
      "usage.cache_read_input_tokens",
    );
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    accumulator.cacheWriteInputTokens = tokenCount(
      usage.cache_creation_input_tokens,
      "usage.cache_creation_input_tokens",
    );
  }
}

function completeUsage(usage: UsageAccumulator): ModelUsage | undefined {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const inputTokens = usage.inputTokens + (usage.cachedInputTokens ?? 0) +
    (usage.cacheWriteInputTokens ?? 0);
  return Object.freeze({
    inputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    outputTokens: usage.outputTokens,
    totalTokens: inputTokens + usage.outputTokens,
    source: "provider" as const,
  });
}

async function httpError(response: Response): Promise<ModelError> {
  let message = `Anthropic Provider returned HTTP ${response.status}`;
  let providerType = "";
  try {
    const parsed = JSON.parse(await response.text()) as unknown;
    const root = record(parsed, "Anthropic error response");
    const error = optionalRecord(root.error, "Anthropic error response.error") ?? root;
    if (typeof error.message === "string") message = safeProviderMessage(error.message);
    if (typeof error.type === "string") providerType = error.type;
  } catch {
    // HTTP status remains authoritative when the body is malformed.
  }
  if (contextOverflow(providerType, message)) {
    return { code: "context_overflow", message, retryable: false, status: response.status };
  }
  return {
    code: "http_error",
    message,
    retryable: response.status === 408 || response.status === 409 ||
      response.status === 429 || response.status >= 500,
    status: response.status,
  };
}

function providerStreamError(value: unknown): ModelError {
  const error = record(value, "Anthropic stream error");
  const message = typeof error.message === "string"
    ? safeProviderMessage(error.message)
    : "Anthropic Provider returned a stream error";
  const type = typeof error.type === "string" ? error.type : "";
  return contextOverflow(type, message)
    ? { code: "context_overflow", message, retryable: false }
    : { code: "provider_error", message, retryable: false };
}

function requestError(error: unknown): ModelError {
  return {
    code: "invalid_request",
    message: error instanceof AnthropicRequestError
      ? error.message
      : "Anthropic request could not be mapped",
    retryable: false,
  };
}
function requireStarted(started: boolean, type: string | undefined): void {
  if (!started) throw new StreamParseError(`Anthropic emitted ${type ?? "an event"} before start`);
}
