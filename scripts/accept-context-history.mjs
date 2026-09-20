import assert from "node:assert/strict";
import test from "node:test";

import {
  HistoryContextProvider,
  LatestCheckpointHistoryPolicy,
} from "../dist/context/index.js";
import { ContextProjector } from "../dist/core/context/projector.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function contextInput(overrides = {}) {
  return {
    runId: "run-1",
    userTurnId: "turn-current",
    stepId: "step-1",
    sessionId: "session/one",
    model,
    workspace: {
      cwd: "/workspace",
      fingerprint: "workspace:fixture",
      revision: "workspace-revision:fixture",
      instructions: [],
    },
    runtime: {
      capturedAt: "2026-09-03T00:00:00.000Z",
      stateVersion: 1,
      userTurnOrdinal: 2,
      stepOrdinal: 1,
    },
    ...overrides,
  };
}

function history(id, sequence, role, content, extra = {}) {
  return {
    id,
    kind: "history",
    placement: "history",
    sequence,
    message: { role, content, ...extra },
  };
}

function summary(id, sequence, coveredThroughSequence, content) {
  return {
    id,
    kind: "summary",
    placement: "history",
    sequence,
    coveredThroughSequence,
    message: { role: "assistant", content },
  };
}

test("maps only model fields, excludes the current UserTurn, and repairs Tool units", async () => {
  const signal = new AbortController().signal;
  let received;
  const provider = new HistoryContextProvider({
    source: {
      read(input) {
        received = input;
        return [
          {
            kind: "message",
            sequence: 5,
            userTurnId: "turn-current",
            message: { role: "user", content: "must not duplicate" },
          },
          {
            kind: "message",
            sequence: 4,
            message: { role: "user", content: "after tools", createdAt: "ignored" },
          },
          {
            kind: "message",
            sequence: 3,
            message: {
              role: "tool",
              toolCallId: "call-b",
              content: "result b",
              storageVersion: 4,
            },
          },
          {
            kind: "message",
            sequence: 2,
            message: { role: "tool", toolCallId: "orphan", content: "orphan" },
          },
          {
            kind: "message",
            sequence: 1,
            message: {
              role: "assistant",
              content: "",
              reasoningContent: "reasoning",
              toolCalls: [
                { id: "call-b", name: "second", argumentsJson: "{\"b\":2}" },
                { id: "call-a", name: "first", argumentsJson: "{\"a\":1}" },
              ],
              ui: { hidden: true },
            },
          },
        ];
      },
    },
  });

  const items = await provider.provide(contextInput(), signal);

  assert.equal(received.sessionId, "session/one");
  assert.equal(received.signal, signal);
  assert.deepEqual(items.map((item) => item.sequence), [1, 2, 3, 4]);
  assert.deepEqual(items.map((item) => item.message.role), [
    "assistant",
    "tool",
    "tool",
    "user",
  ]);
  assert.deepEqual(items.map((item) => item.message.toolCallId), [
    undefined,
    "call-b",
    "call-a",
    undefined,
  ]);
  assert.equal(items[1].message.content, "result b");
  assert.match(items[2].message.content, /missing_tool_result/u);
  assert.equal(items[3].message.content, "after tools");
  assert.deepEqual(Object.keys(items[0].message).sort(), [
    "content",
    "reasoningContent",
    "role",
    "toolCalls",
  ]);
  assert.deepEqual(Object.keys(items[1].message).sort(), [
    "content",
    "role",
    "toolCallId",
  ]);
  assert.equal(items.some((item) => item.message.content === "orphan"), false);
  assert.equal(
    items.some((item) => item.message.content === "must not duplicate"),
    false,
  );
  assert.equal(
    items[2].id,
    "history:session%2Fone:1:missing-tool-result:call-a",
  );
});

test("selects the latest checkpoint, exact covered user text, and recent history", () => {
  const policy = new LatestCheckpointHistoryPolicy();
  const items = [
    history("user", 1, "user", "exact old constraint"),
    history("assistant", 2, "assistant", "covered answer"),
    summary("old-summary", 3, 2, "old summary"),
    history("covered", 4, "assistant", "also covered"),
    summary("latest-summary", 5, 4, "latest summary"),
    history("recent", 6, "assistant", "recent answer"),
  ];

  const selection = policy.select({
    request: { model, instructions: [], messages: [{ role: "user", content: "current" }], tools: [] },
    items,
  });

  assert.deepEqual(selection.items.map((item) => item.id), [
    "latest-summary",
    "user",
    "recent",
  ]);
  assert.equal(selection.items[1], items[0]);
  assert.deepEqual(selection.metadata, {
    strategy: "latest_checkpoint",
    selectedSummarySequence: 5,
    coveredThroughSequence: 4,
    protectedUserSequences: [1],
    recentHistorySequences: [6],
  });
});

test("rejects duplicate sequence, backwards checkpoints, and split Tool units", () => {
  const policy = new LatestCheckpointHistoryPolicy();
  const request = { model, instructions: [], messages: [{ role: "user", content: "current" }], tools: [] };

  assert.throws(() => policy.select({
    request,
    items: [
      history("one", 1, "user", "one"),
      history("two", 1, "assistant", "two"),
    ],
  }), /Duplicate Context history sequence/u);

  assert.throws(() => policy.select({
    request,
    items: [
      history("one", 1, "user", "one"),
      summary("first", 3, 2, "first"),
      summary("second", 5, 1, "second"),
    ],
  }), /must not move backwards/u);

  assert.throws(() => policy.select({
    request,
    items: [
      history("assistant", 1, "assistant", "", {
        toolCalls: [{ id: "call", name: "tool", argumentsJson: "{}" }],
      }),
      history("tool", 2, "tool", "result", { toolCallId: "call" }),
      summary("checkpoint", 3, 1, "checkpoint"),
    ],
  }), /splits Tool Call unit/u);
});

test("rejects duplicate source sequence and propagates abort through the source", async () => {
  const duplicate = new HistoryContextProvider({
    source: {
      read() {
        return [
          { kind: "message", sequence: 1, message: { role: "user", content: "one" } },
          { kind: "message", sequence: 1, message: { role: "user", content: "two" } },
        ];
      },
    },
  });
  await assert.rejects(
    duplicate.provide(contextInput()),
    /Duplicate Context history source sequence/u,
  );

  const reason = new Error("stop history");
  const controller = new AbortController();
  const provider = new HistoryContextProvider({
    source: {
      async read({ signal }) {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
        return [];
      },
    },
  });
  await assert.rejects(provider.provide(contextInput(), controller.signal), reason);
});

test("does not match a Tool Result across a summary checkpoint", async () => {
  const provider = new HistoryContextProvider({
    source: {
      read() {
        return [
          {
            kind: "message",
            sequence: 1,
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call", name: "tool", argumentsJson: "{}" }],
            },
          },
          {
            kind: "summary",
            sequence: 2,
            coveredThroughSequence: 1,
            message: { role: "assistant", content: "checkpoint" },
          },
          {
            kind: "message",
            sequence: 3,
            message: { role: "tool", toolCallId: "call", content: "too late" },
          },
        ];
      },
    },
  });

  const items = await provider.provide(contextInput());

  assert.deepEqual(items.map((item) => item.message.role), [
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.match(items[1].message.content, /missing_tool_result/u);
  assert.equal(items.some((item) => item.message.content === "too late"), false);
});

test("integrates provider and policy without duplicating the current user", async () => {
  const provider = new HistoryContextProvider({
    source: {
      read() {
        return [
          {
            kind: "message",
            sequence: 1,
            message: { role: "user", content: "exact old constraint" },
          },
          {
            kind: "message",
            sequence: 2,
            message: { role: "assistant", content: "covered answer" },
          },
          {
            kind: "summary",
            sequence: 3,
            coveredThroughSequence: 2,
            message: { role: "assistant", content: "checkpoint" },
          },
          {
            kind: "message",
            sequence: 4,
            message: { role: "assistant", content: "recent answer" },
          },
          {
            kind: "message",
            sequence: 5,
            userTurnId: "turn-current",
            message: { role: "user", content: "current" },
          },
        ];
      },
    },
  });
  const projector = new ContextProjector({
    historyPolicy: new LatestCheckpointHistoryPolicy(),
  });
  const projection = await projector.projectFromProviders({
    request: {
      model,
      messages: [{ role: "user", content: "current" }],
      tools: [],
    },
    currentUserMessageIndex: 0,
    providers: [provider],
    providerInput: contextInput(),
  });

  assert.equal(projection.status, "ready");
  assert.deepEqual(projection.request.messages.map((message) => message.content), [
    "checkpoint",
    "exact old constraint",
    "recent answer",
    "current",
  ]);
  assert.equal(
    projection.request.messages.filter((message) => message.content === "current").length,
    1,
  );
});
