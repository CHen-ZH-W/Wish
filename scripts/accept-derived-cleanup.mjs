import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApplicationFacade } from "../dist/apps/application.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { InMemorySessionStore, SessionManager } from "../dist/sessions/index.js";
import { FileSubagentExchange } from "../dist/subagents/files.js";

function fixture({ manualAbort = false, onAbort } = {}) {
  const sessions = new SessionManager(new InMemorySessionStore());
  const features = new SessionFeatureRegistry();
  const completions = new Map();
  const failures = new Map();
  const calls = [];
  let sequence = 0;
  const agent = {
    definition: { id: "wish" },
    startRun({ scope, runId }) {
      const id = runId ?? `run-${++sequence}`;
      let settle;
      let fail;
      const completion = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
      completions.set(id, settle);
      failures.set(id, fail);
      return { agentId: "wish", runId: id, initialUserTurnId: `turn-${id}`, scope, completion };
    },
    control(runId, control) {
      if (control.type !== "abort") throw new Error("Unexpected control");
      onAbort?.(runId);
      if (!manualAbort) completions.get(runId)?.({ status: "aborted", cancellation: {}, snapshot: {} });
      return { accepted: true };
    },
    async *observe() {},
  };
  const model = { provider: "fixture", model: "model" };
  const application = new ApplicationFacade({
    sessions: { manager: sessions }, agent, sessionFeatures: features,
    models: {
      configuredModel: { getDefaultModel: () => model, resolve: () => ({ ref: model }), getModelSpec: () => ({}) },
      sessionReasoning: { forRun: async () => undefined, clear: async id => { calls.push(`reasoning:${id}`); } },
    },
    sessionPermissions: {
      initialize: async () => {}, forRun: async () => "read-only",
      clear: async id => { calls.push(`permissions:${id}`); },
    },
  });
  return { application, sessions, features, completions, failures, calls };
}

function feature(calls, name, purgeOrder, fails = () => false) {
  return {
    purgeOrder,
    inspect: async () => undefined,
    act: async () => {},
    purgeRun: async (_sessionId, runId) => { calls.push(`${name}:run:${runId}`); },
    purgeSession: async sessionId => {
      calls.push(`${name}:session:${sessionId}`);
      if (fails()) throw new Error("cleanup failed");
    },
  };
}

test("completed and aborted Runs release child state before parent state", async () => {
  const { application, features, completions, calls } = fixture();
  features.register("parent", feature(calls, "parent", 70));
  features.register("child", feature(calls, "child", 10));
  await application.createSession({ sessionId: "s", workspaceRoot: "/tmp" });
  const completed = await application.startRun({ sessionId: "s", payload: { text: "finish" } });
  completions.get(completed.runId)({ status: "completed", result: {}, snapshot: {} });
  assert.equal((await completed.completion).status, "completed");
  assert.deepEqual(calls, [`child:run:${completed.runId}`, `parent:run:${completed.runId}`]);
  const stopped = await application.startRun({ sessionId: "s", payload: { text: "stop" } });
  assert.equal(application.controlRun(stopped.runId, { type: "abort", source: "test" }).accepted, true);
  assert.equal((await stopped.completion).status, "aborted");
  assert.deepEqual(calls.slice(2), [`child:run:${stopped.runId}`, `parent:run:${stopped.runId}`]);
});

test("failed cleanup is retried before another Run; rejected Run completion still cleans up", async () => {
  const { application, features, completions, failures, calls } = fixture();
  let failCleanup = true;
  features.register("retryable", {
    inspect: async () => undefined,
    act: async () => {},
    purgeRun: async (_sessionId, runId) => {
      calls.push(`purge:${runId}`);
      if (failCleanup) throw new Error("cleanup failed");
    },
  });
  await application.createSession({ sessionId: "s", workspaceRoot: "/tmp" });
  const first = await application.startRun({ sessionId: "s", payload: { text: "first" } });
  completions.get(first.runId)({ status: "completed", result: {}, snapshot: {} });
  await assert.rejects(first.completion, /cleanup failed/);
  await assert.rejects(application.startRun({ sessionId: "s", payload: { text: "blocked" } }), /cleanup failed/);
  failCleanup = false;
  const second = await application.startRun({ sessionId: "s", payload: { text: "second" } });
  assert.deepEqual(calls, [`purge:${first.runId}`, `purge:${first.runId}`, `purge:${first.runId}`]);
  failures.get(second.runId)(new Error("runtime failed"));
  await assert.rejects(second.completion, /runtime failed/);
  assert.equal(calls.at(-1), `purge:${second.runId}`);
});

test("Session deletion retries failed cleanup and leaves unrelated Session intact", async () => {
  const { application, sessions, features, calls } = fixture();
  let fail = true;
  features.register("parent", feature(calls, "parent", 70));
  features.register("child", feature(calls, "child", 10, () => fail));
  await application.createSession({ sessionId: "s", workspaceRoot: "/tmp" });
  await application.createSession({ sessionId: "other", workspaceRoot: "/tmp" });
  await assert.rejects(application.deleteSession({ sessionId: "s" }), /cleanup failed/);
  assert.ok(await sessions.get({ sessionId: "s" }));
  fail = false;
  await application.deleteSession({ sessionId: "s" });
  assert.equal(await sessions.wasDeleted({ sessionId: "s" }), true);
  assert.ok(await sessions.get({ sessionId: "other" }));
  assert.deepEqual(calls.slice(-4), ["child:session:s", "parent:session:s", "reasoning:s", "permissions:s"]);
});

test("Session deletion waits for an active Run before releasing owned resources", async () => {
  let observedAbort;
  const abortRequested = new Promise(resolve => { observedAbort = resolve; });
  const { application, sessions, features, completions, calls } = fixture({
    manualAbort: true, onAbort: runId => observedAbort(runId),
  });
  features.register("child", feature(calls, "child", 10));
  await application.createSession({ sessionId: "s", workspaceRoot: "/tmp" });
  const run = await application.startRun({ sessionId: "s", payload: { text: "work" } });
  const removal = application.deleteSession({ sessionId: "s" });
  assert.equal(await abortRequested, run.runId);
  assert.ok(await sessions.get({ sessionId: "s" }));
  assert.deepEqual(calls, [], "cleanup must wait for the original Run completion");
  completions.get(run.runId)({ status: "aborted", cancellation: {}, snapshot: {} });
  await removal;
  assert.deepEqual(calls, [`child:run:${run.runId}`, "child:session:s", "reasoning:s", "permissions:s"]);
  assert.equal(await sessions.wasDeleted({ sessionId: "s" }), true);
});

test("Subagent exchange cleanup removes only the selected child's files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-child-cleanup-"));
  try {
    const exchange = new FileSubagentExchange(directory);
    const task = await exchange.createTask("child", "Inspect source");
    const other = await exchange.createTask("other", "Keep this");
    await mkdir(exchange.childDataDirectory("child"), { recursive: true });
    await writeFile(join(exchange.childDataDirectory("child"), "models.json"), "{}", "utf8");
    await mkdir(join(exchange.rootDirectory, "results"), { recursive: true });
    await writeFile(exchange.resultPath("child"), "{}", "utf8");
    await exchange.purgeChild("child");
    await exchange.purgeChild("child");
    for (const path of [task, exchange.resultPath("child"), join(exchange.childDataDirectory("child"), "models.json")]) {
      await assert.rejects(readFile(path), { code: "ENOENT" });
    }
    assert.equal(await readFile(other, "utf8"), "Keep this");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
