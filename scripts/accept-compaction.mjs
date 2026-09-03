import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../dist/core/agent/agent.js";
import { AgentLoop } from "../dist/core/agent-loop/agent-loop.js";
import { Runtime, runtimeFailure } from "../dist/core/runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
} from "../dist/core/tools/scheduler.js";
import {
  ContextOverflowRecoveryPipeline,
  ModelCompactionSummarizer,
  SessionCompactor,
} from "../dist/compaction/index.js";
import {
  HistoryContextProvider,
  LatestCheckpointHistoryPolicy,
  createContextBundle,
} from "../dist/context/index.js";

const agentModel = Object.freeze({ provider: "provider", model: "agent" });
const summaryModel = Object.freeze({ provider: "provider", model: "summary" });

function sourceRecords() {
  return [
    {
      kind: "message",
      sequence: 1,
      userTurnId: "old-turn",
      message: { role: "user", content: "keep this exact old request" },
    },
    {
      kind: "message",
      sequence: 2,
      userTurnId: "old-turn",
      message: {
        role: "assistant",
        content: "calling tool",
        toolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"path":"a"}' }],
      },
    },
    {
      kind: "message",
      sequence: 3,
      userTurnId: "old-turn",
      message: { role: "tool", toolCallId: "call-1", content: "tool output" },
    },
    {
      kind: "message",
      sequence: 4,
      userTurnId: "recent-turn",
      message: { role: "assistant", content: "recent assistant" },
    },
    {
      kind: "message",
      sequence: 5,
      userTurnId: "current-turn",
      message: { role: "user", content: "current request must stay recent" },
    },
  ];
}

function inMemorySession(initialRecords = sourceRecords()) {
  const state = {
    revision: "revision-1",
    records: [...initialRecords],
    appends: [],
  };
  return {
    state,
    port: {
      read({ sessionId }) {
        assert.equal(sessionId, "session-1");
        return { revision: state.revision, records: state.records };
      },
      appendCheckpoint(input) {
        assert.equal(input.sessionId, "session-1");
        assert.equal(input.expectedRevision, state.revision);
        state.appends.push(input);
        const record = {
          kind: "summary",
          sequence: Math.max(...state.records.map((item) => item.sequence)) + 1,
          coveredThroughSequence: input.checkpoint.coveredThroughSequence,
          message: input.checkpoint.message,
        };
        state.records.push(record);
        state.revision = "revision-2";
        return record;
      },
    },
  };
}

function messageCountCounter() {
  return {
    count({ request }) {
      return {
        inputTokens: request.messages.length * 10,
        method: "fixture-message-tokenizer-v1",
      };
    },
  };
}

test("summarizes one complete oldEntries prefix and appends one checkpoint", async () => {
  const session = inMemorySession();
  const summaryRequests = [];
  const summarizer = new ModelCompactionSummarizer({
    summaryModel,
    maxOutputTokens: 256,
    model: {
      async *stream(request) {
        summaryRequests.push(request);
        yield { type: "start", model: summaryModel };
        yield { type: "reasoning_delta", text: "private planning" };
        yield { type: "text_delta", text: "durable checkpoint" };
        yield {
          type: "done",
          finishReason: "stop",
          usage: {
            inputTokens: 30,
            outputTokens: 2,
            totalTokens: 32,
            source: "provider",
          },
        };
      },
    },
  });
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer,
    counter: messageCountCounter(),
    configuration: { keepRecentTokens: 15 },
  });

  const result = await compactor.compact({
    sessionId: "session-1",
    model: agentModel,
    preserveUserTurnId: "current-turn",
  });

  assert.equal(result.status, "compacted");
  assert.equal(result.sourceRecordCount, 3);
  assert.equal(result.recentRecordCount, 2);
  assert.equal(result.recentInputTokens, 20);
  assert.equal(result.countMethod, "fixture-message-tokenizer-v1");
  assert.equal(result.checkpoint.sequence, 6);
  assert.equal(result.checkpoint.coveredThroughSequence, 3);
  assert.equal(session.state.appends.length, 1);
  assert.deepEqual(session.state.appends[0].checkpoint.sourceSequences, [1, 2, 3]);
  assert.equal(session.state.records.length, 6);
  assert.equal(session.state.records[0].message.content, "keep this exact old request");

  assert.equal(summaryRequests.length, 1);
  assert.deepEqual(summaryRequests[0].model, summaryModel);
  assert.equal(summaryRequests[0].maxOutputTokens, 256);
  assert.deepEqual(summaryRequests[0].tools, []);
  assert.deepEqual(summaryRequests[0].messages.map((message) => message.role), [
    "developer",
    "user",
  ]);
  const transcript = summaryRequests[0].messages[1].content;
  assert.match(transcript, /keep this exact old request/u);
  assert.match(transcript, /calling tool/u);
  assert.match(transcript, /tool output/u);
  assert.doesNotMatch(transcript, /recent assistant/u);
  assert.doesNotMatch(transcript, /current request must stay recent/u);

  const provider = new HistoryContextProvider({
    source: { read: () => session.state.records },
  });
  const items = await provider.provide({
    runId: "run-1",
    userTurnId: "current-turn",
    stepId: "step-1",
    sessionId: "session-1",
    model: agentModel,
    workspace: { cwd: "/workspace", instructions: [] },
    runtime: {
      capturedAt: "2026-09-03T00:00:00.000Z",
      stateVersion: 1,
      userTurnOrdinal: 1,
      stepOrdinal: 1,
    },
  });
  const selected = new LatestCheckpointHistoryPolicy().select({
    request: { model: agentModel, messages: [], tools: [] },
    items,
  });
  assert.deepEqual(selected.items.map((item) => item.message.content), [
    "durable checkpoint",
    "keep this exact old request",
    "recent assistant",
  ]);
});

test("fails closed when exact history sizing is unavailable", async () => {
  const session = inMemorySession();
  let summaryCalls = 0;
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer: {
      summarize() {
        summaryCalls += 1;
        return { content: "must not run" };
      },
    },
    counter: { count: () => undefined },
    configuration: { keepRecentTokens: 10 },
  });

  const result = await compactor.compact({
    sessionId: "session-1",
    model: agentModel,
    preserveUserTurnId: "current-turn",
  });

  assert.deepEqual(result, {
    status: "not_possible",
    reason: "input_token_count_unavailable",
  });
  assert.equal(summaryCalls, 0);
  assert.equal(session.state.appends.length, 0);
});

test("never appends a checkpoint after summary failure", async () => {
  const session = inMemorySession();
  const summarizer = new ModelCompactionSummarizer({
    summaryModel,
    maxOutputTokens: 256,
    model: {
      async *stream() {
        yield { type: "start", model: summaryModel };
        yield {
          type: "tool_call",
          call: { id: "unexpected", name: "read", argumentsJson: "{}" },
        };
      },
    },
  });
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer,
    counter: messageCountCounter(),
    configuration: { keepRecentTokens: 15 },
  });

  await assert.rejects(compactor.compact({
    sessionId: "session-1",
    model: agentModel,
    preserveUserTurnId: "current-turn",
  }), /must not call Tools/u);
  assert.equal(session.state.appends.length, 0);
});

test("does not chunk, fallback, or write after summary context overflow", async () => {
  const session = inMemorySession();
  let modelCalls = 0;
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer: new ModelCompactionSummarizer({
      summaryModel,
      maxOutputTokens: 256,
      model: {
        async *stream() {
          modelCalls += 1;
          yield { type: "start", model: summaryModel };
          yield {
            type: "error",
            error: {
              code: "context_overflow",
              message: "summary request too large",
              retryable: true,
            },
          };
        },
      },
    }),
    counter: messageCountCounter(),
    configuration: { keepRecentTokens: 15 },
  });

  await assert.rejects(compactor.compact({
    sessionId: "session-1",
    model: agentModel,
    preserveUserTurnId: "current-turn",
  }), /summary request too large/u);
  assert.equal(modelCalls, 1);
  assert.equal(session.state.appends.length, 0);
});

test("rejects a checkpoint that split an existing assistant and Tool unit", async () => {
  const session = inMemorySession([
    {
      kind: "message",
      sequence: 1,
      message: {
        role: "assistant",
        content: "call",
        toolCalls: [{ id: "call-1", name: "read", argumentsJson: "{}" }],
      },
    },
    {
      kind: "message",
      sequence: 2,
      message: { role: "tool", toolCallId: "call-1", content: "result" },
    },
    {
      kind: "summary",
      sequence: 3,
      coveredThroughSequence: 1,
      message: { role: "assistant", content: "invalid checkpoint" },
    },
  ]);
  let summaryCalls = 0;
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer: {
      summarize() {
        summaryCalls += 1;
        return { content: "must not run" };
      },
    },
    counter: messageCountCounter(),
    configuration: { keepRecentTokens: 10 },
  });

  await assert.rejects(compactor.compact({
    sessionId: "session-1",
    model: agentModel,
    preserveUserTurnId: "current-turn",
  }), /splits Tool Call unit/u);
  assert.equal(summaryCalls, 0);
  assert.equal(session.state.appends.length, 0);
});

test("propagates abort through history counting before summary or append", async () => {
  const session = inMemorySession();
  const controller = new AbortController();
  const reason = new Error("stop compaction");
  let summaryCalls = 0;
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer: {
      summarize() {
        summaryCalls += 1;
        return { content: "must not run" };
      },
    },
    counter: {
      count({ signal }) {
        assert.strictEqual(signal, controller.signal);
        controller.abort(reason);
        return { inputTokens: 10, method: "fixture" };
      },
    },
    configuration: { keepRecentTokens: 10 },
  });

  await assert.rejects(compactor.compact({
    sessionId: "session-1",
    model: agentModel,
    preserveUserTurnId: "current-turn",
    signal: controller.signal,
  }), reason);
  assert.equal(summaryCalls, 0);
  assert.equal(session.state.appends.length, 0);
});

function pipelineInput() {
  return {
    definition: { id: "agent", configuration: {} },
    snapshot: {
      schemaVersion: 1,
      capturedAt: "2026-09-03T00:00:00.000Z",
      stateVersion: 1,
      run: { runId: "run-1", agentId: "agent", scope: "test" },
      userTurn: { userTurnId: "current-turn", ordinal: 1, input: {} },
      step: { stepId: "step-1", ordinal: 1 },
      steering: [],
      environment: {},
    },
    memory: undefined,
    signal: new AbortController().signal,
    output: {
      publishModel() {},
      publishTool() {},
    },
  };
}

function compactedResult() {
  return {
    status: "compacted",
    checkpoint: {
      kind: "summary",
      sequence: 9,
      coveredThroughSequence: 7,
      message: { role: "assistant", content: "checkpoint" },
    },
    sourceRecordCount: 7,
    recentRecordCount: 2,
    recentInputTokens: 20,
    countMethod: "fixture",
  };
}

test("retries only pre-Model context_over_budget and only once", async () => {
  const input = pipelineInput();
  const calls = [];
  let compactionCalls = 0;
  const delegate = {
    execute(actual) {
      calls.push(actual);
      return calls.length === 1
        ? {
            status: "failed",
            error: runtimeFailure("context_over_budget", "large", false),
          }
        : { status: "completed", result: "done" };
    },
  };
  const pipeline = new ContextOverflowRecoveryPipeline({
    delegate,
    compactor: {
      compact(actual) {
        compactionCalls += 1;
        assert.equal(actual.preserveUserTurnId, "current-turn");
        return compactedResult();
      },
    },
    target: {
      resolve: () => ({ sessionId: "session-1", model: agentModel }),
    },
  });

  assert.deepEqual(await pipeline.execute(input), {
    status: "completed",
    result: "done",
  });
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0], input);
  assert.strictEqual(calls[1], input);
  assert.equal(compactionCalls, 1);

  let providerOverflowCompactions = 0;
  const providerOverflow = new ContextOverflowRecoveryPipeline({
    delegate: {
      execute: () => ({
        status: "failed",
        error: runtimeFailure("model_context_overflow", "provider", false),
      }),
    },
    compactor: {
      compact() {
        providerOverflowCompactions += 1;
        return compactedResult();
      },
    },
    target: { resolve: () => ({ sessionId: "session-1", model: agentModel }) },
  });
  const providerResult = await providerOverflow.execute(input);
  assert.equal(providerResult.error.code, "model_context_overflow");
  assert.equal(providerOverflowCompactions, 0);
});

test("reports a distinct terminal when the bounded retry is still over budget", async () => {
  let calls = 0;
  const pipeline = new ContextOverflowRecoveryPipeline({
    delegate: {
      execute() {
        calls += 1;
        return {
          status: "failed",
          error: runtimeFailure(
            "context_over_budget",
            "large",
            false,
            { estimatedInputTokens: 101, inputLimitTokens: 80 },
          ),
        };
      },
    },
    compactor: { compact: () => compactedResult() },
    target: { resolve: () => ({ sessionId: "session-1", model: agentModel }) },
  });

  const result = await pipeline.execute(pipelineInput());
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "context_over_budget_after_compaction");
  assert.equal(result.error.retryable, false);
  assert.equal(result.error.details.checkpointSequence, 9);
  assert.deepEqual(result.error.details.projection, {
    estimatedInputTokens: 101,
    inputLimitTokens: 80,
  });
});

function deterministicServices() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () => `2026-09-03T01:00:${String(++counters.time).padStart(2, "0")}Z`,
  };
}

function emptyTools() {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize: () => ({ status: "allowed", policyVersion: "policy-1" }),
      revalidate: () => ({ status: "valid", policyVersion: "policy-1" }),
    },
    grantId: () => "grant-1",
    now: () => new Date("2026-09-03T01:00:00.000Z"),
  });
  return {
    registry,
    scheduler: new BoundedToolScheduler({ executor, maxParallelCalls: 1 }),
  };
}

test("recovers a real AgentLoop projection through one append-only checkpoint", async () => {
  const session = inMemorySession([
    {
      kind: "message",
      sequence: 1,
      userTurnId: "old-turn",
      message: { role: "user", content: "verbatim old user intent" },
    },
    {
      kind: "message",
      sequence: 2,
      userTurnId: "old-turn",
      message: { role: "assistant", content: "older work" },
    },
    {
      kind: "message",
      sequence: 3,
      userTurnId: "recent-turn",
      message: { role: "assistant", content: "recent work" },
    },
  ]);
  const modelRequests = [];
  const summaryRequests = [];
  const model = {
    async *stream(request) {
      if (request.model.model === "summary") {
        summaryRequests.push(request);
        yield { type: "start", model: summaryModel };
        yield { type: "text_delta", text: "checkpoint of older work" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      modelRequests.push(request);
      yield { type: "start", model: agentModel };
      yield { type: "text_delta", text: "recovered" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const counter = {
    count({ request }) {
      const isAgentProjection = request.messages.some(
        (message) => message.content === "current request",
      );
      if (isAgentProjection) {
        return {
          inputTokens: session.state.appends.length === 0 ? 101 : 40,
          method: "fixture-agent-request-v1",
        };
      }
      return {
        inputTokens: request.messages.length * 10,
        method: "fixture-history-request-v1",
      };
    },
  };
  const context = createContextBundle({
    history: { read: () => session.state.records },
    agentInstructions: [
      { id: "agent", authority: "system", content: "Be exact." },
    ],
    archive: {
      archive: () => {
        throw new Error("No Tool Result expected");
      },
    },
    models: { getContextWindowTokens: () => 100 },
    counter,
    configuration: { reservedOutputTokens: 20 },
  });
  const compactor = new SessionCompactor({
    session: session.port,
    summarizer: new ModelCompactionSummarizer({
      model,
      summaryModel,
      maxOutputTokens: 20,
    }),
    counter,
    configuration: { keepRecentTokens: 10 },
  });
  const tools = emptyTools();
  const loop = new AgentLoop({
    model,
    context: context.projector,
    tools: tools.registry,
    toolScheduler: tools.scheduler,
    input: {
      renderUserInput: () => ({ role: "user", content: "current request" }),
      renderSteering: ({ message }) => ({ role: "user", content: message.text }),
    },
    environment: {
      resolve({ snapshot }) {
        return {
          model: agentModel,
          context: context.forStep({
            snapshot,
            sessionId: "session-1",
            model: agentModel,
            workspace: { cwd: "/workspace", instructions: [] },
          }),
          tools: { context: {}, authorityVersion: "authority-1" },
        };
      },
    },
  });
  const recovering = new ContextOverflowRecoveryPipeline({
    delegate: loop,
    compactor,
    target: {
      resolve: () => ({ sessionId: "session-1", model: agentModel }),
    },
  });
  const runtime = new Runtime({
    ...deterministicServices(),
    stepPipeline: recovering,
  });
  const completion = await new Agent({ id: "agent" }, runtime).startRun({
    scope: "compaction-recovery",
    payload: { text: "current request" },
  }).completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "recovered");
  assert.equal(summaryRequests.length, 1);
  assert.equal(modelRequests.length, 1);
  assert.equal(session.state.appends.length, 1);
  assert.equal(session.state.records[0].message.content, "verbatim old user intent");
  assert.equal(
    modelRequests[0].messages.some(
      (message) => message.content === "verbatim old user intent",
    ),
    true,
  );
  assert.equal(
    modelRequests[0].messages.some(
      (message) => message.content === "checkpoint of older work",
    ),
    true,
  );
});
