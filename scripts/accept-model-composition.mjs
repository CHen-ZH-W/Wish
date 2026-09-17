import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../dist/core/agent/agent.js";
import { AgentLoop } from "../dist/core/agent-loop/agent-loop.js";
import { ContextProjector } from "../dist/core/context/projector.js";
import { Runtime } from "../dist/core/runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
} from "../dist/core/tools/scheduler.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import { createDefaultModelAdapterRegistry, ModelAdapterRegistry } from "../dist/models/registry.js";
import { createConfiguredModelStack } from "../dist/models/runtime.js";
import { TokenizerUsageEstimator } from "../dist/models/usage.js";

function deterministicServices() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () => `2026-09-02T00:00:${String(++counters.time).padStart(2, "0")}Z`,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function sse(chunks) {
  return new Response(chunks.map((chunk) =>
    `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`
  ).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function configuration({ fallback = true, maxRetries = 1 } = {}) {
  return loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      defaultModel: "fixture/primary",
      fallbackModels: fallback ? ["fixture/fallback"] : [],
      maxRetries,
      providers: [{
        id: "fixture",
        protocol: "fixture-protocol",
        baseUrl: "https://fixture.example.test/v1",
        auth: { type: "none" },
        models: [{ id: "primary" }, { id: "fallback" }],
      }],
    },
    availableProtocols: ["fixture-protocol"],
  });
}

function createTools() {
  const registry = new ToolRegistry();
  const executions = [];
  registry.register({
    name: "sum",
    description: "Add two numbers",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse(input) {
      return typeof input.a === "number" && typeof input.b === "number"
        ? { ok: true, input: { a: input.a, b: input.b } }
        : { ok: false, message: "a and b are required" };
    },
    resolveCapabilities() {
      return { requirements: [] };
    },
    execute(input) {
      executions.push(input);
      return { value: input.a + input.b };
    },
  });
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize() { return { status: "allowed", policyVersion: "policy-1" }; },
      revalidate() { return { status: "valid", policyVersion: "policy-1" }; },
    },
  });
  return {
    registry,
    scheduler: new BoundedToolScheduler({ executor, maxParallelCalls: 2 }),
    executions,
  };
}

function createLoop(model, tools, environment) {
  return new AgentLoop({
    model,
    context: new ContextProjector(),
    tools: tools.registry,
    toolScheduler: tools.scheduler,
    input: {
      renderUserInput(input) { return { role: "user", content: input.payload.text }; },
      renderSteering(input) { return { role: "user", content: input.message.text }; },
    },
    environment,
  });
}

test("Agent completes the fixed Core and Models composition through retry, fallback, and Tools", async () => {
  const adapters = new ModelAdapterRegistry();
  const attempts = [];
  let fallbackCalls = 0;
  let configuredModel;
  adapters.register("fixture-protocol", (factoryInput) => ({
    async *stream(modelRequest, signal) {
      attempts.push({
        model: modelRequest.model,
        signal,
        messages: modelRequest.messages,
      });
      yield { type: "start", model: factoryInput.model.ref };
      if (factoryInput.model.ref.model === "primary") {
        yield {
          type: "error",
          error: { code: "network_error", message: "temporary", retryable: true },
        };
        return;
      }
      fallbackCalls += 1;
      if (fallbackCalls === 1) {
        configuredModel.setDefaultModel("fixture/fallback");
        yield {
          type: "tool_call",
          call: { id: "call-1", name: "sum", argumentsJson: '{"a":2,"b":3}' },
        };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "5" };
        yield { type: "done", finishReason: "stop" };
      }
    },
  }));
  const estimator = new TokenizerUsageEstimator();
  estimator.register({ provider: "fixture", model: "fallback" }, {
    method: "fixture-tokenizer-v1",
    count(input) {
      return input.output.toolCalls.length > 0
        ? { inputTokens: 10, outputTokens: 4 }
        : { inputTokens: 14, outputTokens: 1 };
    },
  });
  const stack = createConfiguredModelStack({
    configuration: configuration(),
    registry: adapters,
    usageEstimator: estimator,
    fetch: async () => new Response(),
    retry: {
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      random: () => 0.5,
    },
  });
  configuredModel = stack.configuredModel;
  const tools = createTools();
  const resolvedDefaults = [];
  const loop = createLoop(stack.model, tools, {
    resolve() {
      const model = configuredModel.getDefaultModel();
      resolvedDefaults.push(model);
      return {
        model,
        context: { providers: [], input: {} },
        tools: { context: {}, authorityVersion: "authority-1" },
      };
    },
  });
  const runtime = new Runtime({
    ...deterministicServices(),
    maxSteps: 4,
    stepPipeline: loop,
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const handle = agent.startRun({ scope: "composition", payload: { text: "2+3?" } });
  const eventsPromise = collect(agent.observe(handle.runId));
  const completion = await handle.completion;
  const events = await eventsPromise;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "5");
  assert.deepEqual(completion.result.output.model, {
    provider: "fixture",
    model: "fallback",
  });
  assert.deepEqual(completion.result.usage, {
    inputTokens: 24,
    outputTokens: 5,
    totalTokens: 29,
    source: "estimated",
    estimationMethod: "fixture-tokenizer-v1",
  });
  assert.deepEqual(resolvedDefaults.map((model) => model.model), ["primary", "fallback"]);
  assert.deepEqual(attempts.map((attempt) => attempt.model.model), [
    "primary", "primary", "fallback",
    "primary", "primary", "fallback",
  ]);
  assert.equal(attempts[3].messages.at(-1).role, "tool");
  assert.deepEqual(tools.executions, [{ a: 2, b: 3 }]);
  const modelEvents = events.filter((event) => event.type === "model.stream");
  assert.deepEqual(
    modelEvents.filter((event) => event.payload.type === "retry")
      .map((event) => event.payload.retryCount),
    [1, 2, 1, 2],
  );
  assert.equal(
    modelEvents.filter((event) => event.payload.type === "tool_call").length,
    1,
  );
  assert.equal(modelEvents.filter((event) => event.payload.type === "done").length, 2);
  assert.equal(modelEvents.every((event) => Object.isFrozen(event.payload)), true);
});

test("DeepSeek thinking Tool call replays complete reasoning and streamed usage in the next Step", async () => {
  const configuration = loadModelsConfiguration({ environment: {} });
  const requests = [];
  const fullReasoning = "Need " + "arithmetic.";
  const stack = createConfiguredModelStack({
    configuration,
    registry: createDefaultModelAdapterRegistry(),
    usageEstimator: new TokenizerUsageEstimator(),
    environment: { DEEPSEEK_API_KEY: "deepseek-test-key" },
    async fetch(url, init) {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(init.headers.authorization, "Bearer deepseek-test-key");
      const body = JSON.parse(init.body);
      requests.push(body);
      assert.equal(body.model, "deepseek-flash");
      assert.deepEqual(body.thinking, { type: "enabled" });
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.equal(body.tools[0].function.name, "sum");
      if (requests.length === 1) {
        assert.deepEqual(body.messages.map((message) => message.role), ["user"]);
        return sse([
          { choices: [{ index: 0, delta: { reasoning_content: "Need " }, finish_reason: null }], usage: null },
          { choices: [{ index: 0, delta: { reasoning_content: "arithmetic." }, finish_reason: null }], usage: null },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "sum", arguments: '{"a":2,"b":3}' } }] }, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 6, total_tokens: 26 } },
          "[DONE]",
        ]);
      }
      if (requests.length !== 2 ||
        body.messages.length !== 3 ||
        body.messages[1].reasoning_content !== fullReasoning ||
        body.messages[1].tool_calls?.[0]?.id !== "call-1" ||
        body.messages[2].tool_call_id !== "call-1" ||
        JSON.parse(body.messages[2].content).output?.value !== 5) {
        return Response.json({ error: { message: "Missing reasoning_content or Tool reply" } }, { status: 400 });
      }
      return sse([
        { choices: [{ index: 0, delta: { content: "5" }, finish_reason: "stop" }], usage: null },
        { choices: [], usage: { prompt_tokens: 14, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens: 1, total_tokens: 15 } },
        "[DONE]",
      ]);
    },
  });
  const tools = createTools();
  const runtime = new Runtime({
    ...deterministicServices(),
    maxSteps: 4,
    stepPipeline: createLoop(stack.model, tools, {
      resolve() {
        return {
          model: stack.configuredModel.getDefaultModel(),
          context: { providers: [], input: {} },
          tools: { context: {}, authorityVersion: "authority-1" },
        };
      },
    }),
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const completion = await agent.startRun({
    scope: "deepseek-thinking-tool",
    payload: { text: "What is 2+3?" },
  }).completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "5");
  assert.equal(requests.length, 2, "the Tool result must trigger exactly one new model request");
  assert.equal(requests[1].messages[1].reasoning_content, fullReasoning);
  assert.deepEqual(tools.executions, [{ a: 2, b: 3 }]);
  assert.deepEqual(completion.result.usage, {
    inputTokens: 34,
    cachedInputTokens: 6,
    outputTokens: 7,
    totalTokens: 41,
    source: "provider",
  });
});

test("abort and Provider failure cross the complete composition as Runtime terminals", async () => {
  const entered = deferred();
  const adapters = new ModelAdapterRegistry();
  adapters.register("fixture-protocol", () => ({
    async *stream(request, signal) {
      yield { type: "start", model: request.model };
      entered.resolve();
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      yield {
        type: "error",
        error: { code: "aborted", message: "stopped", retryable: false },
      };
    },
  }));
  const stack = createConfiguredModelStack({
    configuration: configuration({ fallback: false, maxRetries: 0 }),
    registry: adapters,
    usageEstimator: new TokenizerUsageEstimator(),
    fetch: async () => new Response(),
  });
  const tools = createTools();
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop(stack.model, tools, {
      resolve() {
        return {
          model: stack.configuredModel.getDefaultModel(),
          context: { providers: [], input: {} },
          tools: { context: {}, authorityVersion: "authority-1" },
        };
      },
    }),
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const handle = agent.startRun({ scope: "abort-composition", payload: { text: "stop" } });
  await entered.promise;
  agent.control(handle.runId, { type: "abort", id: "abort-1", reason: "user_stop" });
  const completion = await handle.completion;
  assert.equal(completion.status, "aborted");
  assert.equal(completion.cancellation.reason, "user_stop");

  const failedAdapters = new ModelAdapterRegistry();
  failedAdapters.register("fixture-protocol", () => ({
    async *stream() {
      yield {
        type: "error",
        error: { code: "provider_error", message: "fixture failed", retryable: false },
      };
    },
  }));
  const failedStack = createConfiguredModelStack({
    configuration: configuration({ fallback: false, maxRetries: 0 }),
    registry: failedAdapters,
    usageEstimator: new TokenizerUsageEstimator(),
    fetch: async () => new Response(),
  });
  const failedTools = createTools();
  const failedRuntime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop(failedStack.model, failedTools, {
      resolve() {
        return {
          model: failedStack.configuredModel.getDefaultModel(),
          context: { providers: [], input: {} },
          tools: { context: {}, authorityVersion: "authority-1" },
        };
      },
    }),
  });
  const failed = await new Agent({ id: "failed-agent" }, failedRuntime)
    .startRun({ scope: "failed-composition", payload: { text: "fail" } }).completion;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "model_provider_error");
});
