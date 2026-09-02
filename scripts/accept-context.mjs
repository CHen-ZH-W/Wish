import assert from "node:assert/strict";
import test from "node:test";

import { ContextProjector } from "../dist/core/context/projector.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function request(messages) {
  return { model, messages, tools: [] };
}

function lane(id, kind, placement, role, content) {
  return { id, kind, placement, message: { role, content } };
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

function group(providerId, items) {
  return { providerId, items };
}

function assertReady(projection) {
  assert.equal(projection.status, "ready");
  return projection.request;
}

test("drives deterministic placement and preserves the current user message", async () => {
  const projector = new ContextProjector();
  const input = request([
    { role: "system", content: "system" },
    { role: "user", content: "current" },
  ]);
  const projection = await projector.project({
    request: input,
    currentUserMessageIndex: 1,
    groups: [group("context", [
      lane("stable", "instruction", "stable_prefix", "developer", "stable"),
      history("history-1", 1, "user", "old user"),
      history("history-2", 2, "assistant", "old answer"),
      lane("reference", "reference", "before_current_user", "assistant", "reference"),
      lane("state", "state", "dynamic_tail", "developer", "state"),
    ])],
  });
  const projected = assertReady(projection);

  assert.deepEqual(
    projected.messages.map((message) => message.content),
    ["system", "stable", "old user", "old answer", "reference", "state", "current"],
  );
  assert.equal(
    projected.messages.filter((message) =>
      message.role === "user" && message.content === "current").length,
    1,
  );
  assert.equal(projection.budget.status, "unknown");
  assert.equal(input.messages.length, 2);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.messages), true);
});

test("dynamic tail follows a complete assistant and Tool Result exchange", async () => {
  const projector = new ContextProjector();
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "current" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "first", argumentsJson: "{}" },
        { id: "call-2", name: "second", argumentsJson: "{}" },
      ],
    },
    { role: "tool", toolCallId: "call-2", content: "second result" },
    { role: "tool", toolCallId: "call-1", content: "first result" },
  ];
  const projection = await projector.project({
    request: request(messages),
    currentUserMessageIndex: 1,
    groups: [group("state", [
      lane("state", "state", "dynamic_tail", "developer", "step state"),
    ])],
  });
  const projected = assertReady(projection);

  assert.deepEqual(
    projected.messages.map((message) => message.content),
    [...messages.map((message) => message.content), "step state"],
  );
});

test("provider completion timing cannot change provider group order", async () => {
  const projection = await new ContextProjector().projectFromProviders({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    providerInput: { runId: "run-1" },
    providers: [
      {
        id: "first",
        async provide() {
          await Promise.resolve();
          return [history("first-item", 1, "user", "first")];
        },
      },
      {
        id: "second",
        provide() {
          return [history("second-item", 2, "assistant", "second")];
        },
      },
    ],
  });
  const projected = assertReady(projection);

  assert.deepEqual(
    projection.providerGroups.map((entry) => entry.providerId),
    ["first", "second"],
  );
  assert.deepEqual(
    projected.messages.map((message) => message.content),
    ["first", "second", "current"],
  );
});

test("duplicate item ids always fail closed in Core", async () => {
  await assert.rejects(new ContextProjector().project({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups: [
      group("one", [lane("state", "state", "dynamic_tail", "developer", "old")]),
      group("two", [lane("state", "state", "dynamic_tail", "developer", "new")]),
    ],
  }), /Duplicate Context item/u);
});

test("summary semantics use a narrow selection policy without rewriting items", async () => {
  const summary = {
    id: "summary",
    kind: "summary",
    placement: "history",
    sequence: 3,
    coveredThroughSequence: 2,
    message: { role: "assistant", content: "summary" },
  };
  const items = [
    history("old-user", 1, "user", "exact old request"),
    history("old-answer", 2, "assistant", "obsolete answer"),
    summary,
    history("recent", 4, "assistant", "recent answer"),
  ];
  const input = {
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups: [group("history", items)],
  };

  await assert.rejects(
    new ContextProjector().project(input),
    /explicit ContextHistoryPolicy/u,
  );

  const projector = new ContextProjector({
    historyPolicy: {
      select(historyInput) {
        assert.equal(Object.isFrozen(historyInput.request), true);
        const oldUser = historyInput.items.find((item) => item.id === "old-user");
        const selectedSummary = historyInput.items.find((item) => item.id === "summary");
        const recent = historyInput.items.find((item) => item.id === "recent");
        return {
          items: [
            { ...selectedSummary, message: { role: "assistant", content: "rewritten" } },
            oldUser,
            recent,
          ],
          metadata: { strategy: "checkpoint" },
        };
      },
    },
  });
  const projection = await projector.project(input);
  const projected = assertReady(projection);

  assert.deepEqual(
    projected.messages.map((message) => message.content),
    ["summary", "exact old request", "recent answer", "current"],
  );
  assert.deepEqual(projection.history.metadata, { strategy: "checkpoint" });
  await assert.rejects(new ContextProjector({
    historyPolicy: {
      select() {
        return { items: [history("unknown", 1, "user", "unknown")] };
      },
    },
  }).project({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups: [group("history", [history("known", 1, "user", "known")])],
  }), /selected an unknown history item/u);
});

test("archives each complete Tool Result before creating its visible copy", async () => {
  const stages = [];
  const source = request([
    { role: "user", content: "current" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call", name: "tool", argumentsJson: "{}" }],
    },
    { role: "tool", toolCallId: "call", content: "complete raw result" },
  ]);
  const projector = new ContextProjector({
    toolResults: {
      archive(input) {
        stages.push(`archive:${input.message.content}`);
        assert.equal(input.message.content, "complete raw result");
        assert.equal(input.request.messages[2].content, "complete raw result");
        assert.equal(Object.isFrozen(input.request), true);
        assert.equal(Object.isFrozen(input.message), true);
        return { id: "archive/call", metadata: { complete: true } };
      },
      toModelMessage(input) {
        stages.push(`visible:${input.archive.id}`);
        assert.equal(input.message.content, "complete raw result");
        return { ...input.message, content: "trimmed visible result" };
      },
    },
    budget: {
      assess(input) {
        stages.push(`budget:${input.request.messages[2].content}`);
        return {
          status: "within_budget",
          estimatedInputTokens: 10,
          inputLimitTokens: 100,
        };
      },
    },
  });
  const projection = await projector.project({
    request: source,
    currentUserMessageIndex: 0,
    groups: [],
  });
  const projected = assertReady(projection);

  assert.deepEqual(stages, [
    "archive:complete raw result",
    "visible:archive/call",
    "budget:trimmed visible result",
  ]);
  assert.equal(projected.messages[2].content, "trimmed visible result");
  assert.equal(source.messages[2].content, "complete raw result");
  assert.equal(projection.budget.status, "within_budget");
});

test("never creates a visible Tool Result when raw archival fails", async () => {
  const stages = [];
  const projector = new ContextProjector({
    toolResults: {
      archive() {
        stages.push("archive");
        throw new Error("archive failed");
      },
      toModelMessage(input) {
        stages.push("visible");
        return input.message;
      },
    },
  });

  await assert.rejects(projector.project({
    request: request([
      { role: "user", content: "current" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call", name: "tool", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "call", content: "raw" },
    ]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /archive failed/u);
  assert.deepEqual(stages, ["archive"]);
});

test("Tool Result projection cannot break assistant and tool pairing", async () => {
  const projector = new ContextProjector({
    toolResults: {
      archive() {
        return { id: "archive/call" };
      },
      toModelMessage(input) {
        return { ...input.message, toolCallId: "different" };
      },
    },
  });

  await assert.rejects(projector.project({
    request: request([
      { role: "user", content: "current" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call", name: "tool", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "call", content: "raw" },
    ]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /must preserve toolCallId/u);
});

test("rejects orphan, mismatched, and incomplete Tool Result history", async () => {
  const projector = new ContextProjector();
  await assert.rejects(projector.project({
    request: request([
      { role: "user", content: "current" },
      { role: "tool", toolCallId: "orphan", content: "result" },
    ]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /Orphan Tool Result/u);
  await assert.rejects(projector.project({
    request: request([
      { role: "user", content: "current" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "expected", name: "tool", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "different", content: "result" },
    ]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /does not match a pending call/u);
  await assert.rejects(projector.project({
    request: request([
      { role: "user", content: "current" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "missing", name: "tool", argumentsJson: "{}" }],
      },
    ]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /missing results at end/u);
});

test("over-budget becomes an explicit rejected projection", async () => {
  const projection = await new ContextProjector({
    budget: {
      assess() {
        return {
          status: "over_budget",
          estimatedInputTokens: 20,
          inputLimitTokens: 10,
        };
      },
    },
  }).project({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups: [],
  });

  assert.equal(projection.status, "rejected");
  assert.equal(projection.reason, "over_budget");
  assert.equal(projection.budget.status, "over_budget");
  assert.equal(projection.candidateRequest.messages[0].content, "current");
  assert.equal("request" in projection, false);
});

test("rejects ambiguous item, summary, and current-user structure", async () => {
  const projector = new ContextProjector();
  await assert.rejects(projector.project({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups: [group("same", []), group("same", [])],
  }), /Duplicate Context provider/u);
  await assert.rejects(projector.project({
    request: request([{ role: "assistant", content: "answer" }]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /must identify a user message/u);
  await assert.rejects(projector.project({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: undefined,
    groups: [],
  }), /must identify a request message/u);
  await assert.rejects(projector.project({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups: [group("history", [{
      id: "summary",
      kind: "summary",
      placement: "history",
      sequence: 2,
      coveredThroughSequence: 2,
      message: { role: "assistant", content: "summary" },
    }])],
  }), /must precede/u);
});

test("abort is checked between provider collection and projection", async () => {
  const controller = new AbortController();
  const operation = new ContextProjector().projectFromProviders({
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    providerInput: undefined,
    signal: controller.signal,
    providers: [{
      id: "provider",
      provide() {
        controller.abort(new Error("stop context"));
        return [];
      },
    }],
  });

  await assert.rejects(operation, /stop context/u);
});
