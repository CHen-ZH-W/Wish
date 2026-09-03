import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextToolResultAdmissionPipeline,
  HistoryContextProvider,
  createArchivingToolResultRenderer,
  readContextToolResultArchiveReceipt,
} from "../dist/context/index.js";
import { ContextProjector } from "../dist/core/context/projector.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function snapshot() {
  return Object.freeze({
    schemaVersion: 1,
    capturedAt: "2026-09-03T12:00:00.000Z",
    stateVersion: 3,
    run: Object.freeze({ runId: "run-1", agentId: "agent-1", scope: "test" }),
    userTurn: Object.freeze({ userTurnId: "turn-1", ordinal: 1, input: {} }),
    step: Object.freeze({ stepId: "step-1", ordinal: 1 }),
    steering: Object.freeze([]),
    environment: Object.freeze({}),
  });
}

function call(id, name = "read") {
  return { status: "ready", id, name, input: { path: "large.txt" } };
}

function result(id, output, name = "read") {
  return { ok: true, callId: id, toolName: name, output, phase: "completed" };
}

function assistant(calls) {
  return {
    role: "assistant",
    content: "",
    toolCalls: calls.map((item) => ({
      id: item.id,
      name: item.name,
      argumentsJson: "{}",
    })),
  };
}

function renderer({ archive, render = ({ result: value }) => ({
  role: "tool",
  content: String(value.output.visible),
  toolCallId: value.callId,
}) }) {
  return createArchivingToolResultRenderer({
    archive,
    delegate: { render },
    resolveSessionId() {
      return "session-1";
    },
  });
}

test("archives the complete structured result before delegate rendering", async () => {
  const stages = [];
  const controller = new AbortController();
  const complete = result("call-1", {
    visible: "short rendered text",
    structureLostByRenderer: { nested: [1, 2, 3] },
  });
  let archived;
  const decorated = renderer({
    archive: {
      archive(input) {
        stages.push("archive");
        archived = input;
        return { locator: "tool-results/call-1.json", hash: "sha256:complete" };
      },
    },
    render(input) {
      stages.push("render");
      assert.strictEqual(input.result, complete);
      assert.strictEqual(input.signal, controller.signal);
      return {
        role: "tool",
        content: input.result.output.visible,
        toolCallId: input.result.callId,
      };
    },
  });

  const message = await decorated.render({
    call: call("call-1"),
    result: complete,
    snapshot: snapshot(),
    signal: controller.signal,
  });

  assert.deepEqual(stages, ["archive", "render"]);
  assert.strictEqual(archived.result, complete);
  assert.strictEqual(archived.signal, controller.signal);
  assert.deepEqual({
    sessionId: archived.sessionId,
    runId: archived.runId,
    userTurnId: archived.userTurnId,
    stepId: archived.stepId,
  }, {
    sessionId: "session-1",
    runId: "run-1",
    userTurnId: "turn-1",
    stepId: "step-1",
  });
  assert.equal(message.content, "short rendered text");
  assert.deepEqual(readContextToolResultArchiveReceipt(message), {
    schemaVersion: 1,
    toolCallId: "call-1",
    locator: "tool-results/call-1.json",
    hash: "sha256:complete",
  });
  assert.equal(Object.isFrozen(message), true);
  assert.equal(
    Object.isFrozen(readContextToolResultArchiveReceipt(message)),
    true,
  );
});

test("archive failure or abort prevents delegate rendering", async () => {
  let renders = 0;
  const failed = renderer({
    archive: {
      archive() {
        throw new Error("archive unavailable");
      },
    },
    render() {
      renders += 1;
      return { role: "tool", content: "must not render", toolCallId: "call-1" };
    },
  });
  await assert.rejects(failed.render({
    call: call("call-1"),
    result: result("call-1", { visible: "text" }),
    snapshot: snapshot(),
    signal: new AbortController().signal,
  }), /archive unavailable/u);
  assert.equal(renders, 0);

  const reason = new Error("stop archive boundary");
  const controller = new AbortController();
  let observedSignal;
  const aborted = renderer({
    archive: {
      archive(input) {
        observedSignal = input.signal;
        controller.abort(reason);
        return { locator: "tool-results/call-1.json", hash: "sha256:value" };
      },
    },
    render() {
      renders += 1;
      return { role: "tool", content: "must not render", toolCallId: "call-1" };
    },
  });
  await assert.rejects(aborted.render({
    call: call("call-1"),
    result: result("call-1", { visible: "text" }),
    snapshot: snapshot(),
    signal: controller.signal,
  }), reason);
  assert.strictEqual(observedSignal, controller.signal);
  assert.equal(renders, 0);
});

test("admits each archived Tool Result independently with fixed defaults", async () => {
  const archived = renderer({
    archive: {
      archive({ result: value }) {
        return {
          locator: `tool-results/${value.callId}.json`,
          hash: `sha256:${value.callId}`,
        };
      },
    },
  });
  const signal = new AbortController().signal;
  const largeSource = `${"H".repeat(4_096)}${"M".repeat(3_880)}${"T".repeat(1_024)}`;
  const large = await archived.render({
    call: call("large"),
    result: result("large", { visible: largeSource }),
    snapshot: snapshot(),
    signal,
  });
  const small = await archived.render({
    call: call("small"),
    result: result("small", { visible: "small result" }),
    snapshot: snapshot(),
    signal,
  });
  const other = { role: "user", content: "current request" };
  const projection = await new ContextProjector({
    toolResults: new ContextToolResultAdmissionPipeline(),
  }).project({
    request: {
      model,
      messages: [
        other,
        assistant([call("large"), call("small")]),
        large,
        small,
      ],
      tools: [],
    },
    groups: [],
    currentUserMessageIndex: 0,
  });

  assert.equal(projection.status, "ready");
  assert.equal(projection.request.messages[0].content, "current request");
  const visibleLarge = projection.request.messages[2];
  const admitted = JSON.parse(visibleLarge.content);
  assert.deepEqual({
    type: admitted.type,
    originalChars: admitted.originalChars,
    retainedChars: admitted.retainedChars,
    omittedChars: admitted.omittedChars,
    headChars: admitted.headChars,
    tailChars: admitted.tailChars,
    archive: admitted.archive,
  }, {
    type: "tool_result_truncated",
    originalChars: 9_000,
    retainedChars: 5_120,
    omittedChars: 3_880,
    headChars: 4_096,
    tailChars: 1_024,
    archive: {
      locator: "tool-results/large.json",
      hash: "sha256:large",
    },
  });
  assert.equal(admitted.head, "H".repeat(4_096));
  assert.equal(admitted.tail, "T".repeat(1_024));
  assert.equal(visibleLarge.toolCallId, "large");
  assert.equal(visibleLarge.contentParts, undefined);
  assert.deepEqual(projection.request.messages[3], {
    role: "tool",
    content: "small result",
    toolCallId: "small",
  });
  assert.equal(
    readContextToolResultArchiveReceipt(projection.request.messages[2]),
    undefined,
  );
  assert.equal(
    readContextToolResultArchiveReceipt(projection.request.messages[3]),
    undefined,
  );
  assert.equal(readContextToolResultArchiveReceipt(large)?.hash, "sha256:large");
});

test("never trims an oversized Tool Result without an archive receipt", async () => {
  const content = "U".repeat(9_000);
  const projection = await new ContextProjector({
    toolResults: new ContextToolResultAdmissionPipeline(),
  }).project({
    request: {
      model,
      messages: [
        { role: "user", content: "current" },
        assistant([call("unarchived")]),
        { role: "tool", toolCallId: "unarchived", content },
      ],
      tools: [],
    },
    groups: [],
    currentUserMessageIndex: 0,
  });

  assert.equal(projection.status, "ready");
  assert.equal(projection.request.messages[2].content, content);
});

test("restores a Session-side archive receipt before history admission", async () => {
  const history = new HistoryContextProvider({
    source: {
      read() {
        return [
          {
            kind: "message",
            sequence: 1,
            message: assistant([call("history-large")]),
          },
          {
            kind: "message",
            sequence: 2,
            message: {
              role: "tool",
              content: "R".repeat(9_000),
              toolCallId: "history-large",
            },
            toolResultArchive: {
              schemaVersion: 1,
              toolCallId: "history-large",
              locator: "tool-results/history-large.json",
              hash: "sha256:history-large",
            },
          },
        ];
      },
    },
  });
  const projection = await new ContextProjector({
    toolResults: new ContextToolResultAdmissionPipeline(),
  }).projectFromProviders({
    request: {
      model,
      messages: [{ role: "user", content: "current" }],
      tools: [],
    },
    providers: [history],
    providerInput: {
      runId: "run-2",
      userTurnId: "turn-2",
      stepId: "step-2",
      sessionId: "session-1",
      model,
      workspace: { cwd: "/workspace", instructions: [] },
      runtime: {
        capturedAt: "2026-09-03T12:01:00.000Z",
        stateVersion: 4,
        userTurnOrdinal: 2,
        stepOrdinal: 1,
      },
    },
    currentUserMessageIndex: 0,
  });

  assert.equal(projection.status, "ready");
  const admitted = JSON.parse(projection.request.messages[1].content);
  assert.equal(admitted.type, "tool_result_truncated");
  assert.equal(admitted.archive.locator, "tool-results/history-large.json");
  assert.equal(projection.request.messages[1].toolCallId, "history-large");
  assert.equal(projection.request.messages[2].content, "current");
});

test("validates admission configuration and receipt identity", async () => {
  assert.throws(() => new ContextToolResultAdmissionPipeline({
    thresholdChars: 10,
    headChars: 8,
    tailChars: 2,
  }), /must be less than thresholdChars/u);

  const decorated = renderer({
    archive: {
      archive() {
        return { locator: "tool-results/call-1.json", hash: "sha256:value" };
      },
    },
    render() {
      return { role: "tool", content: "value", toolCallId: "wrong" };
    },
  });
  await assert.rejects(decorated.render({
    call: call("call-1"),
    result: result("call-1", { visible: "value" }),
    snapshot: snapshot(),
    signal: new AbortController().signal,
  }), /must preserve role=tool and toolCallId/u);
});
