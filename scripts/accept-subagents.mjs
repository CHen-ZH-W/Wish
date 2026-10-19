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
import { createSubagentSessionFeature } from "../dist/subagents/consumers/session-feature.js";
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
  const cleanedLaunchSecrets = [];
  const purged = [];
  const backend = new SubagentRuntime({
    execution: new TmuxSubagentExecutionBackend(tmux),
    store,
    launcher: {
      ...(options.compose === undefined ? {} : { compose: options.compose }),
      resolve(request, identity) {
        launches.push({ request, identity });
        return {
          ...(options.scopePresetDigest === undefined ? {} : { scopePresetDigest: options.scopePresetDigest }),
          windowName: request.role,
          command: {
            executable: "/opt/wish-child",
            args: [identity.childSessionId],
            cwd: request.workspaceRoot,
          },
        };
      },
      cleanupLaunchSecrets(identity) {
        cleanedLaunchSecrets.push(identity);
      },
      purgeChild(identity) { purged.push(identity); },
    },
    id: options.id ?? (() => "child-1"),
    now: () => new Date("2026-09-12T12:00:00.000Z"),
    maxConcurrent: options.maxConcurrent,
    maxConcurrentPerRun: options.maxConcurrentPerRun,
    monitorIntervalMs: options.monitorIntervalMs,
  });
  return { backend, tmux, store, launches, cleanedLaunchSecrets, purged };
}

const spawnRequest = Object.freeze({
  parentAgentId: "wish",
  parentSessionId: "parent-session",
  parentRunId: "parent-run",
  workspaceRoot: "/workspace",
  task: "Inspect the failing test",
  role: "reviewer",
});

test("Run cleanup stops only owned children and removes their records", async () => {
  let sequence = 0;
  const { backend, store, tmux, purged } = fixture({ id: () => `child-${++sequence}` });
  const first = await backend.spawn(spawnRequest);
  const second = await backend.spawn({ ...spawnRequest, parentRunId: "other-run" });
  await assert.rejects(backend.purge({ ...spawnRequest, id: second.id }), /not found/i);
  await backend.purge({ ...spawnRequest, id: first.id });
  assert.equal(await store.get(first.id), undefined);
  assert.equal((await store.get(second.id)).id, second.id);
  assert.equal(tmux.stopped.includes(first.id), true);
  assert.equal(purged.some(identity => identity.id === first.id), true);
  await backend.purge({ ...spawnRequest, id: first.id });
  await backend.close();
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

test("Host role composition is committed before launch and idempotency comparison", async () => {
  let presetDigest = "a".repeat(64);
  const { backend, launches, store } = fixture({
    compose: request => ({ ...request, availableTools: ["read"], allowedCapabilities: ["filesystem.read"], scopePresetDigest: presetDigest }),
  });
  const request = { ...spawnRequest, idempotencyKey: "scope/reviewer", availableTools: ["read", "write"],
    allowedCapabilities: ["filesystem.read", "filesystem.write"] };
  const record = await backend.spawn(request);
  assert.deepEqual(record.availableTools, ["read"]);
  assert.deepEqual(record.allowedCapabilities, ["filesystem.read"]);
  assert.equal(record.scopePresetDigest, presetDigest);
  assert.deepEqual(launches[0].request.availableTools, ["read"]);
  assert.deepEqual((await store.get(record.id)).availableTools, ["read"]);
  assert.equal((await backend.spawn(request)).id, record.id);
  presetDigest = "b".repeat(64);
  await assert.rejects(backend.spawn(request), /idempotency conflict/u);
  await backend.close();
});

test("the selected Agent Scope preset digest is durable before execution starts", async () => {
  const digest = "a".repeat(64);
  const { backend, store } = fixture({ scopePresetDigest: digest });
  const record = await backend.spawn(spawnRequest);
  assert.equal(record.scopePresetDigest, digest);
  assert.equal((await store.get(record.id)).scopePresetDigest, digest);
  await backend.close();
});

test("a preset change between child admission and launch prevents execution", async () => {
  const { backend, tmux, store } = fixture({
    compose: request => ({ ...request, scopePresetDigest: "a".repeat(64) }),
    scopePresetDigest: "b".repeat(64),
  });
  await assert.rejects(backend.spawn(spawnRequest), /preset changed after child admission/u);
  assert.equal(tmux.sessions.size, 0);
  assert.equal((await store.list())[0].status, "failed");
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
  const { backend, tmux, cleanedLaunchSecrets } = fixture();
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
  assert.deepEqual(cleanedLaunchSecrets, [{
    id: record.id,
    childSessionId: record.childSessionId,
    childRunId: record.childRunId,
  }]);
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

test("late child launch after parent cancellation is stopped and retains its target", async () => {
  const controller = new AbortController();
  const tmux = new FakeTmux();
  const store = new MemorySubagentRecordStore();
  const originalStart = tmux.start.bind(tmux);
  tmux.start = async request => {
    const result = await originalStart(request);
    controller.abort("parent stopped");
    return result;
  };
  const { backend } = fixture({ tmux, store });
  await assert.rejects(backend.spawn({ ...spawnRequest, signal: controller.signal }), /Parent Run was cancelled during child launch/u);
  assert.deepEqual(tmux.stopped, ["child-1"]);
  const record = await store.get("child-1");
  assert.equal(record.status, "failed");
  assert.equal(record.target.id, "child-1");
  await backend.close();
});

test("stopping a parent Run stops its already launched child", async () => {
  const controller = new AbortController();
  const { backend, tmux, store } = fixture();
  const child = await backend.spawn({ ...spawnRequest, signal: controller.signal });
  assert.equal(child.status, "running");
  controller.abort("parent stopped");
  const deadline = Date.now() + 1_000;
  while ((await store.get(child.id))?.status !== "stopped" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal((await store.get(child.id))?.status, "stopped");
  assert.deepEqual(tmux.stopped, [child.id]);
  await backend.close();
});

test("the owned Session feature can stop a child when its parent tool did not return", async () => {
  const { backend, tmux } = fixture();
  const child = await backend.spawn(spawnRequest);
  const feature = createSubagentSessionFeature(backend,
    async () => ({ agentId: "wish", scope: "/workspace" }), "wish");
  const view = await feature.inspect(spawnRequest.parentSessionId);
  assert.equal(view.actions.some(action => action.name === "stop"), true);
  await feature.act(spawnRequest.parentSessionId, "stop", {}, child.id);
  assert.deepEqual(tmux.stopped, [child.id]);
  assert.equal((await backend.inspect({ ...spawnRequest, id: child.id }))?.status, "stopped");
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

test("Subagent Runtime defaults allow eight concurrent children per parent Run", async () => {
  let sequence = 0;
  const { backend } = fixture({ id: () => `child-${++sequence}` });
  for (let index = 0; index < 8; index += 1) {
    await backend.spawn({ ...spawnRequest, task: `task-${index}` });
  }
  await assert.rejects(
    backend.spawn({ ...spawnRequest, task: "ninth" }),
    (error) => error.code === "subagent_limit_exceeded",
  );
  await backend.close();
});

test("Subagent record stores do not reject history beyond the former record ceiling", async () => {
  const source = fixture();
  const base = await source.backend.spawn(spawnRequest);
  const store = new MemorySubagentRecordStore();
  for (let index = 0; index <= 4_096; index += 1) {
    await store.create({
      ...base,
      id: `retained-${index}`,
      childSessionId: `retained-session-${index}`,
      childRunId: `retained-run-${index}`,
    });
  }
  assert.equal((await store.list()).length, 4_097);
  await store.close();
  await source.backend.close();
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
