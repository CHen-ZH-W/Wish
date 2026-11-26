import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySessionStore } from "../dist/sessions/memory-store.js";
import { TitleController } from "../dist/session-title/controller.js";
import { DomainTitleJobStore, MemoryTitleJobStore } from "../dist/session-title/store.js";
import { TitleGenerationError, TitleJobConflictError } from "../dist/session-title/types.js";
import { fallbackTitle, normalizeTitleText } from "../dist/session-title/normalize.js";
import { StorageConflictError } from "../dist/storage/errors.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(generator, config = {}, options = {}) {
  const sessions = new InMemorySessionStore();
  const store = new MemoryTitleJobStore();
  const events = [];
  const controller = new TitleController({ ...options, sessions, store, generator, config: { retryBaseMs: 2, retryMaxMs: 4, ...config }, onEvent: event => events.push(event) });
  const create = async (sessionId, extra = {}) => sessions.create({ sessionId, agentId: "agent-title", scope: sessionId, ...extra });
  return { sessions, store, events, controller, create };
}
async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return;
    await delay(2);
  }
  assert.fail("Condition did not settle");
}

test("title normalization is Unicode safe, bounded and rejects invisible output", () => {
  assert.equal(normalizeTitleText("\u0000\u200b\t\n"), "");
  assert.equal(normalizeTitleText('“修复\n 标题”'), "修复 标题");
  const title = normalizeTitleText("😀".repeat(30));
  assert.equal(Buffer.byteLength(title), 80);
  assert.equal([...title].length, 20);
  assert.equal(fallbackTitle("中".repeat(80)), "中".repeat(40));
  assert.equal(fallbackTitle("a".repeat(100)), "a".repeat(60));
  assert.equal(normalizeTitleText("x\ud800y"), "x�y");
});

test("accept persists fallback before background generation and deduplicates each session", async () => {
  const gate = deferred(); let calls = 0;
  const env = await fixture({ async generate() { calls++; return gate.promise; } });
  await env.create("fallback");
  await env.controller.accept({ sessionId: "fallback", text: "修复新建会话标题", inputId: "first" });
  const initial = await env.sessions.get({ sessionId: "fallback" });
  assert.equal(initial.title, "修复新建会话标题"); assert.equal(initial.titleSource, "fallback");
  await env.controller.accept({ sessionId: "fallback", text: "后续消息不应另建任务" });
  await until(() => calls === 1);
  gate.resolve({ title: "生成相关会话标题", model: { provider: "fake", model: "fast" }, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, source: "provider" } });
  await env.controller.waitForIdle();
  assert.equal((await env.sessions.get({ sessionId: "fallback" })).titleSource, "model");
  assert.equal((await env.controller.inspect("fallback")).inputId, "first");
  assert.equal((await env.controller.inspect("fallback")).usage.totalTokens, 8);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(env.events).includes("修复新建"), false);
  await env.controller.close();
});

test("queued work respects global concurrency while preserving independent jobs", async () => {
  let inFlight = 0; let maximum = 0;
  const env = await fixture({ async generate() { inFlight++; maximum = Math.max(maximum, inFlight); await delay(8); inFlight--; return { title: "完成" }; } });
  await Promise.all(["one", "two", "three"].map(async id => { await env.create(id); await env.controller.accept({ sessionId: id, text: id }); }));
  await env.controller.waitForIdle();
  assert.equal(maximum, 1);
  assert.equal((await env.controller.inspect("three")).state, "succeeded");
  await env.controller.close();
});

test("foreground work leaves durable titles pending without attempts or a hot polling loop", async () => {
  let foreground = true, checks = 0, calls = 0;
  const env = await fixture({ async generate() { calls++; return { title: "前台结束后生成" }; } }, {}, {
    canDispatch: () => { checks++; return !foreground; },
  });
  try {
    await env.create("foreground");
    await env.controller.accept({ sessionId: "foreground", text: "先回答用户的首条消息", inputId: "first-input" });
    await env.controller.accept({ sessionId: "foreground", text: "不能改变首条任务" });
    await env.controller.resume();
    await delay(550);
    assert.equal(calls, 0);
    const pending = await env.controller.inspect("foreground");
    assert.equal(pending.state, "pending"); assert.equal(pending.attempts, 0);
    assert.equal(pending.inputId, "first-input");
    assert.equal((await env.sessions.get({ sessionId: "foreground" })).titleSource, "fallback");
    assert.ok(checks < 12, `Foreground waits must not poll at an already-due job's timestamp (${checks} checks)`);
    foreground = false;
    await env.controller.waitForIdle();
    assert.equal(calls, 1);
    assert.equal((await env.controller.inspect("foreground")).attempts, 1);
  } finally { await env.controller.close(); }
});

test("replacement rechecks foreground activity and resumes the same pending job after it ends", async () => {
  let foreground = true, calls = 0;
  const generator = { async generate() { calls++; return { title: "替换后仍等主会话" }; } };
  const env = await fixture(generator, {}, { canDispatch: () => !foreground });
  let replacement;
  try {
    await env.create("replacement");
    await env.controller.accept({ sessionId: "replacement", text: "首轮主会话仍然在运行" });
    const original = await env.controller.inspect("replacement");
    await env.controller.close();
    replacement = new TitleController({ sessions: env.sessions, store: env.store, generator, canDispatch: () => !foreground });
    await replacement.resume(); await delay(300);
    assert.equal(calls, 0);
    const held = await replacement.inspect("replacement");
    assert.equal(held.jobId, original.jobId); assert.equal(held.attempts, 0);
    foreground = false;
    await replacement.waitForIdle();
    assert.equal(calls, 1);
    assert.equal((await replacement.inspect("replacement")).jobId, original.jobId);
  } finally { await env.controller.close(); await replacement?.close(); }
});

test("foreground admission during a job read prevents claiming an attempt", async () => {
  let foreground = false, calls = 0;
  const env = await fixture({ async generate() { calls++; return { title: "空闲后生成" }; } }, {}, { canDispatch: () => !foreground });
  const read = env.store.get.bind(env.store);
  const entered = deferred(), release = deferred();
  let reads = 0;
  env.store.get = async sessionId => {
    if (++reads === 2) { entered.resolve(); await release.promise; }
    return read(sessionId);
  };
  try {
    await env.create("claim-race");
    await env.controller.accept({ sessionId: "claim-race", text: "存储读取期间有新的前台会话" });
    await entered.promise;
    foreground = true; release.resolve(); await delay(20);
    const held = await env.controller.inspect("claim-race");
    assert.equal(held.state, "pending"); assert.equal(held.attempts, 0); assert.equal(calls, 0);
    foreground = false;
    await env.controller.waitForIdle(); assert.equal(calls, 1);
  } finally { release.resolve(); await env.controller.close(); }
});

test("foreground waits survive unavailable checks and cancel or purge without dispatching", async () => {
  const env = await fixture({ async generate() { assert.fail("Cancelled or purged pending jobs cannot dispatch"); } }, {}, {
    canDispatch: () => { throw new Error("Foreground snapshot temporarily unavailable"); },
  });
  try {
    for (const sessionId of ["cancel-wait", "purge-wait", "close-wait"]) {
      await env.create(sessionId); await env.controller.accept({ sessionId, text: "保留兜底" });
    }
    await delay(10);
    await env.controller.cancel("cancel-wait"); await env.controller.purge("purge-wait");
    assert.equal((await env.controller.inspect("cancel-wait")).state, "cancelled");
    assert.equal(await env.controller.inspect("purge-wait"), undefined);
    await env.controller.close();
    assert.equal((await env.controller.inspect("close-wait")).state, "pending");
    assert.equal((await env.controller.inspect("close-wait")).attempts, 0);
  } finally { await env.controller.close(); }
});

test("admission suspension reconciles and accepts durably without starting a Provider until all holds release", async () => {
  let calls = 0;
  const env = await fixture({ async generate() { calls++; return { title: "就绪后生成" }; } });
  const firstRelease = env.controller.suspendAdmissions();
  const secondRelease = env.controller.suspendAdmissions();
  await env.create("ready");
  await env.controller.accept({ sessionId: "ready", text: "等到运行时就绪" });
  await env.controller.resume(); await delay(5);
  assert.equal((await env.controller.inspect("ready")).state, "pending"); assert.equal(calls, 0);
  firstRelease(); firstRelease(); await delay(5); assert.equal(calls, 0);
  secondRelease(); await env.controller.waitForIdle();
  assert.equal(calls, 1); assert.equal((await env.controller.inspect("ready")).state, "succeeded");
  await env.controller.close();
});

test("manual rename during a request wins and legacy or archived sessions never dispatch", async () => {
  const gate = deferred(); let calls = 0;
  const env = await fixture({ async generate() { calls++; return gate.promise; } });
  await env.create("rename"); await env.create("legacy", { title: "已有标题" });
  await env.create("archived"); await env.sessions.archive({ sessionId: "archived" });
  await env.controller.accept({ sessionId: "rename", text: "生成标题" });
  await until(() => calls === 1);
  await env.sessions.updateMetadata({ sessionId: "rename", title: "手动标题" });
  await env.controller.accept({ sessionId: "legacy", text: "不能覆盖" });
  await env.controller.accept({ sessionId: "archived", text: "不能生成" });
  gate.resolve({ title: "迟到标题" });
  await env.controller.waitForIdle();
  assert.equal((await env.sessions.get({ sessionId: "rename" })).title, "手动标题");
  assert.equal((await env.controller.inspect("rename")).state, "cancelled");
  assert.equal(calls, 1);
  await env.controller.close();
});

test("empty transient results exhaust a finite retry budget; authentication fails once", async () => {
  let emptyCalls = 0;
  const empty = await fixture({ async generate() { emptyCalls++; return { title: "\u0000" }; } });
  await empty.create("empty"); await empty.controller.accept({ sessionId: "empty", text: "保留有意义的兜底" });
  await empty.controller.waitForIdle();
  assert.equal(emptyCalls, 3);
  assert.equal((await empty.controller.inspect("empty")).state, "failed");
  assert.equal((await empty.sessions.get({ sessionId: "empty" })).titleSource, "fallback");
  await empty.controller.close();
  let authCalls = 0;
  const auth = await fixture({ async generate() { authCalls++; throw new TitleGenerationError("authentication", false, "secret must not be logged"); } });
  await auth.create("auth"); await auth.controller.accept({ sessionId: "auth", text: "测试鉴权" });
  await auth.controller.waitForIdle();
  assert.equal(authCalls, 1);
  assert.equal(JSON.stringify(auth.events).includes("secret"), false);
  await auth.controller.close();
});

test("timeout records failure but retains its actual Provider slot, and late output cannot write", async () => {
  const gate = deferred(); let calls = 0;
  const env = await fixture({ async generate() { calls++; return gate.promise; } }, { timeoutMs: 8, maxAttempts: 1 });
  await env.create("timeout"); await env.controller.accept({ sessionId: "timeout", text: "超时兜底" });
  await until(async () => (await env.controller.inspect("timeout"))?.state === "failed");
  assert.equal(calls, 1); assert.equal((await env.controller.inspect("timeout")).lastError, "timeout");
  gate.resolve({ title: "不应写入" }); await env.controller.waitForIdle();
  assert.equal((await env.sessions.get({ sessionId: "timeout" })).title, "超时兜底");
  await env.controller.close();
});

test("close aborts work, resumes interrupted jobs without resetting attempts, and ignores late output", async () => {
  const gate = deferred(); let calls = 0;
  const env = await fixture({ async generate() { calls++; return gate.promise; } });
  await env.create("restart"); await env.controller.accept({ sessionId: "restart", text: "重启恢复" });
  await until(() => calls === 1);
  let closed = false;
  const closing = env.controller.close().then(() => { closed = true; });
  await delay(5); assert.equal(closed, false);
  assert.equal((await env.controller.inspect("restart")).state, "running");
  gate.resolve({ title: "旧进程迟到标题" }); await closing;
  assert.equal((await env.sessions.get({ sessionId: "restart" })).titleSource, "fallback");
  const recovered = new TitleController({ sessions: env.sessions, store: env.store, generator: { async generate() { return { title: "恢复后的标题" }; } } });
  await recovered.resume(); await recovered.waitForIdle();
  assert.equal((await recovered.inspect("restart")).attempts, 2);
  assert.equal((await recovered.inspect("restart")).state, "succeeded");
  assert.equal((await env.sessions.get({ sessionId: "restart" })).title, "恢复后的标题");
  await recovered.close();
});

test("restart recovery preserves exhausted budgets and completed or manual titles", async () => {
  const env = await fixture({ async generate() { assert.fail("Recovery must not call model"); } }, { maxAttempts: 2 });
  const session = await env.create("budget", { title: "兜底", titleSource: "fallback" });
  const job = { schemaVersion: 1, sessionId: "budget", jobId: "original", version: 1, state: "running", seed: "测试预算", expectedTitleRevision: session.titleRevision, attempts: 2, nextAttemptAt: 0, createdAt: 1, updatedAt: 1 };
  await env.store.put(job);
  await env.controller.resume(); await env.controller.waitForIdle();
  assert.equal((await env.controller.inspect("budget")).state, "failed");
  assert.equal((await env.controller.inspect("budget")).attempts, 2);
  await env.controller.close();
});

test("resume reconstructs the fallback-before-job crash window from trusted transcript or its bounded fallback", async () => {
  const seeds = [];
  const env = await fixture({ async generate({ text }) { seeds.push(text); return { title: "恢复标题" }; } });
  await env.create("window-history", { title: "已截断", titleSource: "fallback" });
  await env.sessions.appendMessages({ sessionId: "window-history", messages: [{
    idempotencyKey: "original-input", runId: "run-original", userTurnId: "turn-original", stepId: "step-original",
    origin: "user_input", inputSource: "user", message: { role: "user", content: "首条可信用户输入的完整语义" },
  }] });
  await env.create("window-early", { title: "早期截断fallback", titleSource: "fallback" });
  await env.controller.resume(); await env.controller.waitForIdle();
  assert.deepEqual(seeds, ["首条可信用户输入的完整语义", "早期截断fallback"]);
  assert.equal((await env.controller.inspect("window-history")).inputId, "turn-original");
  assert.equal((await env.controller.inspect("window-early")).state, "succeeded");
  await env.controller.close();
});

test("accept recovers a failed first job write without substituting a later input or its route", async () => {
  for (const withHistory of [false, true]) {
    const inputs = [];
    const env = await fixture({ async generate(input) { inputs.push(input); return { title: "首条消息标题" }; } });
    await env.create("first-put-failed");
    const originalPut = env.store.put.bind(env.store);
    let failFirst = true;
    env.store.put = async (...args) => {
      if (failFirst) { failFirst = false; throw new Error("simulated first job storage failure"); }
      return originalPut(...args);
    };
    const firstText = "首条用户消息".repeat(30);
    await assert.rejects(env.controller.accept({ sessionId: "first-put-failed", text: firstText, inputId: "initial-input", model: { provider: "first", model: "route" } }), /simulated/u);
    if (withHistory) await env.sessions.appendMessages({ sessionId: "first-put-failed", messages: [{
      idempotencyKey: "first-input", runId: "first-run", userTurnId: "first-turn", stepId: "first-step", origin: "user_input", inputSource: "user",
      message: { role: "user", content: firstText },
    }] });
    const storedFallback = (await env.sessions.get({ sessionId: "first-put-failed" })).title;
    await env.controller.accept({ sessionId: "first-put-failed", text: "完全不同的后续消息", inputId: "later-input", model: { provider: "later", model: "wrong-route" } });
    await env.controller.waitForIdle();
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].text, withHistory ? firstText : storedFallback);
    assert.equal(inputs[0].model, undefined);
    const recovered = await env.controller.inspect("first-put-failed");
    assert.equal(recovered.inputId, withHistory ? "first-turn" : undefined);
    assert.equal(recovered.model, undefined);
    await env.controller.close();
  }
});

test("a timed-out call that ignores abort cannot overlap its retry or another queued call", async () => {
  const gate = deferred(); let calls = 0; let active = 0; let maxActive = 0;
  const env = await fixture({ async generate() {
    calls++; active++; maxActive = Math.max(maxActive, active);
    try { return calls === 1 ? await gate.promise : { title: "正常生成" }; }
    finally { active--; }
  } }, { timeoutMs: 8, maxAttempts: 2 });
  await env.create("slow"); await env.create("queued");
  await env.controller.accept({ sessionId: "slow", text: "超时但尚未退出" });
  await env.controller.accept({ sessionId: "queued", text: "另一个排队任务" });
  await until(async () => (await env.controller.inspect("slow"))?.state === "retry");
  await delay(10); assert.equal(calls, 1);
  gate.resolve({ title: "迟到不可提交" }); await env.controller.waitForIdle();
  assert.equal(maxActive, 1); assert.equal(calls, 3);
  assert.equal((await env.sessions.get({ sessionId: "slow" })).title, "正常生成");
  await env.controller.close();
});

test("purging a deleted session prevents late completion from recreating its job", async () => {
  const gate = deferred(); let calls = 0;
  const env = await fixture({ async generate() { calls++; return gate.promise; } });
  await env.create("deleted"); await env.controller.accept({ sessionId: "deleted", text: "删除中的会话" });
  await until(() => calls === 1);
  await env.controller.purge("deleted"); await env.sessions.delete({ sessionId: "deleted" });
  gate.resolve({ title: "迟到标题" }); await env.controller.waitForIdle();
  assert.equal(await env.controller.inspect("deleted"), undefined);
  assert.equal(await env.sessions.get({ sessionId: "deleted" }), undefined);
  await env.controller.close();
});

test("StorageDomain jobs survive store replacement and use backend CAS", async () => {
  const data = new Map(); let revision = 0;
  const kv = {
    facet: "kv",
    async get({ namespace, key }) { const value = data.get(`${namespace}/${key}`); return value && { ...value, value: value.value.slice() }; },
    async put({ namespace, key, value, precondition }) {
      const id = `${namespace}/${key}`; const current = data.get(id);
      if ((precondition.kind === "absent" && current) || (precondition.kind === "revision" && current?.revision !== precondition.revision)) throw new StorageConflictError("CAS conflict");
      const next = String(++revision); data.set(id, { value: value.slice(), revision: next }); return { revision: next };
    },
    async delete({ namespace, key, precondition }) {
      const id = `${namespace}/${key}`;
      if (data.get(id)?.revision !== precondition.revision) throw new StorageConflictError("CAS conflict");
      return { deleted: data.delete(id) };
    },
  };
  const storage = { backend() { return { id: "test", capabilities: { kv: { list: false }, writerConcurrency: "process-local" }, kv }; } };
  const original = new DomainTitleJobStore({ storage, backendId: "test" });
  const job = { schemaVersion: 1, sessionId: "persist", jobId: "first", version: 1, state: "pending", seed: "裁剪后的输入", expectedTitleRevision: 1, attempts: 0, nextAttemptAt: 0, createdAt: 1, updatedAt: 1 };
  await original.put(job);
  const replacement = new DomainTitleJobStore({ storage, backendId: "test" });
  assert.deepEqual(await replacement.get("persist"), job);
  await assert.rejects(replacement.put(job), TitleJobConflictError);
  await replacement.put({ ...job, version: 2, state: "running", attempts: 1 }, 1);
  await assert.rejects(original.put({ ...job, version: 2 }, 1), TitleJobConflictError);
  await replacement.delete("persist", 2);
  assert.equal(await original.get("persist"), undefined);
});
