import assert from "node:assert/strict";
import test from "node:test";

import { Runtime } from "../dist/core/runtime/runtime.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { TodoContextProvider, TodoRuntime } from "../dist/todo/index.js";
import { createTodoWriteTool } from "../dist/todo/consumers/model-tool.js";
import { createTodoSessionFeature } from "../dist/todo/consumers/session-feature.js";

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

test("Todo validation bounds the list and allows only one in-progress item", async () => {
  const todo = new TodoRuntime();
  await todo.openTurn({ sessionId: "s", runId: "r", userTurnId: "t" });
  await assert.rejects(todo.replace({
    sessionId: "s",
    runId: "r",
    userTurnId: "t",
    items: [
      { id: "one", content: "One", status: "in_progress" },
      { id: "two", content: "Two", status: "in_progress" },
    ],
  }), /Only one Todo/u);
  await todo.close();
});
