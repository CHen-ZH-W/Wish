import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";

import { ApplicationFacade } from "../dist/apps/application.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { startWishWebUiServer, WebToolApprovalBroker } from "../dist/apps/webui/index.js";
import { SessionClientModel } from "../dist/apps/webui/client/model/session.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { createFileSessionResources } from "../dist/sessions/index.js";
import { TitleController } from "../dist/session-title/controller.js";
import { DomainTitleJobStore, MemoryTitleJobStore } from "../dist/session-title/store.js";
import { createSessionTitleFeature } from "../dist/session-title/consumers/session-feature.js";
import StorageSessionTitles from "../dist/session-title/providers/storage.js";
import { TitleGenerationError } from "../dist/session-title/types.js";
import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const model = Object.freeze({ provider: "fixture", model: "primary" });

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function eventually(read, predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(5);
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

/** Real facade, file Sessions and HTTP transport; only Runtime execution and
 * the independent title Provider are deterministic fixtures. */
async function fixture(generator, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "wish-session-title-http-"));
  const ownsDirectory = options.directory === undefined;
  const sessions = createFileSessionResources(directory);
  const store = options.store ?? new MemoryTitleJobStore();
  const events = [], featureErrors = [], inputs = [], controls = [];
  let foregroundRuns = 0;
  const titles = new TitleController({
    sessions: sessions.manager,
    store,
    generator,
    config: { timeoutMs: 5_000, maxAttempts: 1, retryBaseMs: 5, retryMaxMs: 10 },
    canDispatch: () => foregroundRuns === 0,
    onEvent: event => events.push(event),
  });
  const features = new SessionFeatureRegistry();
  features.register("session-title", createSessionTitleFeature(options.featureController ?? titles, error => featureErrors.push(error)));
  const application = new ApplicationFacade({
    sessions,
    sessionFeatures: features,
    models: { configuredModel: { getDefaultModel: () => model, resolve: ref => ({ ref }) } },
    agent: {
      definition: { id: "wish" },
      startRun(input) {
        inputs.push(input);
        const runId = input.runId ?? `title-http-run-${inputs.length}`;
        foregroundRuns++;
        const execution = options.completion ?? Promise.resolve({ status: "completed" });
        const completion = execution.then(value => {
          foregroundRuns--; return { ...value, runId };
        }, error => { foregroundRuns--; throw error; });
        return {
          agentId: "wish", runId, initialUserTurnId: `${runId}-turn`, scope: input.scope,
          completion,
        };
      },
      control(runId, control) { controls.push({ runId, control }); return { runId, accepted: true, kind: control.type, controlId: "fixture-control" }; },
      async *observe(runId) { if (options.observe) yield* options.observe(runId); },
    },
  });
  let server;
  try {
    server = await startWishWebUiServer({
      application, approvals: new WebToolApprovalBroker(), workspaceRoot: directory,
      host: "127.0.0.1", port: 0,
    });
  } catch (error) {
    await titles.close();
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3_000),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
    return { status: response.status, ...value };
  };
  return {
    directory, sessions, store, titles, events, featureErrors, inputs, controls, application, api, url: server.url,
    async create(sessionId, title) { return (await api("/api/sessions", { sessionId, ...(title === undefined ? {} : { title }) })).session; },
    async read(sessionId) { return (await api(`/api/sessions/${sessionId}`)).session; },
    async start(sessionId, text) { return api(`/api/sessions/${sessionId}/runs`, { text }); },
    async close() {
      await titles.close();
      await server.close();
      if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}

function standaloneFacade(sessions, sessionFeatures, completion) {
  let runCount = 0;
  return new ApplicationFacade({
    sessions, sessionFeatures,
    models: { configuredModel: { getDefaultModel: () => model, resolve: ref => ({ ref }) } },
    agent: {
      definition: { id: "wish" },
      startRun(input) {
        const runId = `isolated-title-run-${++runCount}`;
        return { agentId: "wish", runId, initialUserTurnId: `${runId}-turn`, scope: input.scope,
          completion: completion ?? Promise.resolve({ runId, status: "completed" }) };
      },
      control(runId, control) { return { runId, accepted: true, kind: control.type, controlId: "fixture-control" }; },
      async *observe() {},
    },
  });
}

test("HTTP admission and main events proceed while durable title work waits for the foreground Run", { timeout: 15_000 }, async () => {
  const gate = deferred(), completion = deferred(), calls = [];
  const fx = await fixture({ async generate(input) { calls.push(input); return gate.promise; } }, {
    completion: completion.promise,
    async *observe(runId) {
      yield { schemaVersion: 1, eventId: "main-text", sequence: 1, type: "model.stream", occurredAt: new Date().toISOString(),
        runId, userTurnId: `${runId}-turn`, stepId: `${runId}-step`, payload: { type: "text_delta", text: "Main response before title generation" } };
    },
  });
  let client;
  try {
    const created = await fx.create("first-input");
    const accepted = await fx.start("first-input", "修复会话标题同步");
    assert.equal(accepted.status, 202, "A pending title request must not hold Run admission open");
    const fallback = await fx.read("first-input");
    assert.equal(fallback.title, "修复会话标题同步");
    assert.equal(fallback.titleSource, "fallback");
    assert.equal(fallback.historyRevision, created.historyRevision, "Titles do not revise the model transcript");
    const pending = await fx.store.get("first-input");
    assert.equal(pending.state, "pending");
    assert.equal(pending.attempts, 0, "Foreground execution cannot spend a title attempt");
    const active = (await fx.api("/api/sessions/first-input/runs")).runs;
    assert.ok(active.some(run => run.runId === accepted.run.runId && run.status === "running"));
    const stream = await fetch(`${fx.url}/api/runs/${accepted.run.runId}/events`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /Main response before title generation/u, "Main Run SSE output does not await the title Provider");
    assert.equal(calls.length, 0, "A pending foreground Run keeps the title Provider idle");

    completion.resolve({ status: "completed" });
    await eventually(async () => calls.length, count => count === 1, "Foreground completion releases the independent title request");
    assert.deepEqual(calls[0].model, model);
    assert.equal(calls[0].signal.aborted, false, "A completed HTTP request cannot cancel background title generation");

    await eventually(async () => (await fx.api("/api/sessions/first-input/runs")).runs,
      runs => runs.some(run => run.runId === accepted.run.runId && run.status === "completed"), "The main Run finishes before the title result");
    const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "title-http-instance" });
    connection.request = (path, body, method) => fx.api(path, body, method);
    connection.onInvalidation = () => () => {};
    connection.stream = () => assert.fail("The client cannot rely on a main Run event after that Run has already completed");
    client = new SessionClientModel(connection);
    await client.refresh();
    assert.equal(client.getSnapshot().sessions[0].title, fallback.title);

    gate.resolve({ title: "会话标题同步修复" });
    await fx.titles.waitForIdle();
    const listed = (await fx.api("/api/sessions")).sessions.find(session => session.sessionId === "first-input");
    assert.equal(listed.title, "会话标题同步修复", "A fresh sidebar list reads the independently committed title");
    assert.equal(listed.titleSource, "model");
    assert.ok(listed.titleRevision > fallback.titleRevision);
    assert.equal(listed.historyRevision, created.historyRevision);
    await eventually(async () => client.getSnapshot().sessions[0]?.title,
      title => title === "会话标题同步修复", "The existing client poll must update the sidebar without Run events or a manual refresh", 6_000);
    assert.equal(client.getSnapshot().error, null);
    await fx.start("first-input", "接着调整其他细节");
    await fx.titles.waitForIdle();
    assert.equal(calls.length, 1, "Later Runs cannot regenerate the first-input title");
    assert.deepEqual(fx.controls, []);
  } finally { client?.close(); completion.resolve({ status: "completed" }); gate.resolve({ title: "会话标题同步修复" }); await fx.close(); }
});

test("Manual rename and clear cancel title work before a foreground Run releases dispatch", { timeout: 15_000 }, async () => {
  const completion = deferred(); let calls = 0;
  const fx = await fixture({ async generate() { calls++; return { title: "不应生成的标题" }; } }, { completion: completion.promise });
  try {
    for (const [sessionId, title] of [["manual-before-dispatch", "用户自己的标题"], ["clear-before-dispatch", null]]) {
      await fx.create(sessionId);
      const accepted = await fx.start(sessionId, "前台运行期间先处理用户的手动标题");
      assert.equal(accepted.status, 202);
      assert.equal((await fx.store.get(sessionId)).attempts, 0);
      const renamed = (await fx.api(`/api/sessions/${sessionId}`, { title }, "PATCH")).session;
      assert.equal(renamed.titleSource, "manual");
      assert.equal(renamed.title, title ?? undefined);
      assert.equal((await fx.store.get(sessionId)).state, "cancelled");
    }
    assert.equal(calls, 0);
    completion.resolve({ status: "completed" });
    for (const sessionId of ["manual-before-dispatch", "clear-before-dispatch"]) {
      await eventually(async () => (await fx.api(`/api/sessions/${sessionId}/runs`)).runs,
        runs => runs.every(run => run.status === "completed"), "Foreground completion remains independent of a cancelled title");
    }
    await fx.titles.waitForIdle();
    assert.equal(calls, 0, "Opening the foreground gate cannot revive a cancelled title job");
    assert.equal((await fx.read("manual-before-dispatch")).title, "用户自己的标题");
    assert.equal((await fx.read("clear-before-dispatch")).title, undefined);
  } finally { completion.resolve({ status: "completed" }); await fx.close(); }
});

test("A rejected foreground completion releases durable title work without affecting Run failure reporting", { timeout: 15_000 }, async () => {
  const completion = deferred(); let calls = 0;
  const fx = await fixture({ async generate() { calls++; return { title: "失败运行的可读标题" }; } }, { completion: completion.promise });
  try {
    await fx.create("rejected-main");
    const accepted = await fx.start("rejected-main", "定位前台运行失败的问题");
    assert.equal(accepted.status, 202);
    assert.equal(calls, 0);
    assert.equal((await fx.store.get("rejected-main")).attempts, 0);
    completion.reject(new Error("Fixture foreground execution failed"));
    await eventually(async () => (await fx.api("/api/sessions/rejected-main/runs")).runs,
      runs => runs.some(run => run.runId === accepted.run.runId && run.status === "failed"), "A rejected completion remains a failed main Run");
    await fx.titles.waitForIdle();
    assert.equal(calls, 1);
    assert.equal((await fx.read("rejected-main")).title, "失败运行的可读标题");
    assert.deepEqual(fx.controls, []);
  } finally { completion.resolve({ status: "completed" }); await fx.close(); }
});

test("Closing titles while foreground work is active cannot dispatch after that work finishes", { timeout: 15_000 }, async () => {
  const completion = deferred(); let calls = 0;
  const fx = await fixture({ async generate() { calls++; return { title: "关闭后不应生成" }; } }, { completion: completion.promise });
  try {
    await fx.create("close-before-dispatch");
    const accepted = await fx.start("close-before-dispatch", "关闭标题服务时前台仍在运行");
    assert.equal(calls, 0);
    await fx.titles.close();
    completion.resolve({ status: "completed" });
    await eventually(async () => (await fx.api("/api/sessions/close-before-dispatch/runs")).runs,
      runs => runs.some(run => run.runId === accepted.run.runId && run.status === "completed"), "Closing auxiliary work cannot hold the main Run completion");
    await delay(350);
    assert.equal(calls, 0);
    assert.equal((await fx.store.get("close-before-dispatch")).attempts, 0);
    assert.equal((await fx.read("close-before-dispatch")).titleSource, "fallback");
  } finally { completion.resolve({ status: "completed" }); await fx.close(); }
});

test("HTTP rename and clear remain manual even when an old title result arrives", { timeout: 15_000 }, async () => {
  const gate = deferred(); let calls = 0, request;
  const fx = await fixture({ async generate(input) { calls++; request = input; return gate.promise; } });
  try {
    await fx.create("manual-wins");
    await fx.start("manual-wins", "修复自动标题中的并发问题");
    await eventually(async () => calls, count => count === 1, "The title request must be pending before the manual rename");
    const renamed = (await fx.api("/api/sessions/manual-wins", { title: "  我的手动标题  " }, "PATCH")).session;
    assert.equal(renamed.title, "我的手动标题");
    assert.equal(renamed.titleSource, "manual");
    assert.equal(request.signal.aborted, true, "The production PATCH hook promptly cancels unnecessary title work");
    gate.resolve({ title: "已经过期的模型标题" });
    await fx.titles.waitForIdle();
    assert.equal((await fx.read("manual-wins")).title, "我的手动标题");
    const cleared = (await fx.api("/api/sessions/manual-wins", { title: null }, "PATCH")).session;
    assert.equal(cleared.title, undefined);
    assert.equal(cleared.titleSource, "manual");
    await fx.start("manual-wins", "用户清空标题后继续对话");
    await fx.titles.waitForIdle();
    const retained = await fx.read("manual-wins");
    assert.equal(retained.title, undefined);
    assert.equal(retained.titleSource, "manual");
    assert.equal(retained.titleRevision, cleared.titleRevision);
    assert.equal(calls, 1);
  } finally { gate.resolve({ title: "已经过期的模型标题" }); await fx.close(); }
});

test("A title Provider failure retains the fallback while the HTTP Run completes", { timeout: 15_000 }, async () => {
  const fx = await fixture({ async generate() { throw new TitleGenerationError("authentication_failed", false); } });
  try {
    await fx.create("provider-failure");
    const accepted = await fx.start("provider-failure", "定位标题请求失败");
    assert.equal(accepted.status, 202);
    await fx.titles.waitForIdle();
    const runs = await eventually(async () => (await fx.api("/api/sessions/provider-failure/runs")).runs,
      value => value.some(run => run.runId === accepted.run.runId && run.status === "completed"), "The main Run must finish independently");
    assert.equal(runs[0].cleanupError, undefined);
    assert.equal((await fx.read("provider-failure")).titleSource, "fallback");
    assert.equal((await fx.read("provider-failure")).title, "定位标题请求失败");
    assert.equal((await fx.store.get("provider-failure")).state, "failed");
    assert.deepEqual(fx.controls, [], "Title failure cannot abort the successful main Run");
  } finally { await fx.close(); }
});

test("Title admission errors are isolated from Application Run-start observers", { timeout: 15_000 }, async () => {
  const expected = new Error("fixture title storage is unavailable");
  const fx = await fixture({ async generate() { assert.fail("Unavailable title admission cannot dispatch a Provider request"); } }, {
    featureController: { async accept() { throw expected; }, async cancel() { throw expected; }, async purge() {} },
  });
  try {
    await fx.create("admission-failure");
    const accepted = await fx.start("admission-failure", "正常运行仍应被接受");
    assert.equal(accepted.status, 202);
    assert.equal(fx.inputs.length, 1);
    assert.deepEqual(fx.controls, []);
    assert.equal(fx.featureErrors.length, 1);
    assert.equal(fx.featureErrors[0].sessionId, "admission-failure");
    assert.equal(fx.featureErrors[0].operation, "accept");
    assert.equal(typeof fx.featureErrors[0].errorCode, "string");
    const renamed = (await fx.api("/api/sessions/admission-failure", { title: "手动改名仍然成功" }, "PATCH")).session;
    assert.equal(renamed.title, "手动改名仍然成功", "An unavailable title cleanup cannot reject an already committed manual rename");
    assert.equal(fx.featureErrors[1].operation, "cancel");
    assert.equal(JSON.stringify(fx.featureErrors).includes(expected.message), false, "Diagnostics exclude storage messages and user content");
  } finally { await fx.close(); }
});

test("Trusted continuation and unknown sources cannot name a Session before a real HTTP user input", { timeout: 15_000 }, async () => {
  const calls = [];
  const fx = await fixture({ async generate(input) { calls.push(input); return { title: "真实用户请求" }; } });
  try {
    await fx.create("source-filter");
    for (const inputSource of ["continuation", "unknown", "follow_up"]) {
      const handle = await fx.application.startRun({ sessionId: "source-filter", inputSource, payload: { text: `Internal ${inputSource} text` } });
      await handle.completion;
    }
    assert.equal((await fx.read("source-filter")).title, undefined);
    assert.equal(await fx.store.get("source-filter"), undefined);
    assert.equal(calls.length, 0);
    await fx.start("source-filter", "这是第一条真实用户请求");
    await fx.titles.waitForIdle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "这是第一条真实用户请求");
    assert.equal((await fx.read("source-filter")).title, "真实用户请求");

    await fx.create("manual-initial", "现有手动会话标题");
    await fx.start("manual-initial", "为现有标题继续对话");
    await fx.titles.waitForIdle();
    assert.equal((await fx.read("manual-initial")).title, "现有手动会话标题");
    assert.equal(calls.length, 1);
  } finally { await fx.close(); }
});

test("Replacing title owners and reopening file Sessions retain completed metadata without another model call", { timeout: 15_000 }, async () => {
  // Reusing a memory job store models a provider-owner replacement. Session
  // bytes are reopened from disk; durable job recovery has its own acceptance.
  const directory = await mkdtemp(join(tmpdir(), "wish-session-title-reopen-"));
  const store = new MemoryTitleJobStore();
  let first, second, calls = 0;
  try {
    first = await fixture({ async generate() { calls++; return { title: "完成后的标题" }; } }, { directory, store });
    await first.create("reopened");
    await first.start("reopened", "生成并保存首个标题");
    await first.titles.waitForIdle();
    const original = await first.read("reopened");
    await first.close(); first = undefined;

    second = await fixture({ async generate() { calls++; assert.fail("Completed title jobs cannot replay on owner replacement"); } }, { directory, store });
    await second.titles.resume();
    await second.start("reopened", "标题服务恢复后继续对话");
    await second.titles.waitForIdle();
    const reopened = await second.read("reopened");
    assert.equal(reopened.title, original.title);
    assert.equal(reopened.titleSource, "model");
    assert.equal(reopened.titleRevision, original.titleRevision);
    assert.equal(calls, 1);
  } finally { await first?.close(); await second?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("The Cordis storage Provider waits for its activation receipt and current foreground idleness before dispatching recovered work", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-title-activation-"));
  const root = new Context(), starts = [], calls = [];
  let foregroundRuns = 1;
  try {
    const sessions = createFileSessionResources(join(directory, "data"));
    const session = await sessions.manager.create({ sessionId: "activation-owner", agentId: "wish", scope: directory, title: "待恢复的会话标题", titleSource: "fallback" });
    await root.plugin(StorageHub);
    root.storage.register(new FileStorageBackend({ id: "file", rootDirectory: join(directory, "storage") }));
    root.provide("storageBackend", {
      id: "file",
      acquire: (...args) => root.storage.acquire(...args),
      backend: (...args) => root.storage.backend(...args),
      resolve: (...args) => root.storage.resolve(...args),
    });
    root.provide("sessions", { ...sessions, dataDirectory: join(directory, "data") });
    root.provide("runEngine", { lifecycleSnapshot: () => ({ generations: 1, activeRuns: foregroundRuns, retiring: 0 }) });
    root.provide("sessionTitleGenerator", { async generate(input) { calls.push(input); return { title: "回执后恢复完成" }; } });
    // Keep the real Provider and Cordis Service.init path. This host seam only
    // holds the ready callbacks until a configuration/code receipt is durable.
    root.provide("codeReload", { startWhenReady(_owner, start) { starts.push(start); } });
    const store = new DomainTitleJobStore({ storage: root.storage, backendId: "file" });
    await store.put({
      schemaVersion: 1, sessionId: session.sessionId, jobId: "activation-job", version: 1, state: "pending",
      seed: "恢复已保存的首条用户请求", expectedTitleRevision: session.titleRevision, attempts: 0,
      nextAttemptAt: 0, createdAt: 0, updatedAt: 0,
    });
    await root.plugin(StorageSessionTitles, { backendId: "file", retryBaseMs: 5 });
    await delay(20);
    assert.ok(root.get("sessionTitle"), "Provider activation finishes without waiting for the receipt callback");
    assert.equal(calls.length, 0, "Recovery must not spend a model attempt in an uncommitted generation");
    const beforeReceipt = await store.get(session.sessionId);
    assert.equal(beforeReceipt.attempts, 0);
    assert.equal(beforeReceipt.state, "pending");
    assert.ok(starts.length >= 2, "The ordinary work gate and background dispatcher each wait for the host receipt");

    for (const start of starts) start();
    await delay(50);
    assert.equal(calls.length, 0, "A successor consults the live foreground Runtime after its receipt instead of losing the dispatch gate");
    assert.equal((await store.get(session.sessionId)).attempts, 0);
    foregroundRuns = 0;
    await eventually(() => store.get(session.sessionId), job => job?.state === "succeeded", "The receipt opens title dispatch without requiring another user message");
    assert.equal(calls.length, 1);
    assert.equal((await sessions.manager.get({ sessionId: session.sessionId })).title, "回执后恢复完成");
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("Unloading the optional title feature permits Run cleanup and Session deletion while durable owners keep their guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-title-unload-"));
  const completion = deferred(), hooks = [];
  try {
    const sessions = createFileSessionResources(directory), registry = new SessionFeatureRegistry();
    const unregister = registry.register("session-title", createSessionTitleFeature({
      async accept() { hooks.push("accept"); }, async cancel() { hooks.push("cancel"); }, async purge() { hooks.push("purge"); },
    }));
    const application = standaloneFacade(sessions, registry, completion.promise);
    await application.createSession({ sessionId: "optional-owner", workspaceRoot: directory });
    const handle = await application.startRun({ sessionId: "optional-owner", inputSource: "user", payload: { text: "主Run仍在进行" } });
    assert.deepEqual(hooks, ["accept"]);
    unregister();
    completion.resolve({ runId: handle.runId, status: "completed" });
    await handle.completion;
    await registry.purgeRun("optional-owner", handle.runId);
    await registry.beforeRemoval("optional-owner", "delete");
    await registry.purgeSession("optional-owner");
    await application.deleteSession({ sessionId: "optional-owner" });
    assert.deepEqual(hooks, ["accept"], "Unregistered observers cannot be called through retained cleanup ownership");
    await assert.rejects(application.getSession({ sessionId: "optional-owner" }), { code: "session_not_found" });

    const required = new SessionFeatureRegistry();
    const removeOwner = required.register("durable-owner", {
      async inspect() {}, async act() {}, async beforeRemoval() {}, async purgeRun() {}, async purgeSession() {},
    });
    removeOwner();
    await assert.rejects(required.beforeRemoval("s", "delete"), { code: "session_busy" });
    await assert.rejects(required.purgeRun("s", "r"), /Cleanup owner durable-owner is unavailable/u);
    await assert.rejects(required.purgeSession("s"), /Cleanup owner durable-owner is unavailable/u);
  } finally { completion.resolve({ status: "completed" }); await rm(directory, { recursive: true, force: true }); }
});

test("A shared Session Feature registry isolates equal Session ids across file-storage graphs", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-title-graphs-"));
  const gate = deferred(), hooks = [], calls = [];
  let titles;
  try {
    const sessionsA = createFileSessionResources(join(directory, "a"));
    const sessionsB = createFileSessionResources(join(directory, "b"));
    const store = new MemoryTitleJobStore(), registry = new SessionFeatureRegistry();
    titles = new TitleController({
      sessions: sessionsA.manager, store,
      generator: { async generate(input) { calls.push(input); return gate.promise; } },
      config: { timeoutMs: 5_000, maxAttempts: 1 },
    });
    registry.register("session-title", createSessionTitleFeature({
      accept(input) { hooks.push("accept"); return titles.accept(input); },
      cancel(sessionId) { hooks.push("cancel"); return titles.cancel(sessionId); },
      purge(sessionId) { hooks.push("purge"); return titles.purge(sessionId); },
    }, undefined, sessionsA.manager));
    const applicationA = standaloneFacade(sessionsA, registry.forGraph(sessionsA.manager));
    const applicationB = standaloneFacade(sessionsB, registry.forGraph(sessionsB.manager));
    for (const application of [applicationA, applicationB]) {
      await application.createSession({ sessionId: "same-id", workspaceRoot: directory });
    }

    const foreign = await applicationB.startRun({ sessionId: "same-id", inputSource: "user", payload: { text: "另一个数据根的用户输入" } });
    await foreign.completion;
    assert.deepEqual(hooks, []);
    assert.equal(await store.get("same-id"), undefined);
    assert.equal((await applicationA.getSession({ sessionId: "same-id" })).title, undefined);

    const own = await applicationA.startRun({ sessionId: "same-id", inputSource: "user", payload: { text: "主图的首条用户输入" } });
    await own.completion;
    await eventually(async () => calls.length, count => count === 1, "The matching graph must dispatch its title request");
    assert.equal(calls[0].text, "主图的首条用户输入");
    await applicationB.updateSessionMetadata({ sessionId: "same-id", title: "另一个根的手动标题" });
    await applicationB.deleteSession({ sessionId: "same-id" });
    assert.deepEqual(hooks, ["accept"], "Foreign metadata and deletion cannot cancel or purge the default graph's title work");
    assert.equal(calls[0].signal.aborted, false);
    assert.equal((await applicationA.getSession({ sessionId: "same-id" })).title, "主图的首条用户输入");
    assert.equal((await store.get("same-id")).state, "running");

    gate.resolve({ title: "主图的正确标题" });
    await titles.waitForIdle();
    assert.equal((await applicationA.getSession({ sessionId: "same-id" })).title, "主图的正确标题");
    await applicationA.updateSessionMetadata({ sessionId: "same-id", title: "主图的手动标题" });
    assert.equal(hooks.at(-1), "cancel");
    await applicationA.deleteSession({ sessionId: "same-id" });
    assert.equal(hooks.at(-1), "purge");
    assert.equal(await store.get("same-id"), undefined);
  } finally { gate.resolve({ title: "主图的正确标题" }); await titles?.close(); await rm(directory, { recursive: true, force: true }); }
});
