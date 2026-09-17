import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../dist/core/agent/agent.js";
import { AgentLoop } from "../dist/core/agent-loop/agent-loop.js";
import { Runtime } from "../dist/core/runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
} from "../dist/core/tools/scheduler.js";
import {
  createContextBundle,
  createContextInput,
} from "../dist/context/index.js";

const modelRef = Object.freeze({ provider: "provider", model: "primary" });

function snapshot() {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-03T00:00:00.000Z",
    stateVersion: 7,
    run: { runId: "run-1", agentId: "agent", scope: "context-bundle" },
    userTurn: { userTurnId: "turn-1", ordinal: 2, input: { text: "hello" } },
    step: { stepId: "step-1", ordinal: 3 },
    steering: [],
    environment: {},
  };
}

function bundleOptions(overrides = {}) {
  return {
    history: { read: () => [] },
    agentInstructions: [
      { id: "agent-base", authority: "system", content: "Be exact." },
    ],
    archive: {
      archive({ result }) {
        return {
          locator: `tool-results/${result.callId}.json`,
          hash: `sha256:${result.callId}`,
        };
      },
    },
    models: { getContextWindowTokens: () => 4_096 },
    counter: {
      count() {
        return { inputTokens: 32, method: "fixture-request-tokenizer-v1" };
      },
    },
    configuration: { reservedOutputTokens: 512 },
    ...overrides,
  };
}

test("builds the default Provider order and snapshots immutable Step input", () => {
  const bundle = createContextBundle(bundleOptions());
  const sourceSnapshot = snapshot();
  const sourceModel = { provider: "provider", model: "primary" };
  const sourceWorkspace = {
    cwd: "/workspace",
    fingerprint: "workspace:fixture",
    revision: "workspace-revision:fixture",
    instructions: [
      { id: "repo", authority: "developer", content: "Follow repository rules." },
    ],
  };
  const environment = bundle.forStep({
    snapshot: sourceSnapshot,
    sessionId: "session-1",
    model: sourceModel,
    workspace: sourceWorkspace,
  });

  assert.deepEqual(bundle.providers.map((provider) => provider.id), [
    "instructions",
    "history",
    "state",
  ]);
  assert.deepEqual(bundle.configuration, {
    reservedOutputTokens: 512,
    toolResultAdmission: {
      thresholdChars: 8_192,
      headChars: 4_096,
      tailChars: 1_024,
    },
    providerOrder: ["instructions", "history", "state"],
  });
  assert.deepEqual(environment.input, {
    runId: "run-1",
    userTurnId: "turn-1",
    stepId: "step-1",
    sessionId: "session-1",
    model: modelRef,
    workspace: {
      cwd: "/workspace",
      fingerprint: "workspace:fixture",
      revision: "workspace-revision:fixture",
      instructions: [
        { id: "repo", authority: "developer", content: "Follow repository rules." },
      ],
    },
    runtime: {
      capturedAt: "2026-09-03T00:00:00.000Z",
      stateVersion: 7,
      userTurnOrdinal: 2,
      stepOrdinal: 3,
    },
  });
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.providers), true);
  assert.equal(Object.isFrozen(bundle.configuration), true);
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(Object.isFrozen(environment.input), true);
  assert.equal(Object.isFrozen(environment.input.model), true);
  assert.equal(Object.isFrozen(environment.input.workspace), true);
  assert.equal(Object.isFrozen(environment.input.workspace.instructions), true);
  assert.equal(Object.isFrozen(environment.input.runtime), true);

  sourceSnapshot.run.runId = "mutated-run";
  sourceSnapshot.step.stepId = "mutated-step";
  sourceModel.model = "mutated-model";
  sourceWorkspace.cwd = "/mutated";
  sourceWorkspace.instructions[0].content = "mutated instructions";
  assert.equal(environment.input.runId, "run-1");
  assert.equal(environment.input.stepId, "step-1");
  assert.equal(environment.input.model.model, "primary");
  assert.equal(environment.input.workspace.cwd, "/workspace");
  assert.equal(
    environment.input.workspace.instructions[0].content,
    "Follow repository rules.",
  );
});

test("validates complete Provider registration order without hiding extensions", () => {
  const referenceProvider = {
    id: "reference",
    provide() {
      return [{
        id: "reference:item",
        kind: "reference",
        placement: "before_current_user",
        message: { role: "developer", content: "Reference" },
      }];
    },
  };
  const extended = createContextBundle(bundleOptions({
    additionalProviders: [referenceProvider],
  }));
  assert.deepEqual(extended.configuration.providerOrder, [
    "instructions",
    "history",
    "state",
    "reference",
  ]);

  assert.throws(() => createContextBundle(bundleOptions({
    configuration: {
      reservedOutputTokens: 512,
      providerOrder: ["instructions", "history"],
    },
  })), /must name every Provider exactly once/u);
  assert.throws(() => createContextBundle(bundleOptions({
    additionalProviders: [{ ...referenceProvider, id: "history" }],
  })), /Duplicate Context Provider id: history/u);
  assert.throws(() => createContextInput({
    snapshot: { ...snapshot(), schemaVersion: 2 },
    sessionId: "session-1",
    model: modelRef,
    workspace: {
      cwd: "/workspace",
      fingerprint: "workspace:fixture",
      revision: "workspace-revision:fixture",
      instructions: [],
    },
  }), /Unknown Context Step snapshot schemaVersion/u);
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
    now: () => `2026-09-03T00:00:${String(++counters.time).padStart(2, "0")}Z`,
  };
}

function createTools() {
  const registry = new ToolRegistry();
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
      return { value: input.a + input.b };
    },
  });
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize: () => ({ status: "allowed", policyVersion: "policy-1" }),
      revalidate: () => ({ status: "valid", policyVersion: "policy-1" }),
    },
    grantId: () => "grant-1",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
  return {
    registry,
    scheduler: new BoundedToolScheduler({ executor, maxParallelCalls: 1 }),
  };
}

test("plugs directly into AgentLoop with archive-first Tool Result admission", async () => {
  const trace = [];
  const historyReads = [];
  const countedRequests = [];
  const bundle = createContextBundle(bundleOptions({
    history: {
      read(input) {
        historyReads.push(input.sessionId);
        return [{
          kind: "message",
          sequence: 1,
          userTurnId: "prior-turn",
          message: { role: "user", content: "prior request" },
        }];
      },
    },
    archive: {
      archive(input) {
        trace.push("archive");
        assert.equal(input.sessionId, "session-1");
        assert.deepEqual(input.result.output, { value: 5 });
        return {
          locator: `tool-results/${input.result.callId}.json`,
          hash: "sha256:complete-result",
        };
      },
    },
    counter: {
      count({ request }) {
        countedRequests.push(request);
        return { inputTokens: 64, method: "fixture-request-tokenizer-v1" };
      },
    },
  }));
  const tools = createTools();
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield { type: "start", model: request.model };
      if (requests.length === 1) {
        yield {
          type: "tool_call",
          call: { id: "call-1", name: "sum", argumentsJson: '{"a":2,"b":3}' },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "5" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const toolResults = bundle.createToolResultRenderer({
    resolveSessionId: () => "session-1",
    delegate: {
      render({ result }) {
        trace.push("delegate");
        return {
          role: "tool",
          toolCallId: result.callId,
          content: JSON.stringify(result),
        };
      },
    },
  });
  const loop = new AgentLoop({
    model,
    context: bundle.projector,
    tools: tools.registry,
    toolScheduler: tools.scheduler,
    input: {
      renderUserInput({ payload }) {
        return { role: "user", content: payload.text };
      },
      renderSteering({ message }) {
        return { role: "user", content: message.text };
      },
    },
    environment: {
      resolve({ snapshot: stepSnapshot }) {
        return {
          model: modelRef,
          context: bundle.forStep({
            snapshot: stepSnapshot,
            sessionId: "session-1",
            model: modelRef,
            workspace: {
              cwd: "/workspace",
              fingerprint: "workspace:fixture",
              revision: "workspace-revision:fixture",
              instructions: [{
                id: "repo",
                authority: "developer",
                content: "Follow repository rules.",
              }],
            },
          }),
          tools: { context: {}, authorityVersion: "authority-1" },
        };
      },
    },
    toolResults,
  });
  const runtime = new Runtime({
    ...deterministicServices(),
    maxSteps: 4,
    stepPipeline: loop,
  });
  const completion = await new Agent({ id: "agent" }, runtime).startRun({
    scope: "context-bundle",
    payload: { text: "2+3?" },
  }).completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "5");
  assert.deepEqual(trace, ["archive", "delegate"]);
  assert.deepEqual(historyReads, ["session-1", "session-1"]);
  assert.equal(countedRequests.length, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages.map((message) => message.role), [
    "system",
    "developer",
    "user",
    "developer",
    "user",
  ]);
  assert.equal(requests[0].messages[2].content, "prior request");
  assert.equal(requests[0].messages.at(-1).content, "2+3?");
  assert.equal(
    requests[0].messages.some((message) => message.content.includes("run-1")),
    true,
  );
  const projectedToolResult = requests[1].messages.find(
    (message) => message.role === "tool",
  );
  assert.equal(projectedToolResult.toolCallId, "call-1");
  assert.equal("__wishContextToolResultArchive" in projectedToolResult, false);
  assert.deepEqual(JSON.parse(projectedToolResult.content).output, { value: 5 });
});
