import assert from "node:assert/strict";
import test from "node:test";

import { loadModelsConfiguration } from "../dist/models/config.js";
import { createDefaultModelAdapterRegistry } from "../dist/models/registry.js";
import { ConfiguredModel } from "../dist/models/runtime.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function sse(records) {
  const body = records.map((record) =>
    typeof record === "string" ? `data: ${record}\n\n` :
      `${record.event === undefined ? "" : `event: ${record.event}\n`}data: ${JSON.stringify(record.data)}\n\n`
  ).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function configuration(protocol, options = {}) {
  const provider = protocol === "anthropic-messages" ? "anthropic" : "openai";
  return loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      defaultModel: `${provider}/model-a`,
      providers: [{
        id: provider,
        protocol,
        baseUrl: `https://${provider}.example.test/v1`,
        auth: { type: "none" },
        developerRoleMode: options.developerRoleMode ??
          (protocol === "anthropic-messages" ? "system-fallback" : "native"),
        request: {
          streamUsage: options.streamUsage ?? true,
          supportsTemperature: options.supportsTemperature ?? true,
          maxTokensField: options.maxTokensField ?? "max_tokens",
          extraBody: options.extraBody ?? {},
        },
        models: [{
          id: "model-a",
          status: "active",
          maxOutputTokens: 2048,
          input: { text: true, image: true },
          reasoning: true,
          toolCalling: true,
          developerRole: options.developerRole ?? protocol !== "anthropic-messages",
        }],
      }],
    },
  });
}

function createModel(protocol, fetch, options) {
  return new ConfiguredModel({
    configuration: configuration(protocol, options),
    registry: createDefaultModelAdapterRegistry(),
    fetch,
  });
}

function request(provider, messages, overrides = {}) {
  return {
    model: { provider, model: "model-a" },
    messages,
    tools: [{
      name: "lookup",
      description: "Look up a value",
      inputSchemaJson: '{"type":"object","properties":{"q":{"type":"string"}}}',
    }],
    temperature: 0.2,
    maxOutputTokens: 512,
    ...overrides,
  };
}

test("OpenAI-compatible maps authority, images, Tools, reasoning, and usage", async () => {
  let captured;
  const controller = new AbortController();
  const model = createModel(
    "openai-chat-completions",
    async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return sse([
        { data: {
          choices: [{ index: 0, delta: { reasoning_content: "think " }, finish_reason: null }],
        } },
        { data: {
          choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
        } },
        { data: {
          choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, id: "call-1", function: { name: "look", arguments: '{"q":' } },
            { index: 1, id: "call-2", function: { name: "lookup", arguments: '{"q":"b"}' } },
          ] }, finish_reason: null }],
        } },
        { data: {
          choices: [{ index: 0, delta: { tool_calls: [
            { index: 0, function: { name: "up", arguments: '"a"}' } },
          ] }, finish_reason: "tool_calls" }],
        } },
        { data: {
          choices: [],
          usage: {
            prompt_tokens: 20,
            prompt_tokens_details: { cached_tokens: 4, cache_creation_tokens: 2 },
            completion_tokens: 6,
            total_tokens: 26,
          },
        } },
        "[DONE]",
      ]);
    },
    {
      developerRoleMode: "system-fallback",
      developerRole: false,
      supportsTemperature: false,
      maxTokensField: "max_completion_tokens",
      extraBody: { service_tier: "auto" },
    },
  );
  const events = await collect(model.stream(request("openai", [
    { role: "system", content: "system" },
    { role: "developer", content: "developer" },
    {
      role: "user",
      content: "question",
      contentParts: [{
        type: "image_url",
        imageUrl: { url: "https://images.example.test/a.png", detail: "high" },
      }],
    },
    {
      role: "assistant",
      content: "",
      reasoningContent: "prior thought",
      toolCalls: [{ id: "prior-1", name: "lookup", argumentsJson: '{"q":"old"}' }],
    },
    { role: "tool", content: '{"value":1}', toolCallId: "prior-1" },
  ]), controller.signal));

  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "reasoning_delta",
    "text_delta",
    "tool_call",
    "tool_call",
    "done",
  ]);
  assert.equal(events[0].developerRoleMode, "system-fallback");
  assert.equal(events[0].authorityDegraded, true);
  assert.deepEqual(events.slice(3, 5).map((event) => event.call), [
    { id: "call-1", name: "lookup", argumentsJson: '{"q":"a"}' },
    { id: "call-2", name: "lookup", argumentsJson: '{"q":"b"}' },
  ]);
  assert.deepEqual(events.at(-1).usage, {
    inputTokens: 20,
    cachedInputTokens: 4,
    cacheWriteInputTokens: 2,
    outputTokens: 6,
    totalTokens: 26,
    source: "provider",
  });
  assert.equal(captured.url, "https://openai.example.test/v1/chat/completions");
  assert.equal(captured.init.signal, controller.signal);
  assert.equal(captured.body.messages[1].role, "system");
  assert.equal(captured.body.messages[2].content[1].type, "image_url");
  assert.equal(captured.body.messages[3].tool_calls[0].id, "prior-1");
  assert.equal(captured.body.messages[4].tool_call_id, "prior-1");
  assert.equal(captured.body.tools[0].function.name, "lookup");
  assert.equal(captured.body.max_completion_tokens, 512);
  assert.equal("temperature" in captured.body, false);
  assert.deepEqual(captured.body.stream_options, { include_usage: true });
  assert.equal(captured.body.service_tier, "auto");
});

test("OpenAI-compatible preserves native developer authority and optional usage", async () => {
  let body;
  const model = createModel("openai-chat-completions", async (_url, init) => {
    body = JSON.parse(init.body);
    return sse([
      { data: { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] } },
      "[DONE]",
    ]);
  });
  const events = await collect(model.stream(request("openai", [
    { role: "developer", content: "rules" },
    { role: "user", content: "hello" },
  ], { tools: [] })));

  assert.equal(body.messages[0].role, "developer");
  assert.equal(events[0].developerRoleMode, "native");
  assert.equal("authorityDegraded" in events[0], false);
  assert.equal("usage" in events.at(-1), false);
});

test("OpenAI-compatible reports malformed streams and context overflow stably", async () => {
  const malformed = createModel(
    "openai-chat-completions",
    async () => new Response("data: {bad json}\n\n", { status: 200 }),
  );
  const malformedEvents = await collect(malformed.stream(request("openai", [
    { role: "user", content: "hello" },
  ])));
  assert.equal(malformedEvents.at(-1).error.code, "stream_parse_error");

  const overflow = createModel("openai-chat-completions", async () => new Response(
    JSON.stringify({ error: { code: "context_length_exceeded", message: "context window exceeded" } }),
    { status: 400 },
  ));
  const overflowEvents = await collect(overflow.stream(request("openai", [
    { role: "user", content: "hello" },
  ])));
  assert.equal(overflowEvents[0].error.code, "context_overflow");
  assert.equal(overflowEvents[0].error.retryable, false);
});

test("Anthropic maps system fallback, images, thinking, Tools, and cache usage", async () => {
  let captured;
  const controller = new AbortController();
  const model = createModel("anthropic-messages", async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return sse([
      { event: "message_start", data: {
        type: "message_start",
        message: {
          model: "claude-actual",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
            output_tokens: 1,
          },
        },
      } },
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" },
      } },
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "thinking_delta", thinking: "think" },
      } },
      { event: "content_block_start", data: {
        type: "content_block_start", index: 1, content_block: { type: "text", text: "" },
      } },
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 1,
        delta: { type: "text_delta", text: "answer" },
      } },
      { event: "content_block_start", data: {
        type: "content_block_start", index: 2,
        content_block: { type: "tool_use", id: "call-a", name: "lookup", input: {} },
      } },
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 2,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      } },
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 2,
        delta: { type: "input_json_delta", partial_json: '"a"}' },
      } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
      { event: "message_delta", data: {
        type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 },
      } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
  });
  const events = await collect(model.stream(request("anthropic", [
    { role: "system", content: "system" },
    { role: "developer", content: "developer" },
    {
      role: "user",
      content: "question",
      contentParts: [{
        type: "image_url",
        imageUrl: { url: "data:image/png;base64,YQ==" },
      }],
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "prior-a", name: "lookup", argumentsJson: '{"q":"old"}' }],
    },
    { role: "tool", content: '{"value":1}', toolCallId: "prior-a" },
  ]), controller.signal));

  assert.deepEqual(events.map((event) => event.type), [
    "start",
    "reasoning_delta",
    "text_delta",
    "tool_call",
    "done",
  ]);
  assert.equal(events[0].model.model, "claude-actual");
  assert.equal(events[0].developerRoleMode, "system-fallback");
  assert.equal(events[0].authorityDegraded, true);
  assert.deepEqual(events[3].call, {
    id: "call-a",
    name: "lookup",
    argumentsJson: '{"q":"a"}',
  });
  assert.deepEqual(events.at(-1).usage, {
    inputTokens: 15,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 2,
    outputTokens: 5,
    totalTokens: 20,
    source: "provider",
  });
  assert.equal(captured.url, "https://anthropic.example.test/v1/messages");
  assert.equal(captured.init.signal, controller.signal);
  assert.deepEqual(captured.body.system.map((block) => block.text), ["system", "developer"]);
  assert.equal(captured.body.messages[0].content[1].source.type, "base64");
  assert.equal(captured.body.messages[1].content[0].id, "prior-a");
  assert.equal(captured.body.messages[2].content[0].tool_use_id, "prior-a");
  assert.equal(captured.body.max_tokens, 512);
});

test("Anthropic rejects implicit developer degradation before fetch", async () => {
  let fetchCalls = 0;
  assert.throws(
    () => createModel("anthropic-messages", async () => {
      fetchCalls += 1;
      return new Response();
    }, { developerRoleMode: "native", developerRole: true }),
    /must be system-fallback for anthropic-messages/u,
  );
  assert.equal(fetchCalls, 0);
});

test("Anthropic emits one complete Tool Call and rejects malformed incremental JSON", async () => {
  const model = createModel("anthropic-messages", async () => sse([
    { event: "message_start", data: {
      type: "message_start",
      message: { model: "model-a", usage: { input_tokens: 1, output_tokens: 0 } },
    } },
    { event: "content_block_start", data: {
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "call-a", name: "lookup", input: {} },
    } },
    { event: "content_block_delta", data: {
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: "{" },
    } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  ]));
  const events = await collect(model.stream(request("anthropic", [
    { role: "user", content: "hello" },
  ])));

  assert.equal(events.filter((event) => event.type === "tool_call").length, 0);
  assert.equal(events.at(-1).error.code, "stream_parse_error");
});

test("Anthropic maps Provider context overflow without exposing a response object", async () => {
  const model = createModel("anthropic-messages", async () => new Response(
    JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "maximum context window exceeded" },
    }),
    { status: 400 },
  ));
  const events = await collect(model.stream(request("anthropic", [
    { role: "user", content: "hello" },
  ])));

  assert.equal(events[0].error.code, "context_overflow");
  assert.equal("response" in events[0].error, false);
});

for (const [protocol, provider] of [
  ["openai-chat-completions", "openai"],
  ["anthropic-messages", "anthropic"],
]) {
  test(`${protocol} passes abort to the active fetch`, async () => {
    const entered = deferred();
    const model = createModel(protocol, async (_url, init) => {
      entered.resolve(init.signal);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    });
    const controller = new AbortController();
    const eventsPromise = collect(model.stream(request(provider, [
      { role: "user", content: "hello" },
    ]), controller.signal));
    const passedSignal = await entered.promise;
    assert.equal(passedSignal, controller.signal);
    controller.abort("user_stop");
    const events = await eventsPromise;
    assert.equal(events[0].error.code, "aborted");
    assert.equal(events[0].error.message, "user_stop");
  });
}
