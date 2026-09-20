import {
  RetryingModel,
  type Model,
  type ModelOutput,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
} from "../src/core/model/model.js";
import type { OutputEvent } from "../src/core/events/event.js";

const request: ModelRequest = {
  model: { provider: "provider", model: "model" },
  instructions: [{ role: "system", content: "Be exact" }],
  messages: [{ role: "user", content: "hello" }],
  tools: [{
    name: "lookup",
    description: "Lookup a value",
    inputSchemaJson: '{"type":"object"}',
  }],
};

const adapter: Model = {
  async *stream(input): AsyncIterable<ModelStreamEvent> {
    yield { type: "start", model: input.model };
    yield { type: "text_delta", text: "done" };
    yield { type: "done", finishReason: "stop", providerCreatedAt: 1_789_963_200_000 };
  },
};

const model: Model = new RetryingModel(adapter, {
  fallbackModels: [{ provider: "backup", model: "model" }],
});

const output: ModelOutput = {
  model: request.model,
  reasoning: "",
  text: "done",
  toolCalls: [],
  finishReason: "stop",
};

const providerUsageWithoutCacheDetail: ModelUsage = {
  inputTokens: 10,
  outputTokens: 2,
  totalTokens: 12,
  source: "provider",
};

const estimatedUsageWithExplicitZeroCache: ModelUsage = {
  inputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 2,
  totalTokens: 12,
  source: "estimated",
  estimationMethod: "fixture-tokenizer-v1",
};

const event: OutputEvent = {
  schemaVersion: 1,
  eventId: "event-1",
  sequence: 1,
  type: "model.stream",
  occurredAt: "2026-01-01T00:00:00Z",
  runId: "run-1",
  stepId: "step-1",
  payload: { type: "text_delta", text: "done" },
};

void model.stream(request);
void output;
void providerUsageWithoutCacheDetail;
void estimatedUsageWithExplicitZeroCache;
void event;
