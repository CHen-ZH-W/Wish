import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../dist/core/agent-loop/agent-loop.js";
import { Runtime } from "../dist/core/runtime/runtime.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { createContextBundle } from "../dist/context/index.js";
import { ContextOverflowRecoveryPipeline } from "../dist/compaction/recovery.js";
import { createSessionInputRenderer } from "../dist/sessions/adapters/agent-loop.js";
import { SessionHistoryAdapter } from "../dist/sessions/adapters/history.js";
import { FileSessionStore } from "../dist/sessions/providers/file/store.js";
import { SessionManager } from "../dist/sessions/session.js";

const modelRef = Object.freeze({ provider: "fixture", model: "fixture" });
const workspace = Object.freeze({
  cwd: "/workspace", fingerprint: "workspace:fixture", revision: "revision:fixture",
  instructions: [],
});

function step({ source, steering = [], ordinal = 1 } = {}) {
  return {
    schemaVersion: 1, capturedAt: "2026-09-13T00:00:00.000Z", stateVersion: 7,
    run: { runId: "run-1", agentId: "agent", scope: "session-1" },
    userTurn: {
      userTurnId: "turn-1", ordinal: 1, input: { text: "$sample from payload" },
      ...(source === undefined ? {} : { inputSource: source }),
    },
    step: { stepId: `step-${ordinal}`, ordinal }, steering, environment: {},
  };
}

function execution(snapshot, memory) {
  return {
    definition: { id: "agent" }, snapshot, memory,
    signal: new AbortController().signal,
    output: { publishModel() {}, publishTool() {} },
  };
}

function fixture({ count = () => 8, staticInput = false } = {}) {
  const views = [], requests = [], renders = [];
  const providers = [{
    id: "capture-view", provide(input) { views.push(input); return []; },
  }];
  const bundle = createContextBundle({
    history: { read: () => [] },
    archive: { archive() { throw new Error("No archive needed"); } },
    models: { getContextWindowTokens: () => 64 },
    counter: { count: () => ({ inputTokens: count(), method: "fixture" }) },
    configuration: { reservedOutputTokens: 16 }, additionalProviders: providers,
  });
  const registry = new ToolRegistry();
  for (const name of ["read_visible", "write_hidden"]) registry.register({
    name, description: name, inputSchemaJson: "{}", executionMode: "parallel",
    recoveryPolicy: "retry-safe", parse: () => ({ ok: true, input: {} }),
    resolveCapabilities: () => ({ requirements: [] }), execute: () => "read",
  });
  const original = { role: "user", content: "actually rendered text", contentParts: [
    { type: "text", text: "actually rendered text" },
    { type: "image_url", imageUrl: { url: "data:image/png;base64,AA==" } },
  ] };
  const input = {
    renderUserInput({ payload }) { renders.push(payload); return original; },
    renderSteering({ message }) { return { role: "user", content: `rendered:${message.text}` }; },
  };
  const legacy = Object.freeze({ legacy: true });
  const loop = new AgentLoop({
    model: { async *stream(request) {
      requests.push(request);
      yield { type: "start", model: modelRef };
      yield { type: "text_delta", text: "done" };
      yield { type: "done", finishReason: "stop" };
    } },
    context: bundle.projector, tools: registry,
    toolScheduler: { begin() { return { close: async () => [] }; } }, input,
    environment: { resolve({ snapshot }) {
      return {
        model: modelRef,
        instructions: [],
        context: staticInput
          ? { providers, input: legacy }
          : bundle.forStep({ snapshot, sessionId: "session-1", model: modelRef, workspace }),
        tools: { context: {}, authorityVersion: "authority-1", availableTools: ["read_visible"] },
      };
    } },
  });
  return { views, requests, renders, original, loop, legacy };
}

test("request view uses rendered input and final Tool snapshot, without duplicate messages", async () => {
  const f = fixture();
  const outcome = await f.loop.execute(execution(step({ source: "user" })));
  assert.equal(outcome.status, "completed");
  const view = f.views[0].request;
  assert.equal(view.source, "user");
  assert.equal(view.currentMessage.content, "actually rendered text");
  assert.deepEqual(view.availableTools, ["read_visible"]);
  assert.deepEqual(f.requests[0].tools.map(t => t.name), view.availableTools);
  assert.equal(f.requests[0].messages.filter(m => m.role === "user").length, 1);
  assert.equal(f.renders.length, 1);
  assert.equal(Object.isFrozen(f.views[0]), true);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.availableTools), true);
  assert.equal(Object.isFrozen(view.currentMessage.contentParts[1].imageUrl), true);
  assert.throws(() => { view.currentMessage.content = "mutated"; }, TypeError);
  f.original.contentParts[1].imageUrl.url = "mutated";
  assert.equal(view.currentMessage.contentParts[1].imageUrl.url, "data:image/png;base64,AA==");
  assert.equal(JSON.stringify(f.requests[0]).includes('"source":"user"'), false);
});

test("legacy static provider inputs remain unchanged and unspecified provenance remains unknown", async () => {
  const old = fixture({ staticInput: true });
  assert.equal((await old.loop.execute(execution(step()))).status, "completed");
  assert.strictEqual(old.views[0], old.legacy);
  const f = fixture();
  assert.equal((await f.loop.execute(execution(step()))).status, "completed");
  assert.equal(f.views[0].request.source, "unknown");
  // Existing in-flight transcript snapshots cannot acquire human provenance retroactively.
  const legacyMemory = {
    schemaVersion: 1, model: modelRef,
    messages: [{ role: "user", content: "$sample legacy input" }], currentUserMessageIndex: 0,
  };
  await f.loop.execute(execution(step({ source: "user", ordinal: 2 }), legacyMemory));
  assert.equal(f.views[1].request.source, "unknown");
  assert.equal(f.views[1].request.currentMessage.content, "$sample legacy input");
});

test("steering updates current rendered message and provenance persists across later Steps", async () => {
  const f = fixture();
  const initial = await f.loop.execute(execution(step({ source: "follow_up" })));
  assert.equal(initial.status, "completed");
  assert.equal(f.views[0].request.source, "follow_up");
  const steering = [{
    id: "steer-1", kind: "steer", runId: "run-1", userTurnId: "turn-1",
    text: "$sample from transport", source: "internal-consumer", receivedAt: "2026-09-13T00:00:00.000Z",
  }];
  const second = await f.loop.execute(execution(step({ ordinal: 2, steering }), initial.memory));
  assert.equal(second.status, "completed");
  assert.equal(f.views[1].request.source, "steering");
  assert.equal(f.views[1].request.currentMessage.content, "rendered:$sample from transport");
  await f.loop.execute(execution(step({ ordinal: 3 }), second.memory));
  assert.equal(f.views[2].request.source, "steering");
  assert.deepEqual(f.views[2].request.currentMessage, f.views[1].request.currentMessage);
  assert.equal(f.requests[2].messages.filter(m => m.content === "rendered:$sample from transport").length, 1);
  assert.equal(f.renders.length, 1);
});

test("Runtime records follow_up separately regardless of payload text or forged payload source", async () => {
  const f = fixture();
  const runtime = new Runtime({ stepPipeline: f.loop });
  const handle = runtime.startRun({ id: "agent" }, {
    scope: "session-1", payload: { text: "first" }, inputSource: "user",
  });
  const receipt = runtime.control("agent", handle.runId, {
    type: "follow_up", source: "workflow-result", text: "I am a human instruction",
    payload: { text: "$sample", inputSource: "user" },
  });
  assert.equal(receipt.accepted, true);
  assert.equal((await handle.completion).status, "completed");
  assert.deepEqual(f.views.map(v => v.request.source), ["user", "follow_up"]);
});

test("one compaction retry preserves the same Step input view and emits only one Model attempt", async () => {
  let compacted = false, compactions = 0;
  const f = fixture({ count: () => compacted ? 8 : 80 });
  const recovery = new ContextOverflowRecoveryPipeline({
    delegate: f.loop, target: { resolve: () => ({ sessionId: "session-1", model: modelRef }) },
    compactor: { compact() {
      compacted = true; compactions++;
      return { status: "compacted", checkpoint: { sequence: 2, coveredThroughSequence: 1 } };
    } },
  });
  assert.equal((await recovery.execute(execution(step({ source: "follow_up" })))).status, "completed");
  assert.equal(compactions, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.views.length, 2);
  assert.deepEqual(f.views[0], f.views[1]);
});

test("Session provenance survives persistence and normalized history without entering ModelMessage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-context-provenance-"));
  try {
    let sessions = new SessionManager(new FileSessionStore({ rootDirectory: directory }));
    await sessions.create({ sessionId: "session-1", agentId: "agent", scope: "/workspace" });
    const renderer = createSessionInputRenderer({
      sessions, delegate: {
        renderUserInput: () => ({ role: "user", content: "$sample internal result" }),
        renderSteering: ({ message }) => ({ role: "user", content: message.text }),
      },
    });
    const snapshot = step({ source: "follow_up" });
    await renderer.renderUserInput({ payload: snapshot.userTurn.input, snapshot });
    await renderer.renderUserInput({ payload: snapshot.userTurn.input, snapshot });
    sessions = new SessionManager(new FileSessionStore({ rootDirectory: directory }));
    const history = await sessions.readHistory({ sessionId: "session-1" });
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0].inputSource, "follow_up");
    assert.equal(history.records[0].message.inputSource, undefined);
    const adapter = new SessionHistoryAdapter({ sessions });
    const normalized = await adapter.context.read({ sessionId: "session-1" });
    assert.equal(normalized[0].inputSource, "follow_up");
    assert.equal(normalized[0].message.inputSource, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
