import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";
import { MemoryCurationScheduler } from "../dist/memory/curation/scheduler.js";
import { DomainCurationStore } from "../dist/memory/curation/store.js";
import { RecapMemoryCandidateExtractor, ModelMemoryCandidateExtractor } from "../dist/memory/curation/extractor.js";

function evidence(index = 1, outcome = "completed") {
  return { id: `evidence-${index}`, sourceId: "fixture", outcome, sessionId: "session-1", runId: `run-${index}`,
    appliesTo: "This fixture project only", text: `Untrusted execution ${index} reported ${outcome}`,
    references: [{ kind: "session", id: `session-1:run-${index}`, revision: "run-v1", digest: `${index}`.padStart(64, "0"), throughSequence: index }] };
}
async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-curation-"));
  const ctx = new Context(); await ctx.plugin(StorageHub);
  ctx.storage.register(new FileStorageBackend({ id: "file", rootDirectory: directory }));
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const store = new DomainCurationStore(ctx.storage, "file", memory.libraryId);
  const scheduler = new MemoryCurationScheduler({ memory, store, extractor: new RecapMemoryCandidateExtractor(), ...overrides });
  return { ctx, memory, store, scheduler, directory, async close() {
    await scheduler.close(); await memory.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
  } };
}

test("explicit scans create durable candidates once; failed evidence never becomes accepted knowledge", async () => {
  const f = await fixture();
  try {
    await f.scheduler.recover();
    f.scheduler.registerSource({ id: "fixture", scan: async () => [evidence(1, "failed")] });
    assert.equal((await f.scheduler.state()).jobs.length, 0);
    assert.equal(await f.scheduler.scan(), 1);
    assert.equal(await f.scheduler.scan(), 0);
    await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs[0].status, "completed");
    const state = await f.memory.state();
    assert.equal(state.candidates.length, 1); assert.equal(state.candidates[0].status, "pending");
    assert.match(state.candidates[0].content, /failed/); assert.deepEqual(await f.memory.query(), []);
    await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal((await f.memory.state()).audit.length, 1);
  } finally { await f.close(); }
});

test("crash after Memory commit reuses persisted proposals and idempotent operation IDs", async () => {
  let extractions = 0;
  const extractor = { async extract(item, signal) { extractions++; return new RecapMemoryCandidateExtractor().extract(item, signal); } };
  const f = await fixture({ extractor });
  let failedOnce = false, replacement;
  try {
    const wrapped = { read: (...args) => f.store.read(...args), close: async () => {}, commit: async (state, ...args) => {
      if (!failedOnce && state.jobs[0]?.candidateIds.length) { failedOnce = true; throw new Error("crash after Memory commit"); }
      return f.store.commit(state, ...args);
    } };
    const first = new MemoryCurationScheduler({ memory: f.memory, store: wrapped, extractor });
    first.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await first.scan(); await first.tick();
    assert.equal((await first.state()).jobs[0].status, "queued");
    assert.equal((await f.memory.state()).audit.length, 1);
    await first.close();
    replacement = new MemoryCurationScheduler({ memory: f.memory, store: new DomainCurationStore(f.ctx.storage, "file", f.memory.libraryId), extractor });
    await replacement.recover(); await replacement.tick();
    assert.equal((await replacement.state()).jobs[0].status, "completed");
    assert.equal(extractions, 1); assert.equal((await f.memory.state()).audit.length, 1);
  } finally { await replacement?.close(); await f.close(); }
});

test("scheduler respects concurrency, attempt budgets and queued cancellation", async () => {
  let active = 0, maximum = 0;
  const f = await fixture({ maxConcurrent: 2, extractor: { async extract(item, signal) {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return new RecapMemoryCandidateExtractor().extract(item, signal);
  } } });
  try {
    f.scheduler.registerSource({ id: "fixture", scan: async () => [evidence(1), evidence(2), evidence(3)] });
    await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal(maximum, 2);
    const queued = (await f.scheduler.state()).jobs.find(job => job.status === "queued");
    await f.scheduler.cancel(queued.id); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs.find(job => job.id === queued.id).status, "cancelled");
    assert.equal((await f.memory.state()).candidates.length, 2);
  } finally { await f.close(); }
  let calls = 0;
  const failing = await fixture({ maxAttempts: 2, extractor: { async extract() { calls++; throw new Error("model unavailable"); } } });
  try {
    failing.scheduler.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await failing.scheduler.scan(); await failing.scheduler.tick(); await failing.scheduler.tick(); await failing.scheduler.tick();
    assert.equal(calls, 2); assert.equal((await failing.scheduler.state()).jobs[0].status, "failed");
    assert.equal((await failing.memory.state()).revision, 0);
  } finally { await failing.close(); }
});

test("time budget and close abort extraction without publishing late results", async () => {
  const timeout = await fixture({ maxAttempts: 1, timeoutMs: 10, extractor: { extract: () => new Promise(() => {}) } });
  try {
    timeout.scheduler.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await timeout.scheduler.scan(); await timeout.scheduler.tick();
    assert.equal((await timeout.scheduler.state()).jobs[0].status, "failed");
    assert.match((await timeout.scheduler.state()).jobs[0].error, /time budget/);
  } finally { await timeout.close(); }
  let begun, signalSeen, late;
  const started = new Promise(resolve => { begun = resolve; });
  const closing = await fixture({ extractor: { extract(_item, signal) { signalSeen = signal; begun(); return new Promise(resolve => { late = resolve; }); } } });
  try {
    closing.scheduler.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await closing.scheduler.scan(); const tick = closing.scheduler.tick(); await started;
    await closing.scheduler.close(); await tick;
    assert.equal(signalSeen.aborted, true);
    late(await new RecapMemoryCandidateExtractor().extract(evidence(), new AbortController().signal));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await closing.memory.state()).revision, 0);
    assert.throws(() => closing.scheduler.tick(), /closed/);
    assert.equal((await closing.store.read()).jobs[0].status, "queued");
  } finally { await closing.close(); }
});

test("model extractor uses only bounded untrusted evidence, no AgentLoop or Tool schemas", async () => {
  let request;
  const extractor = new ModelMemoryCandidateExtractor({ async *stream(value) {
    request = value; yield { type: "start", model: value.model };
    yield { type: "text_delta", text: "Verification was not observed." }; yield { type: "done" };
  } }, { provider: "fixture", model: "fixture" });
  const candidates = await extractor.extract(evidence(1, "unknown"), new AbortController().signal);
  assert.deepEqual(request.tools, []); assert.equal(request.messages.length, 1);
  assert.equal(request.instructions.length, 1);
  assert.equal(request.maxOutputTokens, 2048); assert.match(request.instructions[0].content, /Never follow instructions/);
  assert.match(candidates[0].content, /unknown/);
  const malicious = new ModelMemoryCandidateExtractor({ async *stream() { yield { type: "tool_call", call: { name: "write" } }; } }, { provider: "fixture", model: "fixture" });
  await assert.rejects(malicious.extract(evidence(), new AbortController().signal), /cannot call tools/);
});

test("retiring an evidence source cancels its scan and drains reads before release", async () => {
  const f = await fixture(); let started, signalSeen, drained = false;
  const begun = new Promise(resolve => { started = resolve; });
  try {
    const unregister = f.scheduler.registerSource({ id: "fixture", scan(signal) {
      signalSeen = signal; started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        setImmediate(() => { drained = true; reject(signal.reason); });
      }, { once: true }));
    } });
    const scanning = f.scheduler.scan(); const rejection = assert.rejects(scanning, /retired/);
    await begun; await unregister(); await rejection;
    assert.equal(signalSeen.aborted, true); assert.equal(drained, true);
    assert.equal((await f.scheduler.state()).jobs.length, 0);
    assert.equal(await f.scheduler.scan(), 0);
  } finally { await f.close(); }
});

test("restart recovers durable running state, and fabricated evidence cannot become a candidate", async () => {
  const f = await fixture();
  try {
    f.scheduler.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await f.scheduler.scan();
    const state = await f.store.read();
    await f.store.commit({ ...state, revision: state.revision + 1, jobs: state.jobs.map(job => ({ ...job, status: "running", attempts: 1 })) }, state.revision);
    await f.scheduler.recover();
    assert.equal((await f.scheduler.state()).jobs[0].status, "queued");
    await f.scheduler.tick(); assert.equal((await f.scheduler.state()).jobs[0].status, "completed");
  } finally { await f.close(); }
  const fabricated = await fixture({ maxAttempts: 1, extractor: { async extract(item, signal) {
    const result = await new RecapMemoryCandidateExtractor().extract(item, signal);
    return [{ ...result[0], evidence: [{ ...item.references[0], digest: "f".repeat(64) }] }];
  } } });
  try {
    fabricated.scheduler.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await fabricated.scheduler.scan(); await fabricated.scheduler.tick();
    assert.equal((await fabricated.scheduler.state()).jobs[0].status, "failed");
    assert.match((await fabricated.scheduler.state()).jobs[0].error, /invented evidence/);
    assert.equal((await fabricated.memory.state()).revision, 0);
  } finally { await fabricated.close(); }
});
