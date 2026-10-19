import assert from "node:assert/strict";
import test from "node:test";

import { Runtime } from "../dist/core/runtime/runtime.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { TodoContextProvider, TodoRuntime } from "../dist/todo/index.js";
import { createTodoWriteTool } from "../dist/todo/consumers/model-tool.js";
import { createTodoSessionFeature } from "../dist/todo/consumers/session-feature.js";
import { TodoSubagentProgress } from "../dist/todo/subagent-progress.js";

test("terminal Run Todo cleanup precedes slower child and Workflow cleanup", async () => {
  const todo = new TodoRuntime();
  const feature = createTodoSessionFeature(todo);
  assert.ok(feature.purgeOrder < 10);
  await todo.openTurn({ sessionId: "session-todo", runId: "run-one", userTurnId: "turn-one" });
  await todo.replace({ sessionId: "session-todo", runId: "run-one", userTurnId: "turn-one",
    items: [{ id: "inspect", content: "Inspect source", status: "in_progress" }] });
  await feature.purgeRun("session-todo", "run-one");
  assert.equal(await todo.get("session-todo"), undefined);
  await todo.close();
});

function services() {
  const sequence = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++sequence.run}`,
      userTurnId: () => `turn-${++sequence.turn}`,
      controlId: () => `control-${++sequence.control}`,
      eventId: () => `event-${++sequence.event}`,
    },
    now: () => `2026-09-26T00:00:${String(++sequence.time).padStart(2, "0")}Z`,
  };
}

test("Todo resets at the authenticated UserTurn-open seam and rejects stale writes", async () => {
  const todo = new TodoRuntime();
  const seen = [];
  let runtime;
  let handle;
  let firstIdentity;
  runtime = new Runtime({
    ...services(),
    continuationPolicy: {
      async openUserTurn({ run, userTurn }) {
        await todo.openTurn({
          sessionId: run.scope,
          runId: run.runId,
          userTurnId: userTurn.id,
          openedAt: userTurn.startedAt,
        });
      },
    },
    stepPipeline: {
      async execute({ snapshot }) {
        const state = await todo.get(snapshot.run.scope);
        seen.push(state);
        if (snapshot.userTurn.ordinal === 1) {
          firstIdentity = {
            sessionId: snapshot.run.scope,
            runId: snapshot.run.runId,
            userTurnId: snapshot.userTurn.userTurnId,
          };
          await todo.replace({
            ...firstIdentity,
            items: [{ id: "inspect", content: "Inspect source", status: "in_progress" }],
          });
          assert.equal(runtime.control("todo-agent", handle.runId, {
            type: "follow_up",
            source: "wish-webui",
            payload: "continue",
            text: "continue",
          }).accepted, true);
        } else {
          assert.equal(state.revision, 0);
          assert.deepEqual(state.items, []);
          await assert.rejects(todo.replace({
            ...firstIdentity,
            items: [{ id: "late", content: "Late write", status: "pending" }],
          }), /identity conflict/u);
        }
        return { status: "completed", result: "done" };
      },
    },
  });
  handle = runtime.startRun(
    { id: "todo-agent" },
    { scope: "session-todo", payload: "start", inputSource: "user" },
  );
  const completion = await handle.completion;
  assert.equal(completion.status, "completed");
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].userTurnId, seen[1].userTurnId);
  await todo.close();
});

test("todo_write replaces the whole list and Context projects only the matching turn", async () => {
  const todo = new TodoRuntime();
  await todo.openTurn({
    sessionId: "session-todo",
    runId: "run-todo",
    userTurnId: "turn-todo",
    openedAt: "2026-09-26T00:00:00Z",
  });
  const registry = new ToolRegistry();
  registry.register(createTodoWriteTool(todo));
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize() { return { status: "allowed", policyVersion: "todo-policy-v1" }; },
      revalidate() { return { status: "valid", policyVersion: "todo-policy-v1" }; },
    },
  });
  const parsed = registry.parseCall({
    id: "todo-call",
    name: "todo_write",
    argumentsJson: JSON.stringify({ todos: [
      { id: "one", content: "First", status: "completed" },
      { id: "two", content: "Second", status: "in_progress" },
    ] }),
  });
  assert.equal(parsed.ok, true);
  const snapshot = registry.captureSnapshot({
    authorityVersion: "todo-authority-v1",
    availableTools: ["todo_write"],
  });
  const subject = Object.freeze({
    agentId: "wish",
    sessionId: "session-todo",
    runId: "run-todo",
    userTurnId: "turn-todo",
    stepId: "step-todo",
  });
  const result = await executor.execute({
    call: parsed.call,
    context: Object.freeze({
      cwd: process.cwd(),
      workspace: Object.freeze({ root: process.cwd() }),
      permissions: Object.freeze({ subject }),
      userTurn: Object.freeze({
        runId: "run-todo",
        userTurnId: "turn-todo",
        ordinal: 1,
        inputSource: "user",
        provenance: Object.freeze({
          origin: "run_input",
          source: "user",
          receivedAt: "2026-09-26T00:00:00Z",
        }),
      }),
    }),
    scope: Object.freeze({
      runId: "run-todo",
      userTurnId: "turn-todo",
      stepId: "step-todo",
    }),
    snapshot,
  });
  assert.equal(result.ok, true);
  assert.equal(result.output.todo.revision, 1);
  assert.equal(result.output.todo.items.length, 2);

  const provider = new TodoContextProvider(todo);
  const input = {
    runId: "run-todo",
    userTurnId: "turn-todo",
    stepId: "step-todo",
    sessionId: "session-todo",
    model: { provider: "fixture", model: "model" },
    workspace: {
      cwd: process.cwd(), fingerprint: "workspace", revision: "v1", instructions: [],
    },
    runtime: {
      capturedAt: "2026-09-26T00:00:01Z",
      stateVersion: 1,
      userTurnOrdinal: 1,
      stepOrdinal: 1,
    },
  };
  const projected = await provider.provide(input);
  assert.equal(projected.length, 1);
  assert.match(projected[0].message.content, /resets when the next UserTurn opens/u);
  assert.deepEqual(await provider.provide({ ...input, userTurnId: "turn-other" }), []);
  const view = await createTodoSessionFeature(todo).inspect("session-todo");
  assert.equal(view.key, "todo");
  assert.match(view.title, /1\/2/u);
  await todo.close();
});

test("Todo accepts parallel in-progress items for linked child work", async () => {
  const todo = new TodoRuntime();
  await todo.openTurn({ sessionId: "s", runId: "r", userTurnId: "t" });
  const state = await todo.replace({
    sessionId: "s",
    runId: "r",
    userTurnId: "t",
    items: [
      { id: "one", content: "One", status: "in_progress" },
      { id: "two", content: "Two", status: "in_progress" },
    ],
  });
  assert.equal(state.items.filter(item => item.status === "in_progress").length, 2);
  await todo.close();
});

test("explicit child links advance Todo on spawn, completion and failure without todo_write", async () => {
  const todo = new TodoRuntime();
  const owner = { sessionId: "s", runId: "r", userTurnId: "t" };
  await todo.openTurn(owner);
  await todo.replace({ ...owner, items: [
    { id: "inspect", content: "Inspect repository", status: "in_progress" },
    { id: "core", content: "Review core", status: "pending" },
    { id: "docs", content: "Review docs", status: "pending" },
  ] });
  let listener;
  const records = new Map();
  const subagents = {
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    async inspect({ id }) { return records.get(id); },
  };
  const progress = new TodoSubagentProgress(todo, subagents);
  const base = { parentAgentId: "wish", parentSessionId: "s", parentRunId: "r", workspaceRoot: "/workspace" };
  const child = (id, status = "running", result) => ({ ...base, id, status, ...(result ? { result } : {}) });
  const send = record => { records.set(record.id, record); listener?.({ type: "subagent.updated", record }); };
  await progress.validate({ ...owner, itemId: "core" });
  await assert.rejects(progress.validate({ ...owner, itemId: "unknown" }), /not in the current UserTurn/u);
  records.set("child-core", child("child-core"));
  await progress.bind({ ...owner, itemId: "core" }, child("child-core"));
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "in_progress", "pending"]);
  records.set("child-docs", child("child-docs"));
  await progress.bind({ ...owner, itemId: "docs" }, child("child-docs"));
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "in_progress", "in_progress"]);
  send(child("child-core", "exited", { status: "completed" }));
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "completed", "in_progress"]);
  send(child("child-docs", "failed", { status: "failed" }));
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "completed", "failed"]);
  await todo.replace({ ...owner, items: [
    { id: "inspect", content: "Inspect repository", status: "completed" },
    { id: "core", content: "Review core", status: "pending" },
    { id: "docs", content: "Review docs", status: "pending" },
  ] });
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "completed", "failed"], "model replacement cannot erase linked execution truth");
  await todo.openTurn({ sessionId: "s", runId: "r2", userTurnId: "t2" });
  send(child("child-core", "stopped"));
  assert.deepEqual((await todo.get("s")).items, [], "old child events cannot change a new turn");
  progress.close();
  await todo.close();
});

test("one Todo item waits for every linked child and a stopped child settles it", async () => {
  const todo = new TodoRuntime();
  const owner = { sessionId: "s", runId: "r", userTurnId: "t" };
  await todo.openTurn(owner);
  await todo.replace({ ...owner, items: [{ id: "review", content: "Parallel review", status: "pending" }] });
  await todo.bindChild({ ...owner, itemId: "review", childId: "a", status: "running" });
  await todo.bindChild({ ...owner, itemId: "review", childId: "b", status: "running" });
  await todo.updateChild({ ...owner, childId: "a", status: "completed" });
  assert.equal((await todo.get("s")).items[0].status, "in_progress");
  await todo.updateChild({ ...owner, childId: "b", status: "completed" });
  assert.equal((await todo.get("s")).items[0].status, "completed");
  await todo.bindChild({ ...owner, itemId: "review", childId: "c", status: "running" });
  await todo.updateChild({ ...owner, childId: "c", status: "stopped" });
  assert.equal((await todo.get("s")).items[0].status, "stopped");
  await todo.clear("s", "r");
  assert.equal(await todo.get("s"), undefined);
  await todo.close();
});

test("queued Workflow dispatch advances its linked Todo before a child id exists", async () => {
  const todo = new TodoRuntime();
  const owner = { sessionId: "s", runId: "r", userTurnId: "t" };
  await todo.openTurn(owner);
  await todo.replace({ ...owner, items: [
    { id: "inspect", content: "Inspect", status: "in_progress" },
    { id: "queued", content: "Delegated review", status: "pending" },
  ] });
  let workflowStatus = "running";
  const workflow = { async get() { return { status: workflowStatus, owner: { parentSessionId: "s", parentRunId: "r" } }; } };
  const progress = new TodoSubagentProgress(todo, { subscribe() { return () => {}; } }, () => workflow);
  await progress.bindWorkflow({ ...owner, itemId: "queued" }, "workflow-1");
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "in_progress"]);
  workflowStatus = "completed";
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.deepEqual((await todo.get("s")).items.map(item => item.status), ["completed", "completed"]);
  progress.close();
  await todo.close();
});
