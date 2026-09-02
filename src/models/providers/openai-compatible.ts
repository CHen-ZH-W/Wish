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
  mapOpenAIRequest,
  OpenAIRequestError,
} from "./openai-compatible-request.js";
import { decodeSse } from "./sse.js";

export const OPENAI_CHAT_COMPLETIONS_PROTOCOL = "openai-chat-completions";

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
  emitted: boolean;
}

export function createOpenAICompatibleAdapter(
  input: ModelAdapterFactoryInput,
): Model {
  return new OpenAICompatibleModel(input);
}

class OpenAICompatibleModel implements Model {
  constructor(private readonly input: ModelAdapterFactoryInput) {}

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let body: Readonly<Record<string, unknown>>;
    let authorityDegraded: boolean;
    try {
      const mapped = mapOpenAIRequest(request, this.input);
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
      response = await this.input.fetch(
        `${this.input.model.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this.input.headers,
          },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error: unknown) {
      yield errorEvent(fetchError(error, signal));
      return;
    }
    if (!response.ok) {
      yield errorEvent(await httpError(response));
      return;
    }
    if (response.body === null) {
      yield errorEvent({
        code: "stream_parse_error",
        message: "OpenAI-compatible response has no stream body",
        retryable: true,
      });
      return;
    }

    yield Object.freeze({
      type: "start" as const,
      model: freezeModelRef(this.input.model.ref),
      ...(this.input.model.developerRoleMode === "unsupported"
        ? {}
        : { developerRoleMode: this.input.model.developerRoleMode }),
      ...(authorityDegraded ? { authorityDegraded: true } : {}),
    });

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    let receivedDone = false;
    try {
      for await (const message of decodeSse(response)) {
        if (message.data === "[DONE]") {
          receivedDone = true;
          break;
        }
        const chunk = jsonRecord(message.data, "OpenAI-compatible SSE data");
        if (chunk.error !== undefined) {
          yield errorEvent(providerStreamError(chunk.error));
          return;
        }
        if (chunk.usage !== undefined) {
          usage = parseUsage(chunk.usage);
        }
        const choice = firstChoice(chunk.choices);
        if (choice === undefined) continue;
        const delta = optionalRecord(choice.delta, "OpenAI-compatible choice.delta");
        if (delta !== undefined) {
          const reasoning = firstString(
            delta.reasoning_content,
            delta.reasoning,
          );
          if (reasoning !== undefined && reasoning.length > 0) {
            yield Object.freeze({ type: "reasoning_delta" as const, text: reasoning });
          }
          const content = textDelta(delta.content);
          if (content !== undefined && content.length > 0) {
            yield Object.freeze({ type: "text_delta" as const, text: content });
          }
          accumulateToolCalls(toolCalls, delta.tool_calls);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== "string") {
            throw new StreamParseError(
              "OpenAI-compatible finish_reason must be a string or null",
            );
          }
          finishReason = choice.finish_reason;
          for (const call of completeToolCalls(toolCalls)) {
            yield Object.freeze({ type: "tool_call" as const, call });
          }
        }
      }
      if (!receivedDone) {
        throw new StreamParseError(
          "OpenAI-compatible stream ended without a [DONE] marker",
        );
      }
      for (const call of completeToolCalls(toolCalls)) {
        yield Object.freeze({ type: "tool_call" as const, call });
      }
    } catch (error: unknown) {
      yield errorEvent(isSignalAborted(signal)
        ? abortedError(signal?.reason)
        : {
          code: "stream_parse_error",
          message: error instanceof StreamParseError
            ? error.message
            : "OpenAI-compatible stream could not be parsed",
          retryable: false,
        });
      return;
    }
    yield Object.freeze({
      type: "done" as const,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
    });
  }
}

function accumulateToolCalls(
  accumulators: Map<number, ToolCallAccumulator>,
  value: unknown,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new StreamParseError("OpenAI-compatible tool_calls delta must be an array");
  }
  for (const raw of value) {
    const delta = record(raw, "OpenAI-compatible Tool Call delta");
    const index = nonNegativeInteger(delta.index, "Tool Call delta index");
    const current = accumulators.get(index) ?? {
      id: "",
      name: "",
      argumentsJson: "",
      emitted: false,
    };
    if (current.emitted) {
      throw new StreamParseError("OpenAI-compatible Tool Call changed after completion");
    }
    if (delta.id !== undefined) {
      if (typeof delta.id !== "string" || delta.id.length === 0) {
        throw new StreamParseError("OpenAI-compatible Tool Call id is invalid");
      }
      if (current.id.length > 0 && current.id !== delta.id) {
        throw new StreamParseError("OpenAI-compatible Tool Call id changed during streaming");
      }
      current.id = delta.id;
    }
    const fn = optionalRecord(delta.function, "OpenAI-compatible Tool Call function");
    if (fn?.name !== undefined) {
      if (typeof fn.name !== "string") {
        throw new StreamParseError("OpenAI-compatible Tool Call name is invalid");
      }
      current.name += fn.name;
    }
    if (fn?.arguments !== undefined) {
      if (typeof fn.arguments !== "string") {
        throw new StreamParseError("OpenAI-compatible Tool Call arguments are invalid");
      }
      current.argumentsJson += fn.arguments;
    }
    accumulators.set(index, current);
  }
}

function completeToolCalls(
  accumulators: Map<number, ToolCallAccumulator>,
): readonly ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const [, accumulator] of [...accumulators.entries()].sort(([a], [b]) => a - b)) {
    if (accumulator.emitted) continue;
    if (accumulator.id.length === 0 || accumulator.name.length === 0) {
      throw new StreamParseError("OpenAI-compatible Tool Call is incomplete");
    }
    try {
      JSON.parse(accumulator.argumentsJson);
    } catch {
      throw new StreamParseError("OpenAI-compatible Tool Call arguments are malformed JSON");
    }
    accumulator.emitted = true;
    calls.push(Object.freeze({
      id: accumulator.id,
      name: accumulator.name,
      argumentsJson: accumulator.argumentsJson,
    }));
  }
  return Object.freeze(calls);
}

function parseUsage(value: unknown): ModelUsage {
  const usage = record(value, "OpenAI-compatible usage");
  const inputTokens = tokenCount(usage.prompt_tokens, "usage.prompt_tokens");
  const outputTokens = tokenCount(
    usage.completion_tokens,
    "usage.completion_tokens",
  );
  const reportedTotal = usage.total_tokens === undefined
    ? undefined
    : tokenCount(usage.total_tokens, "usage.total_tokens");
  const details = optionalRecord(
    usage.prompt_tokens_details,
    "usage.prompt_tokens_details",
  );
  const cachedInputTokens = details?.cached_tokens === undefined
    ? undefined
    : tokenCount(details.cached_tokens, "usage.prompt_tokens_details.cached_tokens");
  const rawCacheWrite = details?.cache_creation_tokens ?? usage.cache_creation_input_tokens;
  const cacheWriteInputTokens = rawCacheWrite === undefined
    ? undefined
    : tokenCount(rawCacheWrite, "usage.cache_creation_input_tokens");
  return Object.freeze({
    inputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    outputTokens,
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
    source: "provider" as const,
  });
}

function firstChoice(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new StreamParseError("OpenAI-compatible choices must be an array");
  }
  if (value.length === 0) return undefined;
  const choices = value.map((choice) => record(choice, "OpenAI-compatible choice"));
  return choices.find((choice) => choice.index === 0) ?? choices[0];
}

function textDelta(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      const item = record(part, "OpenAI-compatible content delta");
      return typeof item.text === "string" ? item.text : "";
    }).join("");
  }
  throw new StreamParseError("OpenAI-compatible content delta is invalid");
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new StreamParseError("OpenAI-compatible reasoning delta is invalid");
  }
  return value;
}

function providerStreamError(value: unknown): ModelError {
  const error = record(value, "OpenAI-compatible stream error");
  const message = typeof error.message === "string"
    ? safeProviderMessage(error.message)
    : "OpenAI-compatible Provider returned a stream error";
  const code = typeof error.code === "string" ? error.code : "";
  return contextOverflow(code, message)
    ? { code: "context_overflow", message, retryable: false }
    : { code: "provider_error", message, retryable: false };
}

async function httpError(response: Response): Promise<ModelError> {
  let message = `OpenAI-compatible Provider returned HTTP ${response.status}`;
  let providerCode = "";
  try {
    const text = await response.text();
    if (text.length > 0) {
      const parsed = JSON.parse(text) as unknown;
      const root = optionalRecord(parsed, "Provider error");
      const error = root === undefined
        ? undefined
        : optionalRecord(root.error, "Provider error.error") ?? root;
      if (typeof error?.message === "string") message = safeProviderMessage(error.message);
      if (typeof error?.code === "string") providerCode = error.code;
    }
  } catch {
    // HTTP status remains the stable error signal when the body is malformed.
  }
  if (contextOverflow(providerCode, message)) {
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

function fetchError(error: unknown, signal: AbortSignal | undefined): ModelError {
  if (signal?.aborted === true || isAbortError(error)) return abortedError(signal?.reason);
  return {
    code: "network_error",
    message: "OpenAI-compatible network request failed",
    retryable: true,
  };
}

function requestError(error: unknown): ModelError {
  return {
    code: "invalid_request",
    message: error instanceof OpenAIRequestError
      ? error.message
      : "OpenAI-compatible request could not be mapped",
    retryable: false,
  };
}

function abortedError(reason: unknown): ModelError {
  return {
    code: "aborted",
    message: reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Model request was aborted",
    retryable: false,
  };
}

function errorEvent(error: ModelError): ModelStreamEvent {
  return Object.freeze({ type: "error" as const, error: Object.freeze(error) });
}

function contextOverflow(code: string, message: string): boolean {
  return /context[_ -]length|context window|too many tokens|maximum context/iu.test(
    `${code} ${message}`,
  );
}

function safeProviderMessage(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function tokenCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StreamParseError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  return tokenCount(value, path);
}

function jsonRecord(value: string, path: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown, path);
  } catch (error: unknown) {
    if (error instanceof StreamParseError) throw error;
    throw new StreamParseError(`${path} is malformed JSON`);
  }
}

function optionalRecord(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamParseError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function freezeModelRef(model: { readonly provider: string; readonly model: string }) {
  return Object.freeze({ provider: model.provider, model: model.model });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class StreamParseError extends Error {}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
