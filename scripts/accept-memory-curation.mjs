import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";
import { hash } from "../dist/memory/validation.js";
import { MemoryCurationScheduler } from "../dist/memory/curation/scheduler.js";
import { DomainCurationStore } from "../dist/memory/curation/store.js";
import { RecapMemoryExtractor, ModelMemoryExtractor } from "../dist/memory/curation/extractor.js";
import { ModelMemoryConsolidator } from "../dist/memory/curation/consolidator.js";
import { snapshotCurationState } from "../dist/memory/curation/validation.js";
import { BackgroundMemoryCuration } from "../dist/memory/curation/background.js";
import { createCurationTrigger } from "../dist/memory/consumers/curation-trigger.js";
import { SessionRunEvidenceSource } from "../dist/memory/adapters/session-evidence.js";

function evidence(index = 1, outcome = "completed") {
  return { id: `evidence-${index}`, sourceId: "fixture", outcome, sessionId: "session-1", runId: `run-${index}`,
    appliesTo: "This fixture project only", text: `Untrusted execution ${index} reported ${outcome}`,
    references: [{ kind: "session", id: `session-1:run-${index}`, revision: "run-v1", digest: hash(index), throughSequence: index }] };
}
const extractor = new RecapMemoryExtractor();
const consolidator = { async consolidate(input) {
  return { upserts: input.rawMemories.map(item => ({ ...item, id: `memory-${hash(item.id).slice(0, 32)}`, expectedVersion: 0 })), retirements: [] };
} };
function schedulerFor(f, options = {}) { return new MemoryCurationScheduler({ memory: f.memory, store: f.store, extractor, consolidator, ...options }); }
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-curation-"));
  const ctx = new Context(); await ctx.plugin(StorageHub);
  ctx.storage.register(new FileStorageBackend({ id: "file", rootDirectory: directory }));
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const store = new DomainCurationStore(ctx.storage, "file", memory.libraryId);
  const scheduler = schedulerFor({ memory, store }, options);
  return { ctx, memory, store, scheduler, directory, async close() {
    await scheduler.close(); await memory.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true });
  } };
}
function source(f, items = [evidence()]) { return f.scheduler.registerSource({ id: "fixture", scan: async () => items }); }
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for memory pipeline");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("extraction automatically consolidates into searchable memory without human candidates", async () => {
  const f = await fixture();
  try {
    source(f, [evidence(1, "failed")]); await f.scheduler.recover();
    assert.equal(await f.scheduler.scan(), 1); assert.equal(await f.scheduler.scan(), 0);
    await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs[0].status, "completed");
    assert.equal((await f.memory.state()).candidates.length, 0);
    assert.match((await f.memory.query())[0].content, /failed/);
    assert.match((await f.memory.query())[0].content, /not proof/);
    await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal((await f.memory.state()).audit.length, 1);
    assert.equal((await f.memory.state()).audit[0].action, "consolidate");
  } finally { await f.close(); }
});

test("one wake processes every queued source; no two-job or eight-memory ceiling", async () => {
  let active = 0, maximum = 0;
  const f = await fixture({ extractor: { async extract(item, signal) {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return extractor.extract(item, signal);
  } } });
  try {
    source(f, Array.from({ length: 12 }, (_, index) => evidence(index + 1)));
    await f.scheduler.scan(); await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
    assert.equal(maximum, 1, "one owner prevents overlapping library writes, not truncated learning");
    assert.equal((await f.scheduler.state()).jobs.filter(job => job.status === "completed").length, 12);
    assert.equal((await f.memory.state()).documents.length, 12);
    assert.equal((await f.memory.state()).audit.length, 1, "all new raw learning is consolidated together");
  } finally { await f.close(); }
});

test("empty extraction is durable success and does not invoke consolidation", async () => {
  const f = await fixture({ extractor: { async extract() { return []; } }, consolidator: { async consolidate() { assert.fail("no-op must not consolidate"); } } });
  try {
    source(f); await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs[0].status, "completed");
    assert.equal((await f.memory.state()).revision, 0);
    await f.scheduler.tick(); assert.equal((await f.scheduler.state()).jobs[0].attempts, 1);
  } finally { await f.close(); }
});

test("failure retries on later wakes without an attempt ceiling or automatic tight loop", async () => {
  let calls = 0;
  const f = await fixture({ extractor: { async extract(item, signal) {
    if (++calls <= 5) throw new Error("provider unavailable");
    return extractor.extract(item, signal);
  } } });
  try {
    source(f); await f.scheduler.scan();
    for (let i = 1; i <= 5; i++) { await f.scheduler.tick(); assert.equal(calls, i); assert.equal((await f.scheduler.state()).jobs[0].status, "queued"); }
    await f.scheduler.tick(); assert.equal((await f.scheduler.state()).jobs[0].status, "completed");
    assert.equal((await f.memory.query()).length, 1);
  } finally { await f.close(); }
});

test("failed phase two retries persisted raw memories without re-extraction", async () => {
  let extracts = 0, consolidations = 0;
  const f = await fixture({ extractor: { async extract(item, signal) { extracts++; return extractor.extract(item, signal); } },
    consolidator: { async consolidate(input) { if (++consolidations === 1) throw new Error("offline"); return consolidator.consolidate(input); } } });
  try {
    source(f); await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs[0].status, "extracted");
    assert.equal((await f.memory.query()).length, 0);
    await f.scheduler.tick(); assert.equal(extracts, 1); assert.equal(consolidations, 2);
    assert.equal((await f.memory.state()).candidates.length, 0); assert.equal((await f.memory.query()).length, 1);
  } finally { await f.close(); }
});

test("lost completion after an atomic memory commit replays the saved plan after restart", async () => {
  let extracts = 0, consolidations = 0, failed = false, replacement;
  const f = await fixture();
  const overrides = { extractor: { async extract(item, signal) { extracts++; return extractor.extract(item, signal); } },
    consolidator: { async consolidate(input) { consolidations++; return consolidator.consolidate(input); } } };
  const first = schedulerFor(f, { ...overrides, store: { read: (...args) => f.store.read(...args), close: async () => {},
    commit: async (value, ...args) => { if (!failed && value.jobs[0]?.status === "completed") { failed = true; throw new Error("crash after commit"); } return f.store.commit(value, ...args); } } });
  try {
    first.registerSource({ id: "fixture", scan: async () => [evidence()] });
    await first.scan(); await first.tick();
    assert.equal((await f.memory.state()).revision, 1); assert.ok((await first.state()).consolidation);
    await first.close(); replacement = schedulerFor(f, overrides); await replacement.recover(); await replacement.tick();
    assert.equal((await replacement.state()).jobs[0].status, "completed");
    assert.equal((await f.memory.state()).revision, 1); assert.equal(extracts, 1); assert.equal(consolidations, 1);
  } finally { await first.close(); await replacement?.close(); await f.close(); }
});

test("a concurrent library edit invalidates phase-two output and remerges from fresh state", async () => {
  let calls = 0;
  const f = await fixture();
  const worker = schedulerFor(f, { consolidator: { async consolidate(input) {
    calls++;
    if (calls === 1) await f.memory.propose({ ...input.rawMemories[0], operationId: "user-edit", targetId: "manual", expectedDocumentVersion: 0,
      actor: { kind: "human", id: "operator" }, reason: "concurrent edit" });
    return consolidator.consolidate(input);
  } } });
  try {
    worker.registerSource({ id: "fixture", scan: async () => [evidence()] }); await worker.scan(); await worker.tick();
    assert.equal((await f.memory.state()).documents.length, 0);
    assert.equal((await worker.state()).consolidation, undefined);
    await worker.tick(); assert.equal(calls, 2); assert.equal((await f.memory.state()).documents.length, 1);
    assert.equal((await worker.state()).jobs[0].attempts, 1);
  } finally { await worker.close(); await f.close(); }
});

test("cancelled extraction holds ownership until the real provider settles and ignores late results", async () => {
  const release = Promise.withResolvers(); let began = false;
  const f = await fixture({ extractor: { async extract(item, signal) { began = true; await release.promise; return extractor.extract(item, new AbortController().signal); } } });
  try {
    source(f); await f.scheduler.scan(); const tick = f.scheduler.tick(); await until(() => began);
    await f.scheduler.cancel((await f.scheduler.state()).jobs[0].id); await tick;
    assert.equal(f.scheduler.lifecycleSnapshot().activeJobs, 1);
    let drained = false; const closing = f.scheduler.close().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    release.resolve(); await closing; assert.equal((await f.memory.state()).revision, 0);
    assert.equal((await f.store.read()).jobs[0].status, "cancelled");
  } finally { release.resolve(); await f.close(); }
});

test("closing during consolidation drains the actual model and cannot publish late output", async () => {
  const release = Promise.withResolvers(); let began = false;
  const f = await fixture({ consolidator: { async consolidate(input) { began = true; await release.promise; return consolidator.consolidate(input); } } });
  try {
    source(f); await f.scheduler.scan(); const tick = f.scheduler.tick(); await until(() => began);
    let drained = false; const closing = f.scheduler.close().then(() => { drained = true; }); await tick;
    assert.equal(drained, false); release.resolve(); await closing;
    assert.equal((await f.memory.state()).revision, 0); assert.equal((await f.store.read()).jobs[0].status, "extracted");
  } finally { release.resolve(); await f.close(); }
});

test("retiring a source cancels and drains its actual read before release", async () => {
  const f = await fixture(); let began = false, drained = false;
  try {
    const unregister = f.scheduler.registerSource({ id: "fixture", scan(signal) {
      began = true; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        setImmediate(() => { drained = true; reject(signal.reason); });
      }, { once: true }));
    } });
    const scan = f.scheduler.scan(); const rejected = assert.rejects(scan, /retired/);
    await until(() => began); await unregister(); await rejected; assert.equal(drained, true);
  } finally { await f.close(); }
});

test("automatic selection still excludes current, active, archived and out-of-window sessions", async () => {
  const now = Date.now(), hour = 3_600_000, dates = { old: now - 8 * hour, recent: now - hour, ancient: now - 12 * 24 * hour, archived: now - 8 * hour, current: now - 8 * hour, busy: now - 8 * hour };
  const events = Object.entries(dates).flatMap(([id, at]) => [
    { type: "run.opened", runId: id, scope: id, occurredAt: new Date(at).toISOString() },
    { type: "run.completed", runId: id, scope: id, occurredAt: new Date(at).toISOString() },
  ]);
  events.push({ type: "run.opened", runId: "ongoing", scope: "busy", occurredAt: new Date(now).toISOString() });
  const f = await fixture();
  const background = new BackgroundMemoryCuration({ scheduler: f.scheduler, now: () => now,
    getSession: async ({ sessionId }) => ({ status: sessionId === "archived" ? "archived" : "active", updatedAt: new Date(dates[sessionId]).toISOString() }) });
  try {
    f.scheduler.registerSource(new SessionRunEvidenceSource({ readHistory: async ({ sessionId }) => ({ records: [
      { kind: "message", sequence: 1, recordId: sessionId, runId: sessionId, inputSource: "user", message: { role: "user", content: "Remember useful project facts" } },
    ] }) }, { readEvents: async () => events }));
    background.resume(); background.wake("current");
    await until(async () => (await f.scheduler.state()).jobs[0]?.status === "completed");
    assert.deepEqual((await f.scheduler.state()).jobs.map(job => job.evidence.sessionId), ["old"]);
    assert.equal((await f.memory.query()).length, 1);
  } finally { background.stop(); await background.drain(); await f.close(); }
});

test("archiving during extraction retains raw results but defers automatic publication", async () => {
  const now = Date.now(), occurredAt = new Date(now - 86_400_000).toISOString(), release = Promise.withResolvers();
  let status = "active", began = false;
  const f = await fixture({ extractor: { async extract(item, signal) { began = true; await release.promise; return extractor.extract(item, signal); } } });
  const background = new BackgroundMemoryCuration({ scheduler: f.scheduler, now: () => now,
    getSession: async () => ({ status, updatedAt: occurredAt }) });
  try {
    source(f, [{ ...evidence(), occurredAt }]); background.resume(); background.wake("other"); await until(() => began);
    status = "archived"; release.resolve(); await background.drain();
    assert.equal((await f.memory.state()).documents.length, 0); assert.equal((await f.scheduler.state()).jobs[0].status, "extracted");
    status = "active"; background.wake("other"); await until(async () => (await f.scheduler.state()).jobs[0].status === "completed");
    assert.equal((await f.scheduler.state()).jobs[0].attempts, 1);
  } finally { release.resolve(); background.stop(); await background.drain(); await f.close(); }
});

test("only nonempty human starts trigger learning; retired completion hooks do not wake", async () => {
  const wakes = [], completion = Promise.withResolvers(); let active = true;
  const feature = createCurationTrigger({ wake: id => wakes.push(id) }, {}, () => active);
  for (const context of [{ inputSource: "system", text: "work" }, { inputSource: "user", text: " " }]) await feature.runStarted({}, { scope: "s", completion: completion.promise }, context);
  assert.equal(feature.beforeInput, undefined); assert.deepEqual(wakes, []);
  await feature.runStarted({}, { scope: "s", completion: completion.promise }, { inputSource: "user", text: "work" });
  active = false; completion.resolve(); await completion.promise; assert.deepEqual(wakes, ["s"]);
  await createCurationTrigger({ wake() { throw new Error("retired"); } }, {}).runStarted({}, { scope: "s", completion: Promise.resolve() }, { inputSource: "user", text: "work" });
});

test("a failed backscan does not strand durable extracted work", async () => {
  const now = Date.now(), occurredAt = new Date(now - 86_400_000).toISOString(), errors = [];
  let fail = false;
  const f = await fixture();
  const background = new BackgroundMemoryCuration({ scheduler: f.scheduler, now: () => now,
    getSession: async () => ({ status: "active", updatedAt: occurredAt }), onError: error => errors.push(error.message) });
  try {
    f.scheduler.registerSource({ id: "fixture", scan: async () => { if (fail) throw new Error("offline"); return [{ ...evidence(), occurredAt }]; } });
    await f.scheduler.scan(); fail = true; background.resume(); background.wake("other");
    await until(async () => (await f.scheduler.state()).jobs[0].status === "completed"); assert.deepEqual(errors, ["offline"]);
  } finally { background.stop(); await background.drain(); await f.close(); }
});

test("legacy proposing jobs recover their saved extraction into automatic consolidation", async () => {
  const f = await fixture({ extractor: { async extract() { assert.fail("legacy extraction must be reused"); } } });
  try {
    source(f); await f.scheduler.scan(); const state = await f.store.read();
    await f.store.commit(snapshotCurationState({ ...state, revision: state.revision + 1,
      jobs: [{ ...state.jobs[0], status: "proposing", proposals: await extractor.extract(evidence(), new AbortController().signal) }] }), state.revision);
    await f.scheduler.recover(); await f.scheduler.tick();
    assert.equal((await f.memory.query()).length, 1); assert.equal((await f.memory.state()).candidates.length, 0);
  } finally { await f.close(); }
});

test("model extraction keeps full evidence and unrestricted output count and length", async () => {
  let request;
  const large = "useful learning ".repeat(2500);
  const model = new ModelMemoryExtractor({ async *stream(value) {
    request = value;
    yield { type: "text_delta", text: JSON.stringify({ memories: Array.from({ length: 10 }, (_, i) => ({ title: `Topic ${i}`, content: large, keywords: ["project"] })) }) };
    yield { type: "done", finishReason: "stop" };
  } }, { provider: "fixture", model: "fixture" });
  const input = { ...evidence(), text: "full evidence ".repeat(6000) + "IMPORTANT LAST FACT" };
  const result = await model.extract(input, new AbortController().signal);
  assert.equal(result.length, 10); assert.equal(result[0].content, large);
  assert.equal(request.maxOutputTokens, undefined); assert.deepEqual(request.tools, []);
  assert.equal(JSON.parse(request.messages[0].content).untrustedRollout, input.text);
});

test("malformed, truncated or tool-bearing model output never becomes raw memory", async () => {
  const run = (output, finishReason = "stop") => new ModelMemoryExtractor({ async *stream() {
    yield { type: "text_delta", text: output }; yield { type: "done", finishReason };
  } }, { provider: "fixture", model: "fixture" }).extract(evidence(), new AbortController().signal);
  assert.deepEqual(await run('{"memories":[]}'), []);
  for (const output of ['oops', '{}', '{"memories":[{"title":"missing body","keywords":[]}]}']) await assert.rejects(run(output));
  await assert.rejects(run('{"memories":[]}', "length"), /incomplete/);
  const model = new ModelMemoryExtractor({ async *stream() { yield { type: "tool_call", call: { name: "write" } }; } }, { provider: "fixture", model: "fixture" });
  await assert.rejects(model.extract(evidence(), new AbortController().signal), /cannot call tools/);
});

test("phase two merges existing IDs and resolves provenance from trusted source IDs", async () => {
  const raw = { ...(await extractor.extract(evidence(), new AbortController().signal))[0], id: "raw-1" };
  const existing = { ...raw, id: "topic", version: 3, status: "accepted" };
  let request;
  const model = new ModelMemoryConsolidator({ async *stream(value) {
    request = value; yield { type: "text_delta", text: JSON.stringify({ upserts: [{ id: "topic", title: "Merged", content: "New and prior facts", appliesTo: raw.appliesTo,
      keywords: ["project"], sourceIds: ["raw-1", "topic"] }], retirements: [] }) }; yield { type: "done" };
  } }, { provider: "fixture", model: "fixture" });
  const result = await model.consolidate({ rawMemories: [raw], documents: [existing] }, new AbortController().signal);
  assert.equal(result.upserts[0].expectedVersion, 3); assert.equal(result.upserts[0].evidence.length, 1);
  assert.equal(request.metadata.purpose, "memory-consolidation"); assert.equal(request.maxOutputTokens, undefined);
  const fake = new ModelMemoryConsolidator({ async *stream() {
    yield { type: "text_delta", text: JSON.stringify({ upserts: [{ id: "new", sourceIds: ["invented"] }], retirements: [] }) }; yield { type: "done" };
  } }, { provider: "fixture", model: "fixture" });
  await assert.rejects(fake.consolidate({ rawMemories: [raw], documents: [] }, new AbortController().signal), /invented/);
});

test("fabricated extraction evidence cannot enter automatic memory", async () => {
  const f = await fixture({ extractor: { async extract(item, signal) {
    const [raw] = await extractor.extract(item, signal); return [{ ...raw, evidence: [{ ...raw.evidence[0], digest: "f".repeat(64) }] }];
  } } });
  try {
    source(f); await f.scheduler.scan(); await f.scheduler.tick();
    assert.match((await f.scheduler.state()).jobs[0].error, /invented/); assert.equal((await f.memory.state()).revision, 0);
  } finally { await f.close(); }
});

test("recovered consolidation plans revalidate provenance before writing", async () => {
  const f = await fixture();
  const first = schedulerFor(f, { memory: { libraryId: f.memory.libraryId, state: (...args) => f.memory.state(...args),
    async consolidate() { throw new Error("storage unavailable"); } } });
  let replacement;
  try {
    first.registerSource({ id: "fixture", scan: async () => [evidence()] }); await first.scan(); await first.tick(); await first.close();
    const state = await f.store.read(), plan = state.consolidation;
    const forged = { ...plan.upserts[0], evidence: [{ ...plan.upserts[0].evidence[0], digest: "f".repeat(64) }] };
    await f.store.commit({ ...state, revision: state.revision + 1, consolidation: { ...plan, upserts: [forged] } }, state.revision);
    replacement = schedulerFor(f); await replacement.recover(); await replacement.tick();
    assert.equal((await f.memory.state()).revision, 0);
    assert.match((await replacement.state()).jobs[0].error, /invented evidence/);
  } finally { await first.close(); await replacement?.close(); await f.close(); }
});
