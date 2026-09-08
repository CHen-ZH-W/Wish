import assert from "node:assert/strict";
import test from "node:test";

import { ModelRequestTokenCounter } from "../dist/models/input-tokens.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import {
  createConfiguredModelRequestTokenCounter,
} from "../dist/models/runtime.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function request() {
  return {
    model: { ...model },
    messages: [
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "reasoning",
        toolCalls: [{
          id: "call-1",
          name: "lookup",
          argumentsJson: '{"query":"value"}',
        }],
      },
      {
        role: "user",
        content: "question",
        contentParts: [{
          type: "image_url",
          imageUrl: { url: "data:image/png;base64,YQ==", detail: "low" },
        }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Lookup a value",
      inputSchemaJson: '{"type":"object","properties":{"query":{"type":"string"}}}',
    }],
    maxOutputTokens: 512,
    metadata: { trace: { id: "trace-1" } },
  };
}

test("counts one immutable complete request for an exact model identity", async () => {
  const counter = new ModelRequestTokenCounter();
  let tokenizerInput;
  counter.register(model, {
    method: "fixture-request-tokenizer-v1",
    count(input) {
      tokenizerInput = input;
      assert.equal(input.request.messages[0].reasoningContent, "reasoning");
      assert.equal(
        input.request.messages[0].toolCalls[0].argumentsJson,
        '{"query":"value"}',
      );
      assert.equal(input.request.messages[1].contentParts[0].type, "image_url");
      assert.match(input.request.tools[0].inputSchemaJson, /properties/u);
      return 73;
    },
  });
  const source = request();
  const count = await counter.count({ request: source });

  source.messages[0].content = "mutated";
  source.messages[1].contentParts[0].imageUrl.url = "mutated";
  source.tools[0].inputSchemaJson = "{}";
  assert.deepEqual(count, {
    inputTokens: 73,
    method: "fixture-request-tokenizer-v1",
  });
  assert.equal(tokenizerInput.request.messages[0].content, "answer");
  assert.equal(
    tokenizerInput.request.messages[1].contentParts[0].imageUrl.url,
    "data:image/png;base64,YQ==",
  );
  assert.match(tokenizerInput.request.tools[0].inputSchemaJson, /properties/u);
  assert.equal(Object.isFrozen(tokenizerInput.request), true);
  assert.equal(Object.isFrozen(tokenizerInput.request.messages), true);
  assert.equal(Object.isFrozen(tokenizerInput.request.messages[1].contentParts), true);
  assert.equal(Object.isFrozen(tokenizerInput.request.tools), true);
  assert.equal(Object.isFrozen(count), true);
});

test("returns unavailable for an unregistered model or tokenizer failure", async () => {
  const counter = new ModelRequestTokenCounter();
  counter.register(model, {
    method: "failing-tokenizer",
    count() {
      throw new Error("tokenizer data unavailable");
    },
  });

  assert.equal(await counter.count({
    request: { ...request(), model: { provider: "provider", model: "other" } },
  }), undefined);
  assert.equal(await counter.count({ request: request() }), undefined);
});

test("rejects duplicate registration and invalid counts", async () => {
  const counter = new ModelRequestTokenCounter();
  counter.register(model, { method: "fixture", count: () => -1 });
  assert.throws(() => counter.register(model, {
    method: "duplicate",
    count: () => 1,
  }), /already registered/u);
  await assert.rejects(
    counter.count({ request: request() }),
    /inputTokens must be a non-negative safe integer/u,
  );
  assert.throws(() => new ModelRequestTokenCounter().register(model, {
    method: " untrimmed ",
    count: () => 1,
  }), /non-empty trimmed string/u);
});

test("passes abort to the active request tokenizer", async () => {
  const counter = new ModelRequestTokenCounter();
  const controller = new AbortController();
  const reason = new Error("stop request counting");
  let observedSignal;
  counter.register(model, {
    method: "abortable-tokenizer",
    count(input) {
      observedSignal = input.signal;
      controller.abort(reason);
      throw reason;
    },
  });

  await assert.rejects(counter.count({
    request: request(),
    signal: controller.signal,
  }), reason);
  assert.strictEqual(observedSignal, controller.signal);
});

function provider(id, protocol, modelId, auth) {
  return {
    id,
    protocol,
    baseUrl: `https://${id}.example.test/v1`,
    auth,
    headers: { "x-provider": id },
    developerRoleMode: protocol === "anthropic-messages"
      ? "system-fallback"
      : "native",
    request: {
      streamUsage: true,
      supportsTemperature: true,
      maxTokensField: "max_tokens",
      extraBody: {},
    },
    catalog: { enabled: false },
    models: [{
      id: modelId,
      status: "active",
      contextWindowTokens: 100_000,
      maxOutputTokens: 4096,
      input: { text: true, image: true },
      reasoning: false,
      toolCalling: true,
      developerRole: protocol !== "anthropic-messages",
    }],
  };
}

test("configured counter uses Anthropic's exact endpoint and current credentials", async () => {
  const configuration = loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      providers: [
        provider("anthropic", "anthropic-messages", "claude-test", {
          type: "x-api-key",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        }),
        provider("openai", "openai-chat-completions", "gpt-test", {
          type: "bearer",
          apiKeyEnv: "OPENAI_API_KEY",
        }),
      ],
      defaultModel: "anthropic/claude-test",
      fallbackModels: [],
      maxRetries: 0,
    },
    availableProtocols: ["anthropic-messages", "openai-chat-completions"],
  });
  let anthropicKey = "key-1";
  const calls = [];
  const counter = createConfiguredModelRequestTokenCounter({
    configuration,
    environment: () => ({
      ANTHROPIC_API_KEY: anthropicKey,
      OPENAI_API_KEY: "openai-key",
    }),
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ input_tokens: 137 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const anthropicRequest = {
    model: { provider: "anthropic", model: "claude-test" },
    messages: [
      { role: "developer", content: "Follow the contract" },
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          name: "lookup",
          argumentsJson: '{"query":"value"}',
        }],
      },
      { role: "tool", content: "result", toolCallId: "call-1" },
    ],
    tools: [{
      name: "lookup",
      description: "Lookup a value",
      inputSchemaJson: '{"type":"object"}',
    }],
    temperature: 0.2,
    maxOutputTokens: 512,
  };

  assert.deepEqual(await counter.count({ request: anthropicRequest }), {
    inputTokens: 137,
    method: "anthropic-messages-count-tokens-v1",
  });
  anthropicKey = "key-2";
  await counter.count({ request: anthropicRequest });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://anthropic.example.test/v1/messages/count_tokens");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], "key-1");
  assert.equal(calls[1].init.headers["x-api-key"], "key-2");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "claude-test");
  assert.equal(body.system[0].text, "Follow the contract");
  assert.equal(body.messages[1].content[0].type, "tool_use");
  assert.equal(body.messages[2].content[0].type, "tool_result");
  assert.equal(body.tools[0].name, "lookup");
  assert.equal("stream" in body, false);
  assert.equal("max_tokens" in body, false);
  assert.equal("temperature" in body, false);

  const openAIRequest = {
    ...request(),
    model: { provider: "openai", model: "gpt-test" },
  };
  assert.equal(await counter.count({ request: openAIRequest }), undefined);
  assert.equal(calls.length, 2);
});

test("configured Anthropic counter reports unavailable on Provider failure", async () => {
  const configuration = loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      providers: [provider(
        "anthropic",
        "anthropic-messages",
        "claude-test",
        { type: "none" },
      )],
      defaultModel: "anthropic/claude-test",
      fallbackModels: [],
      maxRetries: 0,
    },
    availableProtocols: ["anthropic-messages"],
  });
  const counter = createConfiguredModelRequestTokenCounter({
    configuration,
    fetch: async () => new Response("unavailable", { status: 503 }),
  });

  assert.equal(await counter.count({
    request: {
      model: { provider: "anthropic", model: "claude-test" },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    },
  }), undefined);
});
