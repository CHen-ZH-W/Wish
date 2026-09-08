import type { ModelRef } from "../../core/model/model.js";
import type {
  ModelRequestTokenizer,
  ModelRequestTokenizerInput,
} from "../input-tokens.js";
import type {
  ModelAdapterFactoryInput,
  ModelFetch,
  ResolvedModel,
} from "../types.js";
import { ANTHROPIC_MESSAGES_PROTOCOL } from "./anthropic-messages.js";
import { mapAnthropicRequest } from "./anthropic-messages-request.js";

export const ANTHROPIC_MESSAGES_TOKEN_COUNT_METHOD =
  "anthropic-messages-count-tokens-v1";

export interface AnthropicMessagesRequestTokenizerOptions {
  readonly model: ResolvedModel;
  /** Resolve on every count so rotated credentials do not require rebuilding. */
  readonly headers:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>>);
  readonly fetch?: ModelFetch;
}

/** Exact request counter backed by Anthropic's Messages token-count endpoint. */
export function createAnthropicMessagesRequestTokenizer(
  options: AnthropicMessagesRequestTokenizerOptions,
): ModelRequestTokenizer {
  if (options.model.protocol !== ANTHROPIC_MESSAGES_PROTOCOL) {
    throw new Error(
      `Anthropic request tokenizer does not support protocol "${options.model.protocol}"`,
    );
  }
  const fetch = resolveFetch(options.fetch);
  const reference = freezeModelRef(options.model.ref);
  const configuredHeaders = options.headers;
  const resolveHeaders = typeof configuredHeaders === "function"
    ? configuredHeaders
    : () => configuredHeaders;

  return Object.freeze({
    method: ANTHROPIC_MESSAGES_TOKEN_COUNT_METHOD,
    async count({ request, signal }: ModelRequestTokenizerInput): Promise<number> {
      assertSameModel(request.model, reference);
      throwIfAborted(signal);
      const headers = snapshotHeaders(resolveHeaders());
      const adapterInput: ModelAdapterFactoryInput = Object.freeze({
        model: options.model,
        headers,
        fetch,
      });
      const mapped = mapAnthropicRequest(request, adapterInput);
      const {
        max_tokens: _maxTokens,
        stream: _stream,
        temperature: _temperature,
        ...countBody
      } = mapped.body;
      void _maxTokens;
      void _stream;
      void _temperature;

      const response = await fetch(
        `${options.model.baseUrl}/messages/count_tokens`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...headers,
          },
          body: JSON.stringify(countBody),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Anthropic token count failed with HTTP ${response.status}`,
        );
      }
      let value: unknown;
      try {
        value = await response.json() as unknown;
      } catch (error: unknown) {
        throw new Error("Anthropic token count response is not valid JSON", {
          cause: error,
        });
      }
      if (!isRecord(value)) {
        throw new Error("Anthropic token count response must be an object");
      }
      const inputTokens = value.input_tokens;
      if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0) {
        throw new Error(
          "Anthropic token count response input_tokens must be a non-negative safe integer",
        );
      }
      throwIfAborted(signal);
      return inputTokens as number;
    },
  });
}

function resolveFetch(fetch: ModelFetch | undefined): ModelFetch {
  const available = fetch ?? globalThis.fetch;
  if (typeof available !== "function") {
    throw new Error("Anthropic request tokenizer requires fetch");
  }
  return available.bind(globalThis) as ModelFetch;
}

function snapshotHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("Anthropic request tokenizer headers must be an object");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
        throw new Error(`Anthropic request tokenizer header ${name} is invalid`);
      }
      return [name, value];
    }),
  ));
}

function assertSameModel(actual: ModelRef, expected: ModelRef): void {
  if (actual.provider === expected.provider && actual.model === expected.model) {
    return;
  }
  throw new Error(
    `Anthropic request tokenizer for ${expected.provider}/${expected.model} cannot count ${actual.provider}/${actual.model}`,
  );
}

function freezeModelRef(model: ModelRef): ModelRef {
  return Object.freeze({ provider: model.provider, model: model.model });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Anthropic request token counting was aborted", {
    cause: signal.reason,
  });
}
