import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionTrigger, MemoryEvolutionTriggerStore, StorageEvolutionTriggerStore } from "../dist/evolution/triggers.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";
const sha = digit => digit.repeat(64);
const input = (digit = "a", extra = {}) => ({ id: `suggestion-${digit}`, target: "prompt", failureCategory: "harness", confidence: 0.9,
  taskIds: ["task-one", "task-two", "task-three"], evidenceDigest: sha(digit), summary: "Repeated Harness defect across independent tasks", ...extra });
const automatic = { mode: "automatic", targets: ["prompt"], cooldownMs: 0, maxConcurrent: 1, maxDispatches: 3, windowMs: 1000 };
test("Host resource limits defer research without consuming a dispatch identity or quota", async () => {
  let available = false;
  const f = fixture({ assessResources: async () => ({ available, reason: "daily-research-budget" }) }, automatic);
  try {
    const deferred = await f.trigger.tick(); assert.ok(Object.values(deferred.deferred).includes("daily-research-budget"));
    assert.equal((await f.store.read()).dispatches.length, 0); assert.equal(f.dispatches.length, 0);
    available = true; await f.trigger.tick(); assert.equal(f.dispatches.length, 1);
  } finally { await f.trigger.close(); }
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await tick(); } assert.fail("condition not reached"); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}, configuration, store = new MemoryEvolutionTriggerStore(), now = () => 1000) {
  let suggestions = [input()], busy = false, reads = 0; const dispatches = [];
  const ports = { listSuggestions: async () => { reads++; return suggestions; }, isUserBusy: () => busy,
    dispatch: async (suggestion, context) => { dispatches.push({ suggestion, context }); return { campaignId: `campaign-${suggestion.id}`, settled: true }; }, ...overrides };
  const trigger = new EvolutionTrigger({ store, ports, ...(configuration ? { config: configuration } : {}), now });
  return { trigger, store, ports, dispatches, get reads() { return reads; }, suggestions: value => { suggestions = value; }, busy: value => { busy = value; } };
}

test("Default off and advisory never dispatch; advisory preserves uncertain/environment observations", async () => {
  const f = fixture();
  try {
    assert.equal((await f.trigger.tick()).mode, "off"); assert.equal(f.reads, 0);
    f.trigger.configure({ mode: "advisory" }); f.suggestions([input("a", { failureCategory: "environment", confidence: 0.1 })]);
    const result = await f.trigger.tick(); assert.equal(result.advisories.length, 1); assert.equal(result.dispatched.length, 0); assert.equal(f.dispatches.length, 0);
    assert.equal((await f.store.read()).dispatches.length, 0);
  } finally { await f.trigger.close(); }
});
test("Automatic requires an explicit fixed target and independently supported Harness attribution", async () => {
  assert.throws(() => fixture({}, { mode: "automatic" }), error => error.code === "evolution_trigger_fixed_target_required");
  const f = fixture({}, automatic);
  try {
    f.suggestions([input("a", { taskIds: ["same-task", "same-task", "same-task"] }), input("b", { confidence: 0.79 }), input("c", { failureCategory: "authorization" }), input("d", { failureCategory: "unknown" }), input("e", { failureCategory: "project" }), input("f", { target: "skill" })]);
    const result = await f.trigger.tick(); assert.equal(result.dispatched.length, 0); assert.equal(result.advisories.length, 5);
    f.suggestions([input()]); assert.equal((await f.trigger.tick()).dispatched.length, 1); assert.equal(f.dispatches.length, 1);
  } finally { await f.trigger.close(); }
});
test("Suggestion identity deduplicates immutable evidence across id changes and restart", async () => {
  const first = fixture({}, automatic); await first.trigger.tick(); await first.trigger.close();
  const second = fixture({}, automatic, first.store);
  try {
    second.suggestions([input("a", { id: "different-name" })]);
    const result = await second.trigger.tick(); assert.equal(result.dispatched.length, 0); assert.equal(second.dispatches.length, 0); assert.equal((await second.store.read()).dispatches.length, 1);
  } finally { await second.trigger.close(); }
});
test("User task priority defers without reserving budget and retries after the Host becomes idle", async () => {
  const f = fixture({}, automatic);
  try {
    f.busy(true); const waiting = await f.trigger.tick(); assert.equal(Object.values(waiting.deferred)[0], "user-task-busy"); assert.equal((await f.store.read()).dispatches.length, 0);
    f.busy(false); const done = await f.trigger.tick(); assert.equal(done.dispatched.length, 1);
  } finally { await f.trigger.close(); }
});
test("Cooldown and window quotas are persisted across configuration and evidence changes", async () => {
  let time = 1000; const f = fixture({}, { ...automatic, cooldownMs: 100, maxDispatches: 2 }, undefined, () => time);
  try {
    await f.trigger.tick(); f.suggestions([input("b")]); time = 1050; assert.equal(Object.values((await f.trigger.tick()).deferred)[0], "cooldown");
    time = 1100; assert.equal((await f.trigger.tick()).dispatched.length, 1);
    f.suggestions([input("c")]); time = 1500; assert.equal(Object.values((await f.trigger.tick()).deferred)[0], "window-budget");
    time = 2200; assert.equal((await f.trigger.tick()).dispatched.length, 1); assert.equal((await f.store.read()).dispatches.length, 3);
  } finally { await f.trigger.close(); }
});
test("Concurrent ticks obey the persisted concurrency limit while dispatch is pending", async () => {
  const pending = gate(); let entered = false;
  const f = fixture({ dispatch: async () => { entered = true; await pending.promise; return { campaignId: "slow-campaign" }; } }, automatic);
  const first = f.trigger.tick(); await waitFor(() => entered);
  try {
    f.suggestions([input("b")]); const second = await f.trigger.tick(); assert.equal(Object.values(second.deferred)[0], "concurrency-limit");
    assert.equal((await f.store.read()).dispatches[0].status, "pending");
  } finally { pending.resolve(); await first; await f.trigger.close(); }
});
test("Two trigger owners cannot dispatch the same evidence after a CAS race", async () => {
  const store = new MemoryEvolutionTriggerStore(), first = fixture({}, automatic, store), second = fixture({}, automatic, store);
  try {
    await Promise.all([first.trigger.tick(), second.trigger.tick()]);
    assert.equal(first.dispatches.length + second.dispatches.length, 1); assert.equal((await store.read()).dispatches.length, 1);
  } finally { await first.trigger.close(); await second.trigger.close(); }
});
test("A created Campaign retains its concurrency slot until Host technical completion", async () => {
  const f = fixture({ dispatch: async () => ({ campaignId: "still-developing" }) }, automatic);
  try {
    const first = await f.trigger.tick(); f.suggestions([input("b")]);
    assert.equal(Object.values((await f.trigger.tick()).deferred)[0], "concurrency-limit");
    await assert.rejects(f.trigger.markSettled(first.dispatched[0], "wrong-campaign"), error => error.code === "evolution_trigger_receipt_mismatch");
    await f.trigger.markSettled(first.dispatched[0], "still-developing");
    assert.equal((await f.trigger.tick()).dispatched.length, 1);
  } finally { await f.trigger.close(); }
});
test("Transport uncertainty is durable and Host reconciliation never replays dispatch", async () => {
  const first = fixture({ dispatch: async () => { throw new Error("response-lost"); } }, automatic); await first.trigger.tick();
  assert.equal((await first.store.read()).dispatches[0].status, "uncertain"); await first.trigger.close();
  let found;
  const second = fixture({ reconcile: async () => found }, automatic, first.store);
  try {
    assert.equal((await second.trigger.recover()).dispatches[0].status, "uncertain");
    await second.trigger.tick(); assert.equal(second.dispatches.length, 0);
    found = { campaignId: "host-found-campaign" }; assert.equal((await second.trigger.recover()).dispatches[0].status, "dispatched");
    await second.trigger.tick(); assert.equal(second.dispatches.length, 0);
  } finally { await second.trigger.close(); }
});
test("A model score or evaluator flag cannot become a trigger decision input", async () => {
  const f = fixture({}, automatic);
  try {
    f.suggestions([input("a", { score: 1, evaluatorAccepted: true })]);
    await assert.rejects(f.trigger.tick(), error => error.code === "evolution_trigger_invalid_suggestion"); assert.equal(f.dispatches.length, 0);
  } finally { await f.trigger.close(); }
});
test("CAS updates cannot erase dispatch history to reset quotas", async () => {
  const f = fixture({}, automatic);
  try {
    await f.trigger.tick(); const current = await f.store.read();
    await assert.rejects(f.store.compareAndSwap(current.revision, { ...current, revision: current.revision + 1, dispatches: [] }), error => error.code === "evolution_trigger_history_immutable");
    assert.equal((await f.store.read()).dispatches.length, 1);
  } finally { await f.trigger.close(); }
});
test("Closing aborts and drains only owned dispatch calls before releasing storage", async () => {
  let signal, released = false; const foreign = new AbortController();
  const store = new MemoryEvolutionTriggerStore(); store.close = async () => { released = true; };
  const f = fixture({ dispatch: async (_suggestion, context) => {
    signal = context.signal; return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
  } }, automatic, store);
  const running = f.trigger.tick(); await waitFor(() => !!signal);
  const first = f.trigger.close(), second = f.trigger.close(); assert.equal(first, second); await first; await running;
  assert.equal(signal.aborted, true); assert.equal(foreign.signal.aborted, false); assert.equal(released, true); assert.equal((await store.read()).dispatches[0].status, "uncertain");
});
test("StorageDomain preserves intent, deduplication and quota after a durable reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-evolution-trigger-")); let released = 0;
  const kv = new FileKvStorageBackend({ backendId: "trigger-test", rootDirectory: root });
  const backend = { id: "trigger-test", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv };
  const lease = () => ({ id: backend.id, released: false, backend: () => backend, resolve: () => kv, acquire: () => lease(), release() { if (this.released) return false; this.released = true; released++; return true; } });
  const first = fixture({}, automatic, new StorageEvolutionTriggerStore(lease()));
  try {
    await first.trigger.tick(); await first.trigger.close();
    const second = fixture({}, automatic, new StorageEvolutionTriggerStore(lease()));
    try { await second.trigger.tick(); assert.equal(second.dispatches.length, 0); assert.equal((await second.store.read()).dispatches[0].status, "completed"); }
    finally { await second.trigger.close(); }
    assert.equal(released, 2); assert.equal((await kv.list({ namespace: "evolution/triggers/v1" })).length, 1);
  } finally { await first.trigger.close(); await rm(root, { recursive: true, force: true }); }
});
test("Retirement while awaiting Host busy state cannot reserve or dispatch new work", async () => {
  const pending = gate(); let entered = false; const f = fixture({ isUserBusy: async () => { entered = true; await pending.promise; return false; } }, automatic);
  const running = f.trigger.tick(); await waitFor(() => entered); f.trigger.suspend(); pending.resolve();
  await assert.rejects(running, error => error.code === "evolution_trigger_closed");
  assert.equal((await f.store.read()).dispatches.length, 0); assert.equal(f.dispatches.length, 0); await f.trigger.close();
});
test("Malformed settled receipts cannot free a running Campaign concurrency slot", async () => {
  const f = fixture({ dispatch: async () => ({ campaignId: "campaign", settled: "yes" }) }, automatic);
  try { await f.trigger.tick(); assert.equal((await f.store.read()).dispatches[0].status, "uncertain"); }
  finally { await f.trigger.close(); }
});
