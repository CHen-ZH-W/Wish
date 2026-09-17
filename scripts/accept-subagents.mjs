import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DomainSubagentRecordStore,
  MemorySubagentRecordStore,
  snapshotRecord,
  SubagentRuntime,
} from "../dist/subagents/index.js";
import { TmuxSubagentExecutionBackend } from
  "../dist/subagents/providers/tmux-execution.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

function address(id) {
  return Object.freeze({
    sessionId: id,
    session: `wish-${id}`,
    window: "worker",
    pane: "%1",
    target: `wish-${id}:worker.0`,
    socketPath: "/tmp/wish-subagents.sock",
    attachCommand: `tmux -S /tmp/wish-subagents.sock attach-session -t wish-${id}`,
    captureCommand: `tmux -S /tmp/wish-subagents.sock capture-pane -p -t wish-${id}:worker.0`,
  });
}

class FakeTmux {
  sessions = new Map();
  sent = [];
  stopped = [];

  async start(request) {
    const snapshot = Object.freeze({
      target: address(request.sessionId),
      metadata: request.metadata,
      createdAt: "2026-09-12T12:00:00.000Z",
      active: true,
      currentCommand: request.command.executable,
      panePid: 123,
    });
    this.sessions.set(request.sessionId, snapshot);
    return snapshot;
  }

  async list() { return [...this.sessions.values()]; }
  async inspect(target) { return this.sessions.get(target.sessionId); }
  async capture(request) { return `output:${request.target.sessionId}`; }
  async send(request) { this.sent.push(request); }
  async stop(request) {
    this.stopped.push(request.target.sessionId);
    this.sessions.delete(request.target.sessionId);
  }
}

function fixture(options = {}) {
  const tmux = options.tmux ?? new FakeTmux();
  const store = options.store ?? new MemorySubagentRecordStore();
  const launches = [];
  const backend = new SubagentRuntime({
    execution: new TmuxSubagentExecutionBackend(tmux),
    store,
    launcher: {
      resolve(request, identity) {
        launches.push({ request, identity });
        return {
          windowName: request.role,
          command: {
            executable: "/opt/wish-child",
            args: [identity.childSessionId],
            cwd: request.workspaceRoot,
          },
        };
      },
    },
    id: options.id ?? (() => "child-1"),
    now: () => new Date("2026-09-12T12:00:00.000Z"),
    maxConcurrent: options.maxConcurrent,
    maxConcurrentPerRun: options.maxConcurrentPerRun,
    monitorIntervalMs: options.monitorIntervalMs,
  });
  return { backend, tmux, store, launches };
}

const spawnRequest = Object.freeze({
  parentAgentId: "wish",
  parentSessionId: "parent-session",
  parentRunId: "parent-run",
  workspaceRoot: "/workspace",
  task: "Inspect the failing test",
  role: "reviewer",
});

test("Host dispatch keys are idempotent before concurrency checks", async () => {
  const { backend, launches } = fixture({ maxConcurrent: 1 });
  const request = { ...spawnRequest, idempotencyKey: "workflow/attempt-1" };
  const child = await backend.spawn(request);
  assert.equal((await backend.spawn(request)).id, child.id);
  assert.equal(launches.length, 1);
  await assert.rejects(backend.spawn({ ...request, task: "different" }), /idempotency conflict/);
  await backend.close();
});

function access(id, owner = spawnRequest) {
  return {
    id,
    parentAgentId: owner.parentAgentId,
    parentSessionId: owner.parentSessionId,
    parentRunId: owner.parentRunId,
    workspaceRoot: owner.workspaceRoot,
  };
}

test("Subagent spawn fixes semantic ownership and returns a transparent tmux target", async () => {
  const { backend, launches } = fixture();
  const record = await backend.spawn(spawnRequest);

  assert.equal(record.id, "child-1");
  assert.equal(record.childSessionId, "subagent-child-1");
  assert.equal(record.childRunId, "subagent-run-child-1");
  assert.equal(record.parentRunId, "parent-run");
  assert.equal(record.status, "running");
  assert.match(record.target.attachCommand, /attach-session/u);
  assert.equal(launches[0].request.task, spawnRequest.task);
  assert.equal(launches[0].identity.id, "child-1");
  await backend.close();
});

test("Subagent capture, send, collect, and stop address the same tmux pane", async () => {
  const { backend, tmux } = fixture();
  const record = await backend.spawn(spawnRequest);
  assert.equal(await backend.capture(access(record.id)), "output:child-1");
  await backend.send({ ...access(record.id), text: "continue" });
  assert.equal(tmux.sent[0].target.target, record.target.target);
  assert.equal(tmux.sent[0].text, "continue");

  const collected = await backend.collect(access(record.id));
  assert.equal(collected.record.status, "running");
  assert.equal(collected.output, "output:child-1");
  const stopped = await backend.stop(access(record.id));
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(tmux.stopped, ["child-1"]);
  await assert.rejects(
    backend.send({ ...access(record.id), text: "late" }),
    (error) => error.code === "subagent_not_running",
  );
  await backend.close();
});

test("Subagent Runtime enforces ownership before every read or control operation", async () => {
  const { backend } = fixture();
  const record = await backend.spawn(spawnRequest);
  const foreign = access(record.id, { ...spawnRequest, parentRunId: "other-run" });
  assert.equal(await backend.inspect(foreign), undefined);
  assert.deepEqual(await backend.list({ ...foreign, id: undefined }), []);
  for (const operation of [
    () => backend.capture(foreign),
    () => backend.send({ ...foreign, text: "continue" }),
    () => backend.collect(foreign),
    () => backend.stop(foreign),
  ]) {
    await assert.rejects(operation(), (error) => error.code === "subagent_not_found");
  }
  await backend.close();
});

test("Subagent Runtime publishes completion from its owned execution monitor", async () => {
  const { backend, tmux } = fixture({ monitorIntervalMs: 1 });
  const events = [];
  const unsubscribe = backend.subscribe((event) => events.push(event));
  const record = await backend.spawn(spawnRequest);
  tmux.sessions.set(record.id, Object.freeze({
    ...tmux.sessions.get(record.id),
    active: false,
    exitCode: 0,
  }));
  const deadline = Date.now() + 1_000;
  while (
    !events.some((event) => event.record.status === "exited") &&
    Date.now() < deadline
  ) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(events.some((event) => event.record.status === "exited"), true);
  unsubscribe();
  await backend.close();
});

test("Subagent discovery reconciles retained exits and missing tmux sessions", async () => {
  const first = fixture();
  const record = await first.backend.spawn(spawnRequest);
  first.tmux.sessions.set(record.id, Object.freeze({
    ...first.tmux.sessions.get(record.id),
    active: false,
    exitCode: 7,
  }));
  const exited = await first.backend.inspect(access(record.id));
  assert.equal(exited.status, "exited");
  assert.equal(exited.exitCode, 7);
  await first.backend.close();

  const second = fixture({ id: () => "child-2" });
  const live = await second.backend.spawn(spawnRequest);
  second.tmux.sessions.delete(live.id);
  const lost = await second.backend.inspect(access(live.id));
  assert.equal(lost.status, "lost");
  await second.backend.close();
});

test("Subagent limits are checked against reconciled live sessions", async () => {
  let sequence = 0;
  const { backend } = fixture({
    id: () => `child-${++sequence}`,
    maxConcurrent: 2,
    maxConcurrentPerRun: 1,
  });
  await backend.spawn(spawnRequest);
  await assert.rejects(
    backend.spawn({ ...spawnRequest, task: "second" }),
    (error) => error.code === "subagent_limit_exceeded",
  );
  await backend.spawn({
    ...spawnRequest,
    parentRunId: "another-run",
    task: "other parent",
  });
  await assert.rejects(
    backend.spawn({
      ...spawnRequest,
      parentRunId: "third-run",
      task: "global overflow",
    }),
    (error) => error.code === "subagent_limit_exceeded",
  );
  await backend.close();
});

test("Subagent Domain records survive provider replacement without owning tmux lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-subagents-store-"));
  const kv = new FileKvStorageBackend({
    backendId: "fixture",
    rootDirectory: directory,
    revision: (() => {
      let revision = 0;
      return () => `revision-${++revision}`;
    })(),
  });
  const storage = {
    backend(id) {
      assert.equal(id, "fixture");
      return { id, capabilities: { writerConcurrency: "single", kv: { list: true } }, kv };
    },
  };
  const tmux = new FakeTmux();
  try {
    const firstStore = new DomainSubagentRecordStore({
      storage,
      backendId: "fixture",
    });
    const first = fixture({ tmux, store: firstStore });
    const spawned = await first.backend.spawn(spawnRequest);
    await first.backend.close();

    const secondStore = new DomainSubagentRecordStore({
      storage,
      backendId: "fixture",
    });
    const second = fixture({ tmux, store: secondStore, id: () => "child-2" });
    const recovered = await second.backend.inspect(access(spawned.id));
    assert.equal(recovered.status, "running");
    assert.equal(recovered.target.target, spawned.target.target);
    assert.equal(tmux.sessions.has(spawned.id), true);
    await second.backend.close();
  } finally {
    await kv.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Subagent refresh attaches a structured child result without parsing terminal text", async () => {
  const tmux = new FakeTmux();
  const store = new MemorySubagentRecordStore();
  const result = {
    schemaVersion: 1,
    id: "child-1",
    childSessionId: "subagent-child-1",
    childRunId: "subagent-run-child-1",
    status: "completed",
    text: "structured result",
    completedAt: "2026-09-12T12:00:01.000Z",
  };
  const backend = new SubagentRuntime({
    execution: new TmuxSubagentExecutionBackend(tmux),
    store,
    launcher: {
      resolve() {
        return { command: { executable: "/opt/wish-child", cwd: "/workspace" } };
      },
    },
    results: { async read() { return result; } },
    id: () => "child-1",
    now: () => new Date("2026-09-12T12:00:02.000Z"),
  });
  const spawned = await backend.spawn(spawnRequest);
  const inspected = await backend.inspect(access(spawned.id));
  assert.deepEqual(inspected.result, result);
  await backend.close();
});

test("Subagent records and launches reject invalid child authority", async () => {
  assert.throws(
    () => snapshotRecord({
      schemaVersion: 1,
      id: "child-1",
      parentAgentId: "wish",
      parentSessionId: "parent-session",
      parentRunId: "parent-run",
      childSessionId: "child-session",
      childRunId: "child-run",
      workspaceRoot: "/workspace",
      role: "reviewer",
      task: "review",
      permissionProfile: "root",
      status: "running",
      createdAt: "2026-09-12T12:00:00.000Z",
      updatedAt: "2026-09-12T12:00:00.000Z",
    }),
    /permission profile is invalid/u,
  );
  const { backend } = fixture();
  assert.throws(
    () => backend.spawn({
      ...spawnRequest,
      availableTools: ["read", "read"],
    }),
    /must not contain duplicates/u,
  );
  await backend.close();
});
