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

function history(id, sequence, role, content) {
  return {
    id,
    kind: "history",
    placement: "history",
    sequence,
    message: { role, content },
  };
}

function group(providerId, items) {
  return { providerId, items };
}

test("drives the default main path with explicit deterministic placement", async () => {
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

  assert.deepEqual(
    projection.request.messages.map((message) => message.content),
    ["system", "stable", "old user", "old answer", "reference", "state", "current"],
  );
  assert.equal(projection.request.messages.some((message) =>
    message.content.includes("[context:")), false);
  assert.equal(input.messages.length, 2);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.request), true);
  assert.equal(Object.isFrozen(projection.request.messages), true);
});

test("dynamic tail follows completed tool messages without rewriting history", async () => {
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
    { role: "tool", toolCallId: "orphan", content: "orphan result" },
  ];
  const projection = await projector.project({
    request: request(messages),
    currentUserMessageIndex: 1,
    groups: [group("state", [
      lane("state", "state", "dynamic_tail", "developer", "step state"),
    ])],
  });

  assert.deepEqual(
    projection.request.messages.map((message) => message.content),
    [...messages.map((message) => message.content), "step state"],
  );
  assert.equal(
    projection.request.messages.some((message) => message.toolCallId === "orphan"),
    true,
  );
});

test("provider completion timing cannot change provider group order", async () => {
  const projector = new ContextProjector();
  const seenGroups = [];
  const projection = await new ContextProjector({
    itemResolver: {
      resolve(input) {
        seenGroups.push(...input.groups.map((item) => item.providerId));
        return input.groups.flatMap((item) => item.items);
      },
    },
  }).projectFromProviders({
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

  assert.deepEqual(seenGroups, ["first", "second"]);
  assert.deepEqual(
    projection.request.messages.map((message) => message.content),
    ["first", "second", "current"],
  );
  void projector;
});

test("default resolver rejects collisions while an external resolver can decide them", async () => {
  const groups = [
    group("one", [lane("state", "state", "dynamic_tail", "developer", "old")]),
    group("two", [lane("state", "state", "dynamic_tail", "developer", "new")]),
  ];
  const input = {
    request: request([{ role: "user", content: "current" }]),
    currentUserMessageIndex: 0,
    groups,
  };

  await assert.rejects(new ContextProjector().project(input), /Duplicate Context item/u);

  const projector = new ContextProjector({
    itemResolver: {
      resolve(resolution) {
        const byId = new Map();
        for (const item of resolution.groups.flatMap((entry) => entry.items)) {
          byId.set(item.id, item);
        }
        return [...byId.values()];
      },
    },
  });
  const projection = await projector.project(input);

  assert.deepEqual(
    projection.request.messages.map((message) => message.content),
    ["new", "current"],
  );
});

test("summary semantics require and use an external history policy", async () => {
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

  await assert.rejects(new ContextProjector().project(input), /explicit ContextHistoryPolicy/u);

  const projector = new ContextProjector({
    historyPolicy: {
      select(historyInput) {
        const oldUser = historyInput.items.find((item) => item.id === "old-user");
        const selectedSummary = historyInput.items.find((item) => item.id === "summary");
        const recent = historyInput.items.find((item) => item.id === "recent");
        return {
          items: [selectedSummary, oldUser, recent],
          metadata: { strategy: "checkpoint" },
        };
      },
    },
  });
  const projection = await projector.project(input);

  assert.deepEqual(
    projection.request.messages.map((message) => message.content),
    ["summary", "exact old request", "recent answer", "current"],
  );
  assert.deepEqual(projection.history.metadata, { strategy: "checkpoint" });
});

test("typed stages execute in order and budget sees the admitted request", async () => {
  const stages = [];
  const projector = new ContextProjector({
    itemRenderer: {
      render(input) {
        stages.push(`render:${input.item.id}`);
        return { ...input.item.message, content: `rendered:${input.item.message.content}` };
      },
    },
    messageNormalizer: {
      normalize(input) {
        stages.push("normalize");
        return input.messages;
      },
    },
    admissionPolicy: {
      admit(input) {
        stages.push(`admit:${input.messageIndex}`);
        return input.message.role === "tool"
          ? { ...input.message, content: "admitted tool result" }
          : input.message;
      },
    },
    budgetPolicy: {
      assess(input) {
        stages.push(`budget:${input.request.messages.at(-1).content}`);
        return {
          status: "within_budget",
          estimatedInputTokens: 10,
          inputLimitTokens: 100,
        };
      },
    },
  });
  const projection = await projector.project({
    request: request([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call", name: "tool", argumentsJson: "{}" }],
      },
      { role: "tool", toolCallId: "call", content: "raw tool result" },
    ]),
    groups: [group("state", [
      lane("state", "state", "dynamic_tail", "developer", "state"),
    ])],
  });

  assert.deepEqual(stages, [
    "render:state",
    "normalize",
    "admit:0",
    "admit:1",
    "admit:2",
    "budget:rendered:state",
  ]);
  assert.equal(projection.request.messages[1].content, "admitted tool result");
  assert.equal(projection.budget.status, "within_budget");
});

test("external policies cannot mutate the source request in place", async () => {
  const source = request([{ role: "user", content: "current" }]);
  const projector = new ContextProjector({
    admissionPolicy: {
      admit(input) {
        assert.equal(Object.isFrozen(input.request), true);
        assert.equal(Object.isFrozen(input.message), true);
        return input.message;
      },
    },
  });

  const projection = await projector.project({
    request: source,
    groups: [],
    currentUserMessageIndex: 0,
  });

  assert.notEqual(projection.request, source);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(source.messages[0].content, "current");
});

test("rejects ambiguous provider, item, summary, and current-user structure", async () => {
  const projector = new ContextProjector();
  await assert.rejects(projector.project({
    request: request([{ role: "user", content: "current" }]),
    groups: [group("same", []), group("same", [])],
  }), /Duplicate Context provider/u);
  await assert.rejects(projector.project({
    request: request([{ role: "assistant", content: "answer" }]),
    currentUserMessageIndex: 0,
    groups: [],
  }), /must identify a user message/u);
  await assert.rejects(projector.project({
    request: request([]),
    groups: [group("history", [{
      id: "summary",
      kind: "summary",
      placement: "history",
      sequence: 2,
      coveredThroughSequence: 2,
      message: { role: "assistant", content: "summary" },
    }])],
  }), /must precede/u);
  await assert.rejects(projector.project({
    request: request([{ role: "user", content: "current" }]),
    groups: [group("context", [
      lane("reference", "reference", "before_current_user", "assistant", "reference"),
    ])],
  }), /currentUserMessageIndex is required/u);
});

test("abort is checked between provider collection and projection stages", async () => {
  const controller = new AbortController();
  const projector = new ContextProjector();
  const operation = projector.projectFromProviders({
    request: request([]),
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
