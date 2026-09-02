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

function deterministicServices() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () => `2026-01-01T00:00:${String(++counters.time).padStart(2, "0")}Z`,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function allowedAuthorization() {
  return {
    authorize() {
      return { status: "allowed", policyVersion: "policy-1" };
    },
    revalidate() {
      return { status: "valid", policyVersion: "policy-1" };
    },
  };
}

function createTools() {
  const registry = new ToolRegistry();
  const executions = [];
  registry.register({
    name: "sum",
    description: "Add two numbers",
    inputSchemaJson: JSON.stringify({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    }),
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
    authorization: allowedAuthorization(),
    grantId: (() => {
      let id = 0;
      return () => `grant-${++id}`;
    })(),
    now: (() => {
      let tick = 0;
      return () => new Date(`2099-01-01T01:00:${String(++tick).padStart(2, "0")}Z`);
    })(),
  });
  return {
    registry,
    scheduler: new BoundedToolScheduler({ executor, maxParallelCalls: 2 }),
    executions,
  };
}

function createLoop({ model, registry, scheduler, projector = new ContextProjector(), environment } = {}) {
  return new AgentLoop({
    model,
    context: projector,
    tools: registry,
    toolScheduler: scheduler,
    input: {
      renderUserInput(input) {
        return { role: "user", content: input.payload.text };
      },
      renderSteering(input) {
        return { role: "user", content: input.message.text };
      },
    },
    environment: environment ?? {
      resolve() {
        return {
          model: { provider: "provider", model: "primary" },
          context: { providers: [], input: {} },
          tools: { context: {}, authorityVersion: "authority-1" },
        };
      },
    },
  });
}

test("Runtime and AgentLoop complete the Context-Model-Tool-next-Step spine", async () => {
  const tools = createTools();
  const requests = [];
  let invocation = 0;
  const model = {
    async *stream(request) {
      requests.push(request);
      invocation += 1;
      if (invocation === 1) {
        yield { type: "start", model: { provider: "provider", model: "actual-a" } };
        yield { type: "reasoning_delta", text: "need arithmetic" };
        yield {
          type: "tool_call",
          call: { id: "call-1", name: "sum", argumentsJson: '{"a":2,"b":3}' },
        };
        yield {
          type: "done",
          finishReason: "tool_calls",
          usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, totalTokens: 14 },
        };
        return;
      }
      yield { type: "start", model: { provider: "provider", model: "actual-b" } };
      yield { type: "text_delta", text: "5" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 14, cachedInputTokens: 3, outputTokens: 1, totalTokens: 15 },
      };
    },
  };
  let environmentCall = 0;
  const loop = createLoop({
    model,
    registry: tools.registry,
    scheduler: tools.scheduler,
    environment: {
      resolve() {
        environmentCall += 1;
        return {
          model: {
            provider: "provider",
            model: environmentCall === 1 ? "primary" : "changed-default",
          },
          context: { providers: [], input: {} },
          tools: { context: {}, authorityVersion: `authority-${environmentCall}` },
        };
      },
    },
  });
  const runtime = new Runtime({
    ...deterministicServices(),
    maxSteps: 4,
    stepPipeline: loop,
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const handle = agent.startRun({ scope: "conversation:loop", payload: { text: "2+3?" } });
  const eventsPromise = collect(agent.observe(handle.runId));
  const completion = await handle.completion;
  const events = await eventsPromise;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "5");
  assert.deepEqual(completion.result.usage, {
    inputTokens: 24,
    cachedInputTokens: 5,
    outputTokens: 5,
    totalTokens: 29,
  });
  assert.deepEqual(tools.executions, [{ a: 2, b: 3 }]);
  assert.equal(completion.snapshot.userTurns[0].steps.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model.model, "primary");
  assert.equal(requests[1].model.model, "primary");
  assert.deepEqual(requests[1].messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
  ]);
  assert.equal(requests[1].messages[1].toolCalls[0].id, "call-1");
  assert.deepEqual(JSON.parse(requests[1].messages[2].content), {
    ok: true,
    callId: "call-1",
    toolName: "sum",
    output: { value: 5 },
    phase: "completed",
  });
  assert.deepEqual(events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index + 1));
  assert.equal(events.some((event) => event.type === "model.stream"), true);
  assert.equal(events.some((event) => event.type === "tool.lifecycle"), true);
  assert.equal(
    events.filter((event) => event.type === "tool.lifecycle" && event.payload.type === "tool.completed").length,
    1,
  );
  const modelToolCallIndex = events.findIndex(
    (event) => event.type === "model.stream" && event.payload.type === "tool_call",
  );
  const toolQueuedIndex = events.findIndex(
    (event) => event.type === "tool.lifecycle" && event.payload.type === "tool.queued",
  );
  const modelDoneIndex = events.findIndex(
    (event) => event.type === "model.stream" && event.payload.type === "done",
  );
  assert.equal(modelToolCallIndex < toolQueuedIndex, true);
  assert.equal(toolQueuedIndex < modelDoneIndex, true);
});

test("invalid Tool calls become paired Tool results and continue the next Step", async () => {
  const tools = createTools();
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield { type: "start", model: request.model };
      if (requests.length === 1) {
        yield {
          type: "tool_call",
          call: { id: "missing-1", name: "missing", argumentsJson: "{}" },
        };
        yield { type: "done", finishReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "handled" };
        yield { type: "done", finishReason: "stop" };
      }
    },
  };
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop({ model, registry: tools.registry, scheduler: tools.scheduler }),
  });
  const completion = await new Agent({ id: "agent" }, runtime)
    .startRun({ scope: "invalid-tool", payload: { text: "run" } }).completion;

  assert.equal(completion.status, "completed");
  const failure = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "not_found");
  assert.equal(tools.executions.length, 0);
});

test("Context over-budget fails before Model or Tool execution", async () => {
  const tools = createTools();
  let modelCalls = 0;
  const model = {
    async *stream() {
      modelCalls += 1;
      yield { type: "error", error: { code: "unknown", message: "unexpected", retryable: false } };
    },
  };
  const projector = new ContextProjector({
    budgetPolicy: {
      assess() {
        return { status: "over_budget", estimatedInputTokens: 20, inputLimitTokens: 10 };
      },
    },
  });
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop({
      model,
      registry: tools.registry,
      scheduler: tools.scheduler,
      projector,
    }),
  });
  const completion = await new Agent({ id: "agent" }, runtime)
    .startRun({ scope: "over-budget", payload: { text: "run" } }).completion;

  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "context_over_budget");
  assert.equal(modelCalls, 0);
  assert.equal(tools.executions.length, 0);
});

test("Model stream protocol failures terminate the Step explicitly", async () => {
  const tools = createTools();
  const model = {
    async *stream() {
      yield { type: "text_delta", text: "missing start" };
    },
  };
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop({ model, registry: tools.registry, scheduler: tools.scheduler }),
  });
  const completion = await new Agent({ id: "agent" }, runtime)
    .startRun({ scope: "bad-stream", payload: { text: "run" } }).completion;

  assert.equal(completion.status, "failed");
  assert.equal(completion.error.code, "model_stream_protocol_error");
  assert.match(completion.error.message, /before start/);
});

test("a pre-content retry replaces attempt metadata without changing the fixed request model", async () => {
  const tools = createTools();
  const model = {
    async *stream(request) {
      yield { type: "start", model: { provider: "provider", model: "attempt-a" } };
      yield {
        type: "retry",
        error: { code: "network_error", message: "retry", retryable: true },
        retryCount: 1,
        delayMs: 1,
        fromModel: { provider: "provider", model: "attempt-a" },
        toModel: { provider: "provider", model: "attempt-b" },
      };
      yield {
        type: "start",
        model: { provider: "provider", model: "attempt-b" },
        authorityDegraded: true,
      };
      assert.equal(request.model.model, "primary");
      yield { type: "text_delta", text: "recovered" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop({ model, registry: tools.registry, scheduler: tools.scheduler }),
  });
  const completion = await new Agent({ id: "agent" }, runtime)
    .startRun({ scope: "retry", payload: { text: "run" } }).completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.model.model, "attempt-b");
  assert.equal(completion.result.output.authorityDegraded, true);
  assert.equal(completion.result.output.text, "recovered");
});

test("Runtime abort reaches the active Model stream and terminates AgentLoop", async () => {
  const tools = createTools();
  const entered = deferred();
  const model = {
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
  };
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: createLoop({ model, registry: tools.registry, scheduler: tools.scheduler }),
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const handle = agent.startRun({ scope: "abort-loop", payload: { text: "run" } });
  await entered.promise;
  assert.equal(agent.control(handle.runId, {
    type: "abort",
    id: "abort-1",
    reason: "user_stop",
  }).accepted, true);
  const completion = await handle.completion;

  assert.equal(completion.status, "aborted");
  assert.equal(completion.cancellation.reason, "user_stop");
});

test("steering after a completed model response is appended to the forced next Step", async () => {
  const tools = createTools();
  const entered = deferred();
  const release = deferred();
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield { type: "start", model: request.model };
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
        yield { type: "text_delta", text: "first" };
      } else {
        yield { type: "text_delta", text: "revised" };
      }
      yield { type: "done", finishReason: "stop" };
    },
  };
  const runtime = new Runtime({
    ...deterministicServices(),
    maxSteps: 3,
    stepPipeline: createLoop({ model, registry: tools.registry, scheduler: tools.scheduler }),
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const handle = agent.startRun({ scope: "steered-loop", payload: { text: "draft" } });
  await entered.promise;
  assert.equal(agent.control(handle.runId, {
    type: "steer",
    id: "steer-1",
    text: "revise it",
  }).accepted, true);
  release.resolve();
  const completion = await handle.completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "revised");
  assert.deepEqual(requests[1].messages.map((message) => [message.role, message.content]), [
    ["user", "draft"],
    ["assistant", "first"],
    ["user", "revise it"],
  ]);
});
