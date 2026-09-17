import assert from "node:assert/strict";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { Agent } from "../dist/core/agent/agent.js";
import { AgentLoop } from "../dist/core/agent-loop/agent-loop.js";
import { Runtime } from "../dist/core/runtime/runtime.js";
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
import { createContextBundle } from "../dist/context/index.js";
import {
  InMemorySessionStore,
  SessionHistoryAdapter,
  SessionIdempotencyConflictError,
  SessionInvalidTranscriptError,
  SessionManager,
  SessionNotFoundError,
  SessionRevisionConflictError,
  SessionTranscriptPipeline,
  createSessionInputRenderer,
} from "../dist/sessions/index.js";
import {
  FileSessionStore,
  sessionStorageKey,
} from "../dist/sessions/providers/file/store.js";
import {
  withContextToolResultArchiveReceipt,
} from "../dist/context/index.js";

function deterministicStore() {
  let tick = 0;
  let record = 0;
  let revision = 0;
  return new InMemorySessionStore({
    now: () => `2026-09-03T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    recordId: () => `record-${++record}`,
    revision: () => `opaque-revision-${++revision}`,
  });
}

async function createSession(store, sessionId = "session-1") {
  const sessions = new SessionManager(store);
  await sessions.create({ sessionId, agentId: "agent-1", scope: sessionId });
  return sessions;
}

function messageDraft(overrides = {}) {
  return {
    idempotencyKey: "run-1/turn-1/input",
    runId: "run-1",
    userTurnId: "turn-1",
    stepId: "step-1",
    origin: "user_input",
    message: { role: "user", content: "exact input" },
    ...overrides,
  };
}

test("manages Session identity and keeps metadata outside history revision", async () => {
  const sessions = await createSession(deterministicStore());
  const created = await sessions.get({ sessionId: "session-1" });
  const revision = created.historyRevision;
  const titled = await sessions.updateMetadata({
    sessionId: "session-1",
    title: "Exact title",
  });
  assert.equal(titled.title, "Exact title");
  assert.equal(titled.historyRevision, revision);
  assert.notEqual(titled.updatedAt, created.updatedAt);
  assert.equal((await sessions.list({ status: "active" })).length, 1);
  assert.equal((await sessions.list({ agentId: "other" })).length, 0);

  const archived = await sessions.archive({ sessionId: "session-1" });
  assert.equal(archived.status, "archived");
  await assert.rejects(
    sessions.appendMessages({ sessionId: "session-1", messages: [messageDraft()] }),
    /archived/u,
  );
  await assert.rejects(
    sessions.get({ sessionId: "missing" }),
    SessionNotFoundError,
  );
});

for (const kind of ["memory", "file"]) test(`${kind} Session restore and delete preserve other data and reserve deleted identities`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-actions-"));
  const store = kind === "memory" ? deterministicStore() : new FileSessionStore({ rootDirectory: directory });
  try {
    const manager = await createSession(store);
    assert.equal(await manager.wasDeleted({ sessionId: "session-1" }), false);
    assert.equal(await manager.wasDeleted({ sessionId: "never-created" }), false);
    await manager.create({ sessionId: "keep", agentId: "agent-1", scope: directory });
    await manager.appendMessages({ sessionId: "session-1", messages: [messageDraft()] });
    const history = await manager.readHistory({ sessionId: "session-1" });
    await manager.archive({ sessionId: "session-1" });
    assert.equal((await manager.list({ status: "active" })).length, 1);
    assert.equal((await manager.list({ status: "archived" })).length, 1);
    await manager.restore({ sessionId: "session-1" });
    assert.equal((await manager.get({ sessionId: "session-1" })).status, "active");
    assert.deepEqual(await manager.readHistory({ sessionId: "session-1" }), history);
    // A list already in flight must tolerate a concurrently removed directory.
    await Promise.all([manager.list(), manager.delete({ sessionId: "session-1" }), manager.list()]);
    assert.equal(await manager.wasDeleted({ sessionId: "session-1" }), true);
    assert.equal(await manager.wasDeleted({ sessionId: "keep" }), false);
    await assert.rejects(manager.get({ sessionId: "session-1" }), { code: "session_not_found" });
    await assert.rejects(manager.readHistory({ sessionId: "session-1" }), { code: "session_not_found" });
    await assert.rejects(manager.restore({ sessionId: "session-1" }), { code: "session_not_found" });
    await assert.rejects(manager.create({ sessionId: "session-1", agentId: "agent-1", scope: directory }), { code: "session_already_exists" });
    await manager.delete({ sessionId: "session-1" });
    assert.deepEqual((await manager.list()).map(item => item.sessionId), ["keep"]);
    if (kind === "file") {
      const marker = join(directory, `.deleted-session-${sessionStorageKey("session-1")}`);
      assert.deepEqual(await readdir(marker), []);
      await store.close();
      const reopened = new FileSessionStore({ rootDirectory: directory });
      try {
        assert.equal(await reopened.get({ sessionId: "session-1" }), undefined);
        assert.equal(await reopened.wasDeleted({ sessionId: "session-1" }), true);
        await assert.rejects(reopened.create({ sessionId: "session-1", agentId: "agent-1", scope: directory }), { code: "session_already_exists" });
      } finally { await reopened.close(); }
    }
  } finally { await store.close?.(); await rm(directory, { recursive: true, force: true }); }
});

test("round-trips exact messages, reasoning, Tool Calls and archive receipts", async () => {
  const sessions = await createSession(deterministicStore());
  const contentParts = [{ type: "text", text: "look" }];
  const toolCalls = [{ id: "call-1", name: "read", argumentsJson: "{\"path\":\"a\"}" }];
  const assistant = {
    role: "assistant",
    content: "calling",
    reasoningContent: "private reasoning",
    contentParts,
    toolCalls,
  };
  const resultMessage = { role: "tool", content: "full result", toolCallId: "call-1" };
  const committed = await sessions.appendMessages({
    sessionId: "session-1",
    messages: [
      messageDraft({
        idempotencyKey: "run-1/turn-1/1",
        origin: "assistant",
        message: assistant,
      }),
      messageDraft({
        idempotencyKey: "run-1/turn-1/2",
        origin: "tool",
        message: resultMessage,
        toolResultArchive: {
          schemaVersion: 1,
          toolCallId: "call-1",
          locator: "archive://one",
          hash: "sha256-one",
        },
      }),
    ],
  });
  contentParts[0].text = "mutated";
  toolCalls[0].name = "mutated";

  const snapshot = await sessions.readHistory({ sessionId: "session-1" });
  assert.deepEqual(snapshot.records.map((record) => record.sequence), [1, 2]);
  assert.equal(snapshot.records[0].message.contentParts[0].text, "look");
  assert.equal(snapshot.records[0].message.toolCalls[0].name, "read");
  assert.equal(snapshot.records[0].message.reasoningContent, "private reasoning");
  assert.equal(snapshot.records[1].toolResultArchive.locator, "archive://one");
  assert.equal("__wishContextToolResultArchive" in snapshot.records[1].message, false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.records), true);
  assert.equal(Object.isFrozen(snapshot.records[0].message.toolCalls), true);
  assert.notEqual(snapshot.historyRevision, "2");
  assert.equal(committed.replayed, false);
});

test("replays identical idempotency keys and fails closed on changed content", async () => {
  const sessions = await createSession(deterministicStore());
  const input = { sessionId: "session-1", messages: [messageDraft()] };
  const first = await sessions.appendMessages(input);
  const replay = await sessions.appendMessages({
    ...input,
    expectedRevision: "stale-on-purpose",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.historyRevision, first.historyRevision);
  assert.equal(replay.records[0].recordId, first.records[0].recordId);
  await assert.rejects(
    sessions.appendMessages({
      sessionId: "session-1",
      messages: [messageDraft({ message: { role: "user", content: "changed" } })],
    }),
    SessionIdempotencyConflictError,
  );
});

test("serializes concurrent appends into one continuous Session order", async () => {
  const sessions = await createSession(deterministicStore());
  await Promise.all(Array.from({ length: 32 }, (_, index) =>
    sessions.appendMessages({
      sessionId: "session-1",
      messages: [messageDraft({
        idempotencyKey: `input-${index}`,
        runId: `run-${index}`,
        userTurnId: `turn-${index}`,
        stepId: `step-${index}`,
        message: { role: "user", content: `message-${index}` },
      })],
    })
  ));
  const snapshot = await sessions.readHistory({ sessionId: "session-1" });
  assert.deepEqual(
    snapshot.records.map((record) => record.sequence),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  assert.equal(new Set(snapshot.records.map((record) => record.idempotencyKey)).size, 32);
});

test("rejects orphan, duplicate and mismatched Tool units", async () => {
  const sessions = await createSession(deterministicStore());
  await assert.rejects(
    sessions.appendMessages({
      sessionId: "session-1",
      messages: [messageDraft({
        origin: "tool",
        message: { role: "tool", content: "orphan", toolCallId: "call-1" },
      })],
    }),
    SessionInvalidTranscriptError,
  );
  await assert.rejects(
    sessions.appendMessages({
      sessionId: "session-1",
      messages: [messageDraft({
        origin: "assistant",
        message: {
          role: "assistant",
          content: "duplicate",
          toolCalls: [
            { id: "same", name: "read", argumentsJson: "{}" },
            { id: "same", name: "write", argumentsJson: "{}" },
          ],
        },
      })],
    }),
    /Duplicate Tool Call/u,
  );
  await assert.rejects(
    sessions.appendMessages({
      sessionId: "session-1",
      messages: [
        messageDraft({
          origin: "assistant",
          message: {
            role: "assistant",
            content: "call",
            toolCalls: [{ id: "call-1", name: "read", argumentsJson: "{}" }],
          },
        }),
        messageDraft({
          idempotencyKey: "result",
          origin: "tool",
          message: { role: "tool", content: "wrong", toolCallId: "call-2" },
        }),
      ],
    }),
    /does not match/u,
  );
  assert.equal((await sessions.readHistory({ sessionId: "session-1" })).records.length, 0);
});

test("enforces checkpoint CAS, real coverage and Tool-unit boundaries", async () => {
  const sessions = await createSession(deterministicStore());
  await sessions.appendMessages({
    sessionId: "session-1",
    messages: [messageDraft()],
  });
  await sessions.appendMessages({
    sessionId: "session-1",
    messages: [
      messageDraft({
        idempotencyKey: "assistant-call",
        origin: "assistant",
        message: {
          role: "assistant",
          content: "call",
          toolCalls: [{ id: "call-1", name: "read", argumentsJson: "{}" }],
        },
      }),
      messageDraft({
        idempotencyKey: "tool-result",
        origin: "tool",
        message: { role: "tool", content: "done", toolCallId: "call-1" },
      }),
    ],
  });
  const before = await sessions.readHistory({ sessionId: "session-1" });
  const titled = await sessions.updateMetadata({
    sessionId: "session-1",
    title: "Metadata does not conflict",
  });
  assert.equal(titled.historyRevision, before.historyRevision);
  const base = {
    idempotencyKey: "checkpoint-1",
    sourceSequences: [1, 2, 3],
    reason: "context_over_budget",
    message: { role: "assistant", content: "summary" },
  };
  await assert.rejects(
    sessions.appendCheckpoint({
      sessionId: "session-1",
      expectedRevision: before.historyRevision,
      checkpoint: {
        ...base,
        coveredThroughSequence: 2,
        sourceSequences: [1, 2],
      },
    }),
    /splits Tool Call unit/u,
  );
  await assert.rejects(
    sessions.appendCheckpoint({
      sessionId: "session-1",
      expectedRevision: "stale",
      checkpoint: { ...base, coveredThroughSequence: 3 },
    }),
    SessionRevisionConflictError,
  );
  const first = await sessions.appendCheckpoint({
    sessionId: "session-1",
    expectedRevision: before.historyRevision,
    checkpoint: { ...base, coveredThroughSequence: 3 },
  });
  const replay = await sessions.appendCheckpoint({
    sessionId: "session-1",
    expectedRevision: before.historyRevision,
    checkpoint: { ...base, coveredThroughSequence: 3 },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.recordId, first.record.recordId);
  assert.equal(replay.historyRevision, first.historyRevision);
});

test("feeds Context and Compaction from one immutable Session snapshot", async () => {
  const sessions = await createSession(deterministicStore());
  await sessions.appendMessages({
    sessionId: "session-1",
    messages: [messageDraft()],
  });
  const adapter = new SessionHistoryAdapter({ sessions });
  const context = await adapter.context.read({ sessionId: "session-1" });
  const compaction = await adapter.compaction.read({ sessionId: "session-1" });
  assert.deepEqual(context, compaction.records);
  assert.equal(context[0].userTurnId, "turn-1");
  const appended = await adapter.compaction.appendCheckpoint({
    sessionId: "session-1",
    expectedRevision: compaction.revision,
    checkpoint: {
      reason: "context_over_budget",
      coveredThroughSequence: 1,
      sourceSequences: [1],
      message: { role: "assistant", content: "summary" },
    },
  });
  const replay = await adapter.compaction.appendCheckpoint({
    sessionId: "session-1",
    expectedRevision: compaction.revision,
    checkpoint: {
      reason: "context_over_budget",
      coveredThroughSequence: 1,
      sourceSequences: [1],
      message: { role: "assistant", content: "summary" },
    },
  });
  assert.equal(replay.sequence, appended.sequence);
  assert.equal((await adapter.context.read({ sessionId: "session-1" }))[1].kind, "summary");
});

function stepSnapshot({ steering = [] } = {}) {
  return {
    schemaVersion: 1,
    capturedAt: "2026-09-03T01:00:00.000Z",
    stateVersion: 1,
    run: { runId: "run-1", agentId: "agent-1", scope: "session-1" },
    userTurn: { userTurnId: "turn-1", ordinal: 1, input: { text: "hello" } },
    step: { stepId: "step-1", ordinal: 1 },
    steering,
    environment: {},
  };
}

test("commits rendered input before projection and replays Compaction rendering", async () => {
  const sessions = await createSession(deterministicStore());
  let renders = 0;
  const renderer = createSessionInputRenderer({
    sessions,
    delegate: {
      renderUserInput() {
        renders += 1;
        return { role: "user", content: "exact rendered input" };
      },
      renderSteering({ message }) {
        return { role: "user", content: message.text };
      },
    },
  });
  const snapshot = stepSnapshot();
  assert.equal((await renderer.renderUserInput({ payload: snapshot.userTurn.input, snapshot })).content, "exact rendered input");
  assert.equal((await renderer.renderUserInput({ payload: snapshot.userTurn.input, snapshot })).content, "exact rendered input");
  assert.equal(renders, 2);
  const steering = {
    id: "control-1",
    kind: "steer",
    runId: "run-1",
    userTurnId: "turn-1",
    text: "steer exactly",
    source: "test",
    receivedAt: "2026-09-03T01:00:01.000Z",
  };
  const steeredSnapshot = stepSnapshot({ steering: [steering] });
  await renderer.renderSteering({ message: steering, snapshot: steeredSnapshot });
  const history = await sessions.readHistory({ sessionId: "session-1" });
  assert.deepEqual(history.records.map((record) => record.idempotencyKey), [
    "run-1/turn-1/input",
    "control-1",
  ]);
});

function loopMemory(messages) {
  return {
    schemaVersion: 1,
    model: { provider: "test", model: "test" },
    messages,
    currentUserMessageIndex: 0,
  };
}

function pipelineInput(memory) {
  return {
    definition: { id: "agent-1" },
    snapshot: stepSnapshot(),
    memory,
    signal: new AbortController().signal,
    output: { publishModel() {}, publishTool() {} },
  };
}

test("commits only generated Step suffix and preserves archive receipt separately", async () => {
  const sessions = await createSession(deterministicStore());
  const user = { role: "user", content: "current" };
  await sessions.appendMessages({
    sessionId: "session-1",
    messages: [messageDraft({ message: user })],
  });
  const assistant = {
    role: "assistant",
    content: "call",
    toolCalls: [{ id: "call-1", name: "read", argumentsJson: "{}" }],
  };
  const tool = withContextToolResultArchiveReceipt(
    { role: "tool", content: "result", toolCallId: "call-1" },
    {
      schemaVersion: 1,
      toolCallId: "call-1",
      locator: "archive://one",
      hash: "hash-one",
    },
  );
  const resultMemory = loopMemory([user, assistant, tool]);
  const pipeline = new SessionTranscriptPipeline({
    sessions,
    delegate: {
      async execute() {
        return { status: "continue", reason: "tool_calls", memory: resultMemory };
      },
    },
  });
  const result = await pipeline.execute(pipelineInput(loopMemory([user])));
  assert.equal(result.status, "continue");
  const history = await sessions.readHistory({ sessionId: "session-1" });
  assert.deepEqual(history.records.map((record) => record.message.role), [
    "user",
    "assistant",
    "tool",
  ]);
  assert.equal(history.records[2].toolResultArchive.hash, "hash-one");
  assert.equal("__wishContextToolResultArchive" in history.records[2].message, false);
});

test("turns a transcript write failure into session_commit_failed", async () => {
  const user = { role: "user", content: "current" };
  const assistant = { role: "assistant", content: "done" };
  const memory = loopMemory([user, assistant]);
  const pipeline = new SessionTranscriptPipeline({
    sessions: { appendMessages: async () => { throw new Error("disk full"); } },
    delegate: {
      async execute() {
        return {
          status: "completed",
          result: {
            output: {
              model: memory.model,
              reasoning: "",
              text: "done",
              toolCalls: [],
            },
            message: assistant,
            messages: memory.messages,
          },
          memory,
        };
      },
    },
  });
  const result = await pipeline.execute(pipelineInput(loopMemory([user])));
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "session_commit_failed");
  assert.match(result.error.message, /disk full/u);
});

test("persists safe file layout and recovers stale metadata from history", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sessions-"));
  try {
    const warnings = [];
    let revision = 0;
    const store = new FileSessionStore({
      rootDirectory: root,
      revision: () => `file-revision-${++revision}`,
      recordId: () => `file-record-${revision}`,
      temporaryId: () => `temp-${revision}-${Math.random()}`,
      onWarning: (warning) => warnings.push(warning),
    });
    const unsafeId = "../unsafe/session";
    const sessions = await createSession(store, unsafeId);
    const before = await sessions.readHistory({ sessionId: unsafeId });
    await sessions.appendMessages({
      sessionId: unsafeId,
      messages: [messageDraft()],
    });
    const after = await sessions.readHistory({ sessionId: unsafeId });
    const names = await readdir(root);
    assert.deepEqual(names, [`session-${sessionStorageKey(unsafeId)}`]);
    assert.equal(names[0].includes("unsafe"), false);
    const directory = join(root, names[0]);
    const historyPath = join(directory, "history.jsonl");
    const historyText = await readFile(historyPath, "utf8");
    const lines = historyText.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).records.length, 1);

    await writeFile(historyPath, historyText.slice(0, -1));
    await sessions.readHistory({ sessionId: unsafeId });
    assert.equal((await readFile(historyPath, "utf8")).endsWith("\n"), true);
    assert.equal(
      warnings.some((warning) => warning.code === "history_tail_newline_repaired"),
      true,
    );

    const metadataPath = join(directory, "session.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.session.historyRevision = before.historyRevision;
    metadata.session.updatedAt = metadata.session.createdAt;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const reopened = new SessionManager(new FileSessionStore({
      rootDirectory: root,
      onWarning: (warning) => warnings.push(warning),
    }));
    const recovered = await reopened.readHistory({ sessionId: unsafeId });
    assert.equal(recovered.historyRevision, after.historyRevision);
    assert.equal(warnings.some((warning) => warning.code === "session_revision_repaired"), true);

    await appendFile(historyPath, "{\"truncated\"");
    const withTail = await reopened.readHistory({ sessionId: unsafeId });
    assert.equal(withTail.records.length, 1);
    assert.equal(warnings.some((warning) => warning.code === "truncated_history_tail_ignored"), true);
    await reopened.appendMessages({
      sessionId: unsafeId,
      messages: [messageDraft({
        idempotencyKey: "after-tail-repair",
        runId: "run-2",
        userTurnId: "turn-2",
        stepId: "step-2",
        message: { role: "user", content: "after repair" },
      })],
    });
    assert.equal(
      (await reopened.readHistory({ sessionId: unsafeId })).records.length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file Store fails closed on middle corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sessions-corrupt-"));
  try {
    const store = new FileSessionStore({ rootDirectory: root });
    const sessions = await createSession(store, "session-corrupt");
    await sessions.appendMessages({
      sessionId: "session-corrupt",
      messages: [messageDraft()],
    });
    const directory = join(root, `session-${sessionStorageKey("session-corrupt")}`);
    await appendFile(join(directory, "history.jsonl"), "not-json\n");
    await assert.rejects(
      sessions.readHistory({ sessionId: "session-corrupt" }),
      /invalid JSON/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function deterministicRuntimeServices() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () => `2026-09-03T02:00:${String(++counters.time).padStart(2, "0")}Z`,
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
    now: () => new Date("2026-09-03T02:00:00.000Z"),
  });
  return {
    registry,
    scheduler: new BoundedToolScheduler({ executor, maxParallelCalls: 1 }),
  };
}

test("composes Sessions -> Context -> Compaction -> AgentLoop without current-user duplication", async () => {
  const sessions = await createSession(deterministicStore());
  await sessions.appendMessages({
    sessionId: "session-1",
    messages: [messageDraft({
      idempotencyKey: "old-input",
      runId: "old-run",
      userTurnId: "old-turn",
      stepId: "old-step-1",
      message: { role: "user", content: "verbatim old constraint" },
    })],
  });
  await sessions.appendMessages({
    sessionId: "session-1",
    messages: [messageDraft({
      idempotencyKey: "old-answer",
      runId: "old-run",
      userTurnId: "old-turn",
      stepId: "old-step-1",
      origin: "assistant",
      message: { role: "assistant", content: "old answer" },
    })],
  });

  const history = new SessionHistoryAdapter({ sessions });
  const agentModel = Object.freeze({ provider: "test", model: "agent" });
  const summaryModel = Object.freeze({ provider: "test", model: "summary" });
  const modelRequests = [];
  const summaryRequests = [];
  const model = {
    async *stream(request) {
      if (request.model.model === "summary") {
        summaryRequests.push(request);
        yield { type: "start", model: summaryModel };
        yield { type: "text_delta", text: "checkpoint of old work" };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      modelRequests.push(request);
      yield { type: "start", model: agentModel };
      yield { type: "text_delta", text: "final answer" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  const counter = {
    count({ request }) {
      if (request.messages.some((message) => message.content === "current request")) {
        return {
          inputTokens: request.messages.some(
            (message) => message.content === "checkpoint of old work",
          ) ? 40 : 101,
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
    history: history.context,
    agentInstructions: [
      { id: "agent", authority: "system", content: "Be exact." },
    ],
    archive: { archive: () => { throw new Error("No Tool Result expected"); } },
    models: { getContextWindowTokens: () => 100 },
    counter,
    configuration: { reservedOutputTokens: 20 },
  });
  const compactor = new SessionCompactor({
    session: history.compaction,
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
    input: createSessionInputRenderer({
      sessions,
      delegate: {
        renderUserInput: () => ({ role: "user", content: "current request" }),
        renderSteering: ({ message }) => ({ role: "user", content: message.text }),
      },
    }),
    environment: {
      resolve({ snapshot }) {
        return {
          model: agentModel,
          context: context.forStep({
            snapshot,
            sessionId: snapshot.run.scope,
            model: agentModel,
            workspace: {
              cwd: "/workspace",
              fingerprint: "workspace:fixture",
              revision: "workspace-revision:fixture",
              instructions: [],
            },
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
      resolve: ({ snapshot }) => ({
        sessionId: snapshot.run.scope,
        model: agentModel,
      }),
    },
  });
  const runtime = new Runtime({
    ...deterministicRuntimeServices(),
    stepPipeline: new SessionTranscriptPipeline({
      delegate: recovering,
      sessions,
    }),
  });
  const completion = await new Agent({ id: "agent-1" }, runtime).startRun({
    scope: "session-1",
    payload: { text: "current request" },
  }).completion;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "final answer");
  assert.equal(summaryRequests.length, 1);
  assert.equal(modelRequests.length, 1);
  assert.equal(
    modelRequests[0].messages.filter(
      (message) => message.content === "current request",
    ).length,
    1,
  );
  assert.equal(
    summaryRequests[0].messages.some(
      (message) => message.content.includes("current request"),
    ),
    false,
  );
  const stored = await sessions.readHistory({ sessionId: "session-1" });
  assert.deepEqual(stored.records.map((record) => record.kind), [
    "message",
    "message",
    "message",
    "checkpoint",
    "message",
  ]);
  assert.equal(
    stored.records.filter(
      (record) => record.kind === "message" &&
        record.message.content === "current request",
    ).length,
    1,
  );
});
