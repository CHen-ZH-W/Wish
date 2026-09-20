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
  mapOpenAIResponsesRequest,
  OpenAIResponsesRequestError,
} from "./openai-responses-request.js";
import {
  abortedError,
  contextOverflow,
  errorEvent,
  freezeModelRef,
  isSignalAborted,
  jsonRecord,
  networkError,
  optionalRecord,
  record,
  safeProviderMessage,
  stableProviderCreatedAt,
  StreamParseError,
  tokenCount,
} from "./shared.js";
import { decodeSse } from "./sse.js";

export const OPENAI_RESPONSES_PROTOCOL = "openai-responses";

interface ToolCallAccumulator {
  itemId: string;
  callId: string;
  name: string;
  argumentsJson: string;
  emitted: boolean;
}

export function createOpenAIResponsesAdapter(
  input: ModelAdapterFactoryInput,
): Model {
  return new OpenAIResponsesModel(input);
}

class OpenAIResponsesModel implements Model {
  constructor(private readonly input: ModelAdapterFactoryInput) {}

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    let body: Readonly<Record<string, unknown>>;
    let authorityDegraded: boolean;
    try {
      const mapped = mapOpenAIResponsesRequest(request, this.input);
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
      response = await this.input.fetch(`${this.input.model.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.input.headers,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      yield errorEvent(networkError(
        error,
        signal,
        "OpenAI Responses network request failed",
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
        message: "OpenAI Responses response has no stream body",
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

    const toolCalls = new Map<string, ToolCallAccumulator>();
    const textByItem = new Map<string, string>();
    const reasoningByItem = new Map<string, string>();
    let emittedToolCalls = 0;
    let terminal = false;
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    let providerCreatedAt: number | undefined;
    try {
      for await (const sse of decodeSse(response)) {
        if (sse.data === "[DONE]") break;
        const event = jsonRecord(sse.data, "OpenAI Responses SSE data");
        const type = typeof event.type === "string" ? event.type : sse.event;
        switch (type) {
          case "response.created": {
            const created = record(
              event.response,
              "OpenAI Responses created response",
            );
            if (created.created_at !== undefined) {
              providerCreatedAt = stableProviderCreatedAt(
                providerCreatedAt,
                created.created_at,
                "OpenAI Responses created_at",
              );
            }
            break;
          }
          case "response.output_item.added": {
            const item = record(event.item, "OpenAI Responses output item");
            if (item.type === "function_call") {
              upsertToolCall(toolCalls, item);
            }
            break;
          }
          case "response.output_text.delta":
          case "response.refusal.delta": {
            const delta = requiredString(
              event.delta,
              `OpenAI Responses ${type} delta`,
              true,
            );
            const itemId = requiredString(
              event.item_id,
              `OpenAI Responses ${type} item_id`,
            );
            textByItem.set(itemId, (textByItem.get(itemId) ?? "") + delta);
            if (delta.length > 0) {
              yield Object.freeze({ type: "text_delta" as const, text: delta });
            }
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            const delta = requiredString(
              event.delta,
              `OpenAI Responses ${type} delta`,
              true,
            );
            const itemId = requiredString(
              event.item_id,
              `OpenAI Responses ${type} item_id`,
            );
            reasoningByItem.set(
              itemId,
              (reasoningByItem.get(itemId) ?? "") + delta,
            );
            if (delta.length > 0) {
              yield Object.freeze({ type: "reasoning_delta" as const, text: delta });
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const itemId = requiredString(
              event.item_id,
              "OpenAI Responses Tool Call item_id",
            );
            const delta = requiredString(
              event.delta,
              "OpenAI Responses Tool Call arguments delta",
              true,
            );
            const current = toolCalls.get(itemId) ?? emptyToolCall(itemId);
            ensureMutable(current);
            current.argumentsJson += delta;
            toolCalls.set(itemId, current);
            break;
          }
          case "response.function_call_arguments.done": {
            const itemId = requiredString(
              event.item_id,
              "OpenAI Responses Tool Call item_id",
            );
            const current = toolCalls.get(itemId) ?? emptyToolCall(itemId);
            ensureMutable(current);
            current.argumentsJson = requiredString(
              event.arguments,
              "OpenAI Responses Tool Call arguments",
              true,
            );
            toolCalls.set(itemId, current);
            break;
          }
          case "response.output_item.done": {
            const item = record(event.item, "OpenAI Responses completed output item");
            if (item.type === "function_call") {
              const call = completeToolCall(toolCalls, item);
              if (call !== undefined) {
                emittedToolCalls += 1;
                yield Object.freeze({ type: "tool_call" as const, call });
              }
            } else if (item.type === "message") {
              const delta = remainingText(textByItem, item);
              if (delta.length > 0) {
                yield Object.freeze({ type: "text_delta" as const, text: delta });
              }
            } else if (item.type === "reasoning") {
              const delta = missingReasoning(reasoningByItem, item);
              if (delta.length > 0) {
                yield Object.freeze({ type: "reasoning_delta" as const, text: delta });
              }
            }
            break;
          }
          case "response.completed":
          case "response.incomplete": {
            const completed = record(
              event.response,
              `OpenAI Responses ${type} response`,
            );
            for (const item of responseOutput(completed)) {
              if (item.type !== "function_call") continue;
              const call = completeToolCall(toolCalls, item);
              if (call !== undefined) {
                emittedToolCalls += 1;
                yield Object.freeze({ type: "tool_call" as const, call });
              }
            }
            usage = completed.usage === undefined || completed.usage === null
              ? undefined
              : parseUsage(completed.usage);
            if (completed.created_at !== undefined) {
              providerCreatedAt = stableProviderCreatedAt(
                providerCreatedAt,
                completed.created_at,
                "OpenAI Responses created_at",
              );
            }
            finishReason = mapFinishReason(completed, emittedToolCalls > 0);
            terminal = true;
            break;
          }
          case "response.failed": {
            const failed = record(event.response, "OpenAI Responses failed response");
            yield errorEvent(providerResponseError(failed));
            return;
          }
          case "error":
            yield errorEvent(providerStreamError(event));
            return;
          default:
            break;
        }
      }
      if (!terminal) {
        throw new StreamParseError(
          "OpenAI Responses stream ended without a terminal response event",
        );
      }
    } catch (error: unknown) {
      yield errorEvent(isSignalAborted(signal)
        ? abortedError(signal?.reason)
        : {
          code: "stream_parse_error",
          message: error instanceof StreamParseError
            ? error.message
            : "OpenAI Responses stream could not be parsed",
          retryable: false,
        });
      return;
    }

    yield Object.freeze({
      type: "done" as const,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
      ...(providerCreatedAt === undefined ? {} : { providerCreatedAt }),
    });
  }
}

function emptyToolCall(itemId: string): ToolCallAccumulator {
  return { itemId, callId: "", name: "", argumentsJson: "", emitted: false };
}

function upsertToolCall(
  calls: Map<string, ToolCallAccumulator>,
  item: Record<string, unknown>,
): ToolCallAccumulator {
  const itemId = requiredString(item.id, "OpenAI Responses Tool Call item id");
  const current = calls.get(itemId) ?? emptyToolCall(itemId);
  ensureMutable(current);
  mergeStableString(current, "callId", item.call_id, "call_id");
  mergeStableString(current, "name", item.name, "name");
  if (item.arguments !== undefined) {
    const value = requiredString(
      item.arguments,
      "OpenAI Responses Tool Call arguments",
      true,
    );
    if (current.argumentsJson.length === 0) current.argumentsJson = value;
    else if (value.length > 0 && current.argumentsJson !== value) {
      if (value.startsWith(current.argumentsJson)) current.argumentsJson = value;
      else {
        throw new StreamParseError(
          "OpenAI Responses Tool Call arguments changed during streaming",
        );
      }
    }
  }
  calls.set(itemId, current);
  return current;
}

function completeToolCall(
  calls: Map<string, ToolCallAccumulator>,
  item: Record<string, unknown>,
): ModelToolCall | undefined {
  const itemId = requiredString(item.id, "OpenAI Responses Tool Call item id");
  if (calls.get(itemId)?.emitted === true) return undefined;
  const current = upsertToolCall(calls, item);
  if (current.callId.length === 0 || current.name.length === 0) {
    throw new StreamParseError("OpenAI Responses Tool Call is incomplete");
  }
  try {
    JSON.parse(current.argumentsJson);
  } catch {
    throw new StreamParseError(
      "OpenAI Responses Tool Call arguments are malformed JSON",
    );
  }
  current.emitted = true;
  return Object.freeze({
    id: current.callId,
    name: current.name,
    argumentsJson: current.argumentsJson,
  });
}

function mergeStableString(
  target: ToolCallAccumulator,
  field: "callId" | "name",
  value: unknown,
  label: string,
): void {
  if (value === undefined) return;
  const next = requiredString(value, `OpenAI Responses Tool Call ${label}`);
  if (target[field].length > 0 && target[field] !== next) {
    throw new StreamParseError(
      `OpenAI Responses Tool Call ${label} changed during streaming`,
    );
  }
  target[field] = next;
}

function ensureMutable(call: ToolCallAccumulator): void {
  if (call.emitted) {
    throw new StreamParseError(
      "OpenAI Responses Tool Call changed after completion",
    );
  }
}

function remainingText(
  streamed: Map<string, string>,
  item: Record<string, unknown>,
): string {
  const itemId = requiredString(item.id, "OpenAI Responses message item id");
  const finalText = messageText(item.content);
  const previous = streamed.get(itemId) ?? "";
  if (!finalText.startsWith(previous)) {
    throw new StreamParseError(
      "OpenAI Responses message changed after streaming",
    );
  }
  streamed.set(itemId, finalText);
  return finalText.slice(previous.length);
}

function missingReasoning(
  streamed: Map<string, string>,
  item: Record<string, unknown>,
): string {
  const itemId = requiredString(item.id, "OpenAI Responses reasoning item id");
  const previous = streamed.get(itemId) ?? "";
  if (previous.length > 0) return "";
  const summary = optionalArray(item.summary, "OpenAI Responses reasoning summary")
    .map((part) => {
      const value = record(part, "OpenAI Responses reasoning summary part");
      return typeof value.text === "string" ? value.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
  streamed.set(itemId, summary);
  return summary;
}

function messageText(value: unknown): string {
  return optionalArray(value, "OpenAI Responses message content")
    .map((part) => {
      const content = record(part, "OpenAI Responses message content part");
      if (content.type === "output_text") {
        return requiredString(
          content.text,
          "OpenAI Responses output text",
          true,
        );
      }
      if (content.type === "refusal") {
        return requiredString(
          content.refusal,
          "OpenAI Responses refusal",
          true,
        );
      }
      return "";
    })
    .join("");
}

function responseOutput(
  response: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  return optionalArray(response.output, "OpenAI Responses output").map((item) =>
    record(item, "OpenAI Responses output item")
  );
}

function parseUsage(value: unknown): ModelUsage {
  const usage = record(value, "OpenAI Responses usage");
  const inputTokens = tokenCount(usage.input_tokens, "usage.input_tokens");
  const outputTokens = tokenCount(usage.output_tokens, "usage.output_tokens");
  const reportedTotal = usage.total_tokens === undefined
    ? undefined
    : tokenCount(usage.total_tokens, "usage.total_tokens");
  const details = optionalRecord(
    usage.input_tokens_details,
    "usage.input_tokens_details",
  );
  const cachedInputTokens = details?.cached_tokens === undefined
    ? undefined
    : tokenCount(details.cached_tokens, "usage.input_tokens_details.cached_tokens");
  const cacheWriteInputTokens = details?.cache_write_tokens === undefined
    ? undefined
    : tokenCount(
      details.cache_write_tokens,
      "usage.input_tokens_details.cache_write_tokens",
    );
  return Object.freeze({
    inputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    outputTokens,
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
    source: "provider" as const,
  });
}

function mapFinishReason(
  response: Record<string, unknown>,
  hasToolCalls: boolean,
): string | undefined {
  if (response.status === "completed") return hasToolCalls ? "tool_calls" : "stop";
  const details = optionalRecord(
    response.incomplete_details,
    "OpenAI Responses incomplete_details",
  );
  if (typeof details?.reason === "string" && details.reason.length > 0) {
    return details.reason === "max_output_tokens" ? "length" : details.reason;
  }
  return typeof response.status === "string" ? response.status : undefined;
}

function providerResponseError(response: Record<string, unknown>): ModelError {
  const error = optionalRecord(response.error, "OpenAI Responses error");
  const details = optionalRecord(
    response.incomplete_details,
    "OpenAI Responses incomplete details",
  );
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string"
    ? safeProviderMessage(error.message)
    : typeof details?.reason === "string"
      ? safeProviderMessage(details.reason)
      : "OpenAI Responses Provider failed to generate a response";
  return contextOverflow(code, message)
    ? { code: "context_overflow", message, retryable: false }
    : { code: "provider_error", message, retryable: false };
}

function providerStreamError(event: Record<string, unknown>): ModelError {
  const code = typeof event.code === "string" ? event.code : "";
  const message = typeof event.message === "string"
    ? safeProviderMessage(event.message)
    : "OpenAI Responses Provider returned a stream error";
  return contextOverflow(code, message)
    ? { code: "context_overflow", message, retryable: false }
    : { code: "provider_error", message, retryable: false };
}

async function httpError(response: Response): Promise<ModelError> {
  let message = `OpenAI Responses Provider returned HTTP ${response.status}`;
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
    return {
      code: "context_overflow",
      message,
      retryable: false,
      status: response.status,
    };
  }
  return {
    code: "http_error",
    message,
    retryable: response.status === 408 || response.status === 409 ||
      response.status === 429 || response.status >= 500,
    status: response.status,
  };
}

function requestError(error: unknown): ModelError {
  return {
    code: "invalid_request",
    message: error instanceof OpenAIResponsesRequestError
      ? error.message
      : "OpenAI Responses request could not be mapped",
    retryable: false,
  };
}
function optionalArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new StreamParseError(`${path} must be an array`);
  return value;
}

function requiredString(
  value: unknown,
  path: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new StreamParseError(`${path} must be a string`);
  }
  return value;
}
