import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ModelTitleGenerator } from "../dist/session-title/generator.js";
import ModelSessionTitleGenerator, { selectTitleModel } from "../dist/session-title/providers/model.js";
import { TitleGenerationError } from "../dist/session-title/types.js";
import { resolveConfiguredModel } from "../dist/models/config.js";

const route = { provider: "fixture", model: "chat" };
const usage = { inputTokens: 30, outputTokens: 4, totalTokens: 34, source: "provider" };
const signal = () => new AbortController().signal;
const input = (overrides = {}) => ({ text: "修复会话标题", model: route, signal: signal(), ...overrides });
function fixture(events, options = {}) {
  const requests = [];
  const model = { async *stream(request, requestSignal) { requests.push({ request, signal: requestSignal }); yield* events; } };
  return { requests, generator: new ModelTitleGenerator({ model, ...options }) };
}

test("title generation uses one independent request and returns only completed visible text and usage", async () => {
  const f = fixture([
    { type: "start", model: route }, { type: "reasoning_delta", text: "private reasoning" },
    { type: "text_delta", text: "会话" }, { type: "text_delta", text: "标题修复" },
    { type: "done", finishReason: "stop", usage },
  ], { resolveModel: () => ({ model: route, reasoningEffort: "none", maxOutputTokens: 256 }) });
  const requestInput = input();
  assert.deepEqual(await f.generator.generate(requestInput), { title: "会话标题修复", model: route, usage });
  const captured = f.requests[0];
  assert.equal(captured.signal, requestInput.signal);
  assert.equal(captured.request.maxOutputTokens, 256);
  assert.equal(captured.request.reasoningEffort, "none");
  assert.deepEqual(captured.request.tools, []);
  assert.deepEqual(captured.request.metadata, { purpose: "session-title" });
  assert.equal(captured.request.invocationScope, undefined);
  assert.equal(captured.request.instructions.length, 1);
  assert.equal(captured.request.messages.length, 1);
  assert.equal(JSON.parse(captured.request.messages[0].content).firstHumanMessage, requestInput.text);
  assert.doesNotMatch(captured.request.messages[0].content, /private reasoning/u);
});

test("long Unicode and escaped input are clipped by the complete JSON byte size", async () => {
  const f = fixture([{ type: "text_delta", text: "测试标题" }, { type: "done" }]);
  await f.generator.generate(input({ text: '\u001b[31m中文😀\\"\n'.repeat(3000) }));
  const framed = f.requests[0].request.messages[0].content;
  assert.ok(Buffer.byteLength(framed, "utf8") <= 4096);
  const seed = JSON.parse(framed).firstHumanMessage;
  assert.ok(seed.length > 100);
  assert.equal(seed.isWellFormed?.() ?? !/[\uD800-\uDBFF]$/u.test(seed), true);
  assert.doesNotMatch(seed, /\u001b|\[31m/u);
  assert.equal(f.requests[0].request.maxOutputTokens, 512);
});

test("recognized success finishes accept a cleaned and UTF-8 bounded title", async () => {
  for (const finishReason of [undefined, "stop", "completed", "end_turn"]) {
    const f = fixture([{ type: "text_delta", text: '\u001b[31m# **修复会话标题**\u001b[0m' }, { type: "done", ...(finishReason === undefined ? {} : { finishReason }) }]);
    assert.equal((await f.generator.generate(input())).title, "修复会话标题");
  }
  const long = fixture([{ type: "text_delta", text: "标题😀".repeat(30) }, { type: "done" }]);
  const title = (await long.generator.generate(input())).title;
  assert.ok(Buffer.byteLength(title, "utf8") <= 80);
  assert.equal(title.isWellFormed?.() ?? !/[\uD800-\uDBFF]$/u.test(title), true);
  const link = fixture([{ type: "text_delta", text: "- [标题修复](https://invalid.example)" }, { type: "done" }]);
  assert.equal((await link.generator.generate(input())).title, "标题修复");
});

test("partial failures, tools and malformed completion never become accepted titles", async () => {
  const prefix = { type: "text_delta", text: "uncommitted text" };
  const cases = [
    [[prefix], "incomplete_stream", true],
    [[{ type: "done" }], "empty_title", true],
    [[{ type: "reasoning_delta", text: "Only private thought" }, { type: "done" }], "empty_title", true],
    [[prefix, { type: "error", error: { code: "network_error", retryable: true, message: "transport failed" } }], "network_error", true],
    [[prefix, { type: "error", error: { code: "missing_api_key", retryable: false, message: "missing" } }], "missing_api_key", false],
    [[prefix, { type: "tool_call", call: { id: "call", name: "shell", argumentsJson: "{}" } }], "unexpected_tool", false],
    [[prefix, { type: "done", finishReason: "length" }], "output_limit", false],
    [[prefix, { type: "done", finishReason: "max_tokens" }], "output_limit", false],
    [[prefix, { type: "done", finishReason: "content_filter" }], "invalid_finish", false],
    [[prefix, { type: "done" }, { type: "error", error: { code: "network_error", retryable: true, message: "late failure" } }], "invalid_stream", false],
    [[{ type: "text_delta", text: "```typescript\nconst x = 1\n```" }, { type: "done" }], "invalid_title", false],
    [[{ type: "text_delta", text: "Title\nHere is an explanation" }, { type: "done" }], "invalid_title", false],
  ];
  for (const [events, code, retryable] of cases) {
    await assert.rejects(fixture(events).generator.generate(input()), error => error instanceof TitleGenerationError && error.code === code && error.retryable === retryable, code);
  }
});

test("abort before dispatch and during a stream reject and never accept partial content", async () => {
  const before = new AbortController(); before.abort();
  const f = fixture([{ type: "text_delta", text: "title" }, { type: "done" }]);
  await assert.rejects(f.generator.generate(input({ signal: before.signal })), { code: "aborted", retryable: false });
  assert.equal(f.requests.length, 0);
  const during = new AbortController();
  let observedSignal;
  const generator = new ModelTitleGenerator({ model: { async *stream(_request, requestSignal) {
    observedSignal = requestSignal;
    yield { type: "text_delta", text: "partial" };
    await new Promise(resolve => { requestSignal.addEventListener("abort", resolve, { once: true }); queueMicrotask(() => during.abort()); });
    yield { type: "done" };
  } } });
  await assert.rejects(generator.generate(input({ signal: during.signal })), { code: "aborted", retryable: false });
  assert.equal(observedSignal, during.signal);
});

test("unknown adapter throws are not retried or exposed as provider diagnostics", async () => {
  const generator = new ModelTitleGenerator({ model: { async *stream() { throw new Error("private transport message"); } } });
  await assert.rejects(generator.generate(input()), error => error.code === "stream_failed" && error.retryable === false && !error.message.includes("private"));
});

function spec(id, overrides = {}) {
  return { id, status: "active", input: { text: true, image: false }, reasoning: false, toolCalling: false, developerRole: false, ...overrides };
}
function configuration(models = [spec("chat")]) {
  return { schemaVersion: 1, providers: [{ id: "fixture", protocol: "fixture", baseUrl: "https://invalid.example", auth: { type: "none" }, headers: {}, developerRoleMode: "system-fallback", request: { streamUsage: true, supportsTemperature: false, maxTokensField: "max_tokens", extraBody: {} }, catalog: { enabled: false }, models }], defaultModel: route, fallbackModels: [], maxRetries: 20 };
}

test("title route selection disables supported reasoning and never silently crosses providers", () => {
  const configurable = configuration([spec("chat", { reasoning: true, reasoningControl: { format: "deepseek-chat", efforts: ["none", "high"], defaultEffort: "high" }, maxOutputTokens: 900 })]);
  assert.deepEqual(selectTitleModel(configurable, route), { model: route, reasoningEffort: "none", maxOutputTokens: 900, reasoningOnly: false });
  const onlyThinking = configuration([spec("chat", { reasoning: true })]);
  assert.equal(selectTitleModel(onlyThinking, route).reasoningOnly, true);
  const alternate = configuration([spec("chat", { reasoning: true }), spec("unavailable", { status: "unavailable" }), spec("plain")]);
  assert.deepEqual(selectTitleModel(alternate, route).model, { provider: "fixture", model: "plain" });
  assert.deepEqual(selectTitleModel(alternate, route, true).model, route);
  const differentProvider = configuration([spec("chat", { reasoning: true })]);
  differentProvider.providers.push({ ...differentProvider.providers[0], id: "other", models: [spec("plain")] });
  assert.deepEqual(selectTitleModel(differentProvider, route).model, route);
});

test("model title Provider reloads configuration and uses measured single-attempt requests", async () => {
  const ctx = new Context();
  const calls = [];
  let configurationLoads = 0;
  let current = configuration([spec("chat", { reasoning: true, maxOutputTokens: 1500 })]);
  ctx.provide("sessions", { dataDirectory: "/fixture/data" });
  ctx.provide("models", {
    async load(value) { assert.deepEqual(value, { dataDirectory: "/fixture/data" }); configurationLoads++; return current; },
    open(value) { return {
      configuredModel: { getDefaultModel: () => value.defaultModel, resolve: ref => resolveConfiguredModel(value, ref) },
      model: { stream() { throw new Error("RetryingModel must not be used"); } },
      measuredModel: { async *stream(request) { calls.push(request); yield { type: "text_delta", text: "Title" }; yield { type: "done", usage }; } },
    }; },
  });
  const fiber = ctx.plugin(ModelSessionTitleGenerator);
  await fiber;
  try {
    assert.deepEqual((await ctx.sessionTitleGenerator.generate(input())).usage, usage);
    assert.equal(calls[0].maxOutputTokens, 1500, "reasoning-only 2048 budget is capped to the model ceiling");
    current = configuration([spec("chat", { reasoning: true, reasoningControl: { format: "deepseek-chat", efforts: ["none", "high"], defaultEffort: "high" } })]);
    await ctx.sessionTitleGenerator.generate(input());
    assert.equal(calls[1].reasoningEffort, "none");
    assert.equal(calls[1].maxOutputTokens, 512);
    assert.equal(configurationLoads, 2);
  } finally { await ctx.fiber.dispose(); }
});

test("Provider disposal drains its accepted stream after the controller cancels it", async () => {
  const ctx = new Context();
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  ctx.provide("sessions", { dataDirectory: "/fixture/data" });
  ctx.provide("models", {
    async load() { return configuration(); },
    open() { return { configuredModel: { getDefaultModel: () => route }, measuredModel: { async *stream(_request, requestSignal) {
      notifyStarted();
      await new Promise(resolve => requestSignal.addEventListener("abort", resolve, { once: true }));
      yield { type: "error", error: { code: "aborted", retryable: false, message: "cancelled" } };
    } } }; },
  });
  const fiber = ctx.plugin(ModelSessionTitleGenerator);
  await fiber;
  const service = ctx.sessionTitleGenerator;
  const controller = new AbortController();
  const operation = service.generate(input({ signal: controller.signal }));
  const rejected = assert.rejects(operation, { code: "aborted", retryable: false });
  await started;
  let disposed = false;
  const disposing = fiber.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false);
  controller.abort();
  await rejected;
  await disposing;
  assert.equal(disposed, true);
  await assert.rejects(service.generate(input()), /session_title_generator_closed/u);
  await ctx.fiber.dispose();
});
