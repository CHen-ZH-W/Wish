import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionController, MemoryEvolutionStore, StorageEvolutionStore } from "../dist/evolution/index.js";
import { digest, validateSpec } from "../dist/evolution/validation.js";
import { journalEvolutionPorts, MemoryEvolutionOperationJournal } from "../dist/evolution/journal.js";
import { promptCandidate } from "../dist/evolution/generator.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

const sha = "a".repeat(64), bsha = "b".repeat(64), csha = "c".repeat(64);
const local = { modelCalls: 0, tokens: 0, costByCurrency: {}, complete: true };
const generated = { modelCalls: 1, tokens: 10, costByCurrency: { CNY: null }, complete: true };
const spec = extra => ({ objective: "Improve recovery guidance", baselineSnapshotDigest: sha, allowedTargets: ["prompt"],
  maxRounds: 3, patience: 2, budget: { modelCalls: 10, tokens: 1000, costByCurrency: {}, timeoutMs: 5000 }, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 2000; i++) { if (predicate()) return; await tick(); } assert.fail("condition not reached"); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function makePorts(overrides = {}) {
  const calls = [], cleanups = [];
  const ports = {
    evidence: async context => { calls.push(["evidence", context.operationId]); return { traces: [], tickets: [{ id: "manual", traceIds: [], traceDigests: [], failureCategory: "unknown", evidenceRefs: [], summary: "Manual request", problem: "Missing recovery instructions", hypothesis: "Add precise guidance", target: "prompt", confidence: 0 }], usage: local }; },
    generate: async context => { calls.push(["generate", context.operationId]); return { id: `proposal-${context.attempt.round}`, ticketIds: ["manual"], target: "prompt", rationale: "Explain how to recover", source: promptCandidate({ id: "recovery-guide", version: context.attempt.round, content: `Inspect committed operation state before retrying. Research revision ${context.attempt.round}.`, purpose: "Better recovery", runId: context.attempt.id }), usage: generated }; },
    candidate: async context => { calls.push(["candidate", context.operationId]); return { candidateDigest: digest(context.attempt.proposal.source), validationId: `validation-${context.attempt.round}`, artifactDigest: bsha, snapshotDigest: csha, usage: local }; },
    evaluate: async context => { calls.push(["evaluate", context.operationId]); return { authority: "host", experimentId: `experiment-${context.attempt.round}`, datasetDigest: sha, candidateDigest: context.attempt.candidate.candidateDigest, decision: "rejected", baselineScore: 1, candidateScore: 0, reason: "No proven gain", evidenceDigest: sha, usage: local }; },
    feedback: async context => { calls.push(["feedback", context.operationId]); return { id: `feedback-${context.attempt.round}`, summary: "Candidate awaits external validation; no outcome claimed", evidenceRefs: [], usage: local }; },
    publish: async (_context, approvedDigest) => { calls.push(["publish", approvedDigest]); return { authority: "host", approvedDigest, promotionId: "promotion-one", status: "active" }; },
    cleanup: async context => { cleanups.push(context.attempt.id); }, ...overrides,
  };
  return { ports, calls, cleanups };
}
async function fixture(action, overrides, extra) {
  const fake = makePorts(overrides), store = new MemoryEvolutionStore(), controller = new EvolutionController({ store, ports: fake.ports });
  try { await action({ ...fake, store, controller, campaign: await controller.create(spec(extra), "request-one") }); }
  finally { await controller.close(); }
}

test("Default deferred development persists each actual stage without evaluation or promotion", () => fixture(async ({ controller, campaign, calls }) => {
  const done = await controller.run(campaign.id);
  assert.equal(done.spec.evaluationMode, "deferred"); assert.equal(done.state, "awaiting-external-validation", done.error);
  assert.deepEqual(calls.map(item => item[0]), ["evidence", "generate", "candidate", "feedback"]);
  assert.ok(done.attempts[0].candidate); assert.ok(done.attempts[0].feedback);
  assert.equal(done.attempts[0].verdict, undefined); assert.equal(done.review, undefined); assert.equal(done.bestScore, undefined);
  assert.equal(done.usage.costByCurrency.CNY, null); assert.equal(done.attempts[0].operations.every(item => item.status === "completed"), true);
  await assert.rejects(controller.approve(done.id, { expectedRevision: done.revision, requestId: "forged", approvedDigest: sha }), error => error.code === "evolution_approval_digest_mismatch");
}));
test("Create request identity survives retries and CAS rejects stale writes", () => fixture(async ({ controller, store, campaign }) => {
  assert.equal((await controller.create(spec(), "request-one")).id, campaign.id);
  await assert.rejects(controller.create(spec({ objective: "Different" }), "request-one"), error => error.code === "evolution_request_conflict");
  const stopped = await controller.pause(campaign.id, { expectedRevision: campaign.revision });
  await assert.rejects(controller.cancel(campaign.id, { expectedRevision: campaign.revision }), error => error.code === "evolution_conflict");
  await assert.rejects(store.compareAndSwap(campaign.id, campaign.revision, { ...stopped, revision: stopped.revision + 1 }), error => error.code === "evolution_conflict");
}));
test("Deferred next round requires explicit human feedback and remains score-free", () => fixture(async ({ controller, campaign, calls }) => {
  const first = await controller.run(campaign.id);
  await assert.rejects(controller.run(first.id), error => error.code === "evolution_run_state");
  const next = await controller.continue(first.id, { expectedRevision: first.revision, requestId: "human-feedback", feedback: "Also explain the unknown-operation case" });
  assert.equal((await controller.continue(first.id, { expectedRevision: first.revision, requestId: "human-feedback", feedback: "Also explain the unknown-operation case" })).revision, next.revision);
  const second = await controller.run(next.id);
  assert.equal(second.attempts.length, 2); assert.equal(second.inputs[0].feedback, "Also explain the unknown-operation case");
  assert.equal(second.bestScore, undefined); assert.equal(calls.filter(item => item[0] === "evaluate").length, 0);
}));
test("Pausing fences late generation and recovery reconciles the exact operation without replay", async () => {
  const gate = deferred(); let entered, raw, generateCalls = 0;
  const base = makePorts();
  await fixture(async ({ controller, campaign, cleanups }) => {
    const running = controller.run(campaign.id); await waitFor(() => !!entered);
    const current = await controller.get(campaign.id), paused = await controller.pause(campaign.id, { expectedRevision: current.revision });
    assert.equal((await running).state, "paused"); assert.equal(cleanups.length, 0);
    raw = await base.ports.generate(entered); gate.resolve(raw); await tick(); await tick();
    assert.equal((await controller.get(campaign.id)).revision, paused.revision); assert.equal((await controller.get(campaign.id)).attempts[0].proposal, undefined);
    await waitFor(() => cleanups.length === 1);
    const resumed = await controller.resume(campaign.id); assert.equal(resumed.state, "reconciliation-required");
    const recovered = await controller.recover(campaign.id); assert.equal(recovered.state, "waiting-input");
    assert.equal(recovered.usage.complete, true); assert.equal(recovered.usage.modelCalls, 1);
    const done = await controller.run(campaign.id); assert.equal(done.state, "awaiting-external-validation"); assert.equal(generateCalls, 1);
  }, { generate: async context => { generateCalls++; entered = context; return gate.promise; }, reconcile: async (_context, operation) => { assert.equal(operation.id, entered.operationId); return raw; } });
});
test("Unresolved restart intent remains visible and never starts a second external call", async () => {
  let entered; const gate = deferred();
  const fake = makePorts({ generate: async context => { entered = context; return gate.promise; } });
  const store = new MemoryEvolutionStore(), first = new EvolutionController({ store, ports: fake.ports });
  const campaign = await first.create(spec(), "restart"); const running = first.run(campaign.id); await waitFor(() => !!entered);
  first.suspend(); await running; gate.resolve(await makePorts().ports.generate(entered)); await tick();
  const second = new EvolutionController({ store, ports: makePorts().ports });
  try {
    const current = await second.recover(campaign.id); assert.equal(current.state, "reconciliation-required");
    await assert.rejects(second.run(campaign.id), error => error.code === "evolution_run_state");
    assert.equal((await second.get(campaign.id)).attempts[0].operations.at(-1).status, "pending");
  } finally { await first.close(); await second.close(); }
});
test("Model-origin Host verdict fields cannot pass the proposal boundary", () => fixture(async ({ controller, campaign, calls }) => {
  const done = await controller.run(campaign.id); assert.equal(done.state, "reconciliation-required");
  assert.match(done.error, /untrusted_host_output/); assert.equal(calls.some(item => item[0] === "candidate"), false);
}, { generate: async context => ({ ...await makePorts().ports.generate(context), review: { digest: sha }, verdict: "accepted" }) }));
test("Unknown prices retain currency and block only explicitly budgeted currencies", async () => {
  await fixture(async ({ controller, campaign }) => { const done = await controller.run(campaign.id); assert.equal(done.state, "awaiting-external-validation"); assert.equal(done.usage.costByCurrency.CNY, null); });
  await fixture(async ({ controller, campaign, calls }) => { const done = await controller.run(campaign.id); assert.equal(done.stopReason, "price-unknown"); assert.equal(calls.some(item => item[0] === "candidate"), false); }, {}, { budget: { modelCalls: 10, tokens: 1000, costByCurrency: { CNY: 10 }, timeoutMs: 5000 } });
  await fixture(async ({ controller, campaign }) => { const done = await controller.run(campaign.id); assert.equal(done.stopReason, "usage-incomplete"); }, { generate: async context => ({ ...await makePorts().ports.generate(context), usage: { ...generated, complete: false } }) });
});
test("External rounds stop at patience and never publish rejected candidates", () => fixture(async ({ controller, campaign, calls }) => {
  const done = await controller.run(campaign.id); assert.equal(done.state, "completed"); assert.equal(done.stopReason, "patience");
  assert.equal(done.attempts.length, 2); assert.equal(calls.filter(item => item[0] === "evaluate").length, 2); assert.equal(calls.some(item => item[0] === "publish"), false);
}, {}, { evaluationMode: "external", datasetDigest: sha }));
test("A real Host review waits for explicit matching-digest approval", async () => {
  const fake = makePorts();
  await fixture(async ({ controller, campaign, calls }) => {
    const done = await controller.run(campaign.id); assert.equal(done.state, "awaiting-review"); assert.equal(calls.some(item => item[0] === "publish"), false);
    await assert.rejects(controller.approve(done.id, { expectedRevision: done.revision, approvedDigest: sha, requestId: "wrong" }), error => error.code === "evolution_approval_digest_mismatch");
    const receipt = await controller.approve(done.id, { expectedRevision: done.revision, approvedDigest: done.review.digest, requestId: "explicit" }); assert.ok(receipt.publication, receipt.error); assert.equal(receipt.publication.status, "active");
    await controller.approve(done.id, { expectedRevision: done.revision, approvedDigest: done.review.digest, requestId: "explicit" }); assert.equal(calls.filter(item => item[0] === "publish").length, 1);
  }, { evaluate: async context => {
    const previous = await fake.ports.evaluate(context), candidate = context.attempt.candidate;
    const body = { schemaVersion: 1, validationId: candidate.validationId, evaluationId: "evaluation-one", artifactDigest: candidate.artifactDigest, candidateDigest: candidate.candidateDigest, snapshotDigest: candidate.snapshotDigest, evidenceDigest: sha, deploymentDigest: sha, managementRevision: "rev-one", overlayDigest: sha, previousOverlay: [], target: { parentId: "root", entryId: "prompt" }, previousEntry: null, reviewer: "host", reason: "Independent review", trust: "trusted-in-process" };
    return { ...previous, decision: "accepted", candidateScore: 1, baselineScore: 0, review: { ...body, digest: digest(body) } };
  } }, { evaluationMode: "external", datasetDigest: sha });
});
test("Finite timeout preserves an uncertain operation and prevents late mutation", async () => {
  const gate = deferred(); let entered;
  await fixture(async ({ controller, campaign }) => {
    const done = await controller.run(campaign.id); assert.equal(done.state, "reconciliation-required"); assert.match(done.error, /timeout/);
    gate.resolve(await makePorts().ports.generate(entered)); await tick(); assert.equal((await controller.get(done.id)).revision, done.revision);
  }, { generate: async context => { entered = context; return gate.promise; } }, { budget: { modelCalls: 10, tokens: 1000, costByCurrency: {}, timeoutMs: 30 } });
});
test("Storage namespace persists revisions across owner instances and releases its own lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-evolution-store-")); let releases = 0;
  const kv = new FileKvStorageBackend({ backendId: "evolution-test", rootDirectory: root });
  const backend = { id: "evolution-test", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv };
  const lease = () => ({ id: backend.id, released: false, backend: () => backend, resolve: () => kv, acquire: () => lease(), release() { if (this.released) return false; this.released = true; releases++; return true; } });
  const first = new StorageEvolutionStore(lease()), second = new StorageEvolutionStore(lease());
  const controller = new EvolutionController({ store: first, ports: makePorts().ports });
  try {
    const created = await controller.create(spec(), "durable"); const loaded = await second.read(created.id); assert.deepEqual(loaded, created);
    const updated = await first.compareAndSwap(created.id, created.revision, { ...created, revision: 2, state: "paused" });
    await assert.rejects(second.compareAndSwap(created.id, 1, { ...created, revision: 2 }), error => error.code === "evolution_conflict");
    assert.equal((await second.list())[0].revision, updated.revision); assert.equal((await kv.list({ namespace: "evolution/campaigns/v1" })).length, 1);
  } finally { await controller.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  assert.equal(releases, 2);
});
test("Strict spec context rejects arbitrary keys and deferred mode requires no dataset", () => {
  assert.equal(validateSpec(spec()).evaluationMode, "deferred");
  assert.throws(() => validateSpec(spec({ evaluationMode: "external" })), error => error.code === "evolution_external_dataset_required");
  assert.throws(() => validateSpec(spec({ context: { foreignWorkspace: "/private" } })), error => error.code === "evolution_invalid_context_key");
});
test("External mode without an evaluator still records feedback and waits without a verdict", () => fixture(async ({ controller, campaign }) => {
  const done = await controller.run(campaign.id); assert.equal(done.state, "awaiting-external-validation");
  assert.ok(done.attempts[0].feedback); assert.equal(done.attempts[0].verdict, undefined); assert.equal(done.nonImprovingRounds, 0);
}, { evaluate: undefined }, { evaluationMode: "external", datasetDigest: sha }));
test("Retirement fences synchronously, drains only owned calls, and concurrent close shares completion", async () => {
  const gate = deferred(); let entered; const fake = makePorts({ generate: async context => { entered = context; return gate.promise; } });
  let released = false; const store = new MemoryEvolutionStore(); store.close = async () => { released = true; };
  const controller = new EvolutionController({ store, ports: fake.ports }); const campaign = await controller.create(spec(), "retirement");
  const run = controller.run(campaign.id); await waitFor(() => !!entered);
  controller.suspend(); await run; assert.equal(released, false); assert.equal(fake.cleanups.length, 0);
  await assert.rejects(controller.run(campaign.id), error => error.code === "evolution_closed");
  const first = controller.close(), second = controller.close(); assert.equal(first, second);
  await tick(); assert.equal(released, false);
  gate.resolve(await makePorts().ports.generate(entered)); await first;
  assert.equal(released, true); assert.deepEqual(fake.cleanups, [entered.attempt.id]); assert.equal((await store.read(campaign.id)).state, "interrupted");
});
test("The final allowed generation still completes its Host checks and feedback", () => fixture(async ({ controller, campaign, calls }) => {
  let current = campaign;
  for (let round = 1; round <= 3; round++) {
    current = await controller.run(current.id); assert.equal(current.state, "awaiting-external-validation", current.error);
    assert.equal(current.attempts.at(-1).candidate.validationId, `validation-${round}`); assert.ok(current.attempts.at(-1).feedback);
    if (round < 3) current = await controller.continue(current.id, { expectedRevision: current.revision, requestId: `human-${round}`, feedback: `Change ${round}` });
  }
  assert.equal(calls.filter(item => item[0] === "generate").length, 3); assert.equal(current.usage.modelCalls, 3);
  await assert.rejects(controller.continue(current.id, { expectedRevision: current.revision, requestId: "one-too-many", feedback: "Again" }), error => error.code === "evolution_budget_exhausted");
}, {}, { budget: { modelCalls: 3, tokens: 1000, costByCurrency: {}, timeoutMs: 5000 } }));
test("A failed model-consuming operation exposes incomplete usage rather than a complete zero", () => fixture(async ({ controller, campaign }) => {
  const current = await controller.run(campaign.id); assert.equal(current.state, "reconciliation-required");
  assert.equal(current.usage.complete, false); assert.equal(current.attempts[0].operations.at(-1).status, "pending");
  const cancelled = await controller.cancel(current.id); assert.equal(cancelled.usage.complete, false);
}, { generate: async () => { throw new Error("usage consumed before invalid model JSON"); } }));
test("Retirement during durable run admission cannot start a new external stage", async () => {
  const gate = deferred(); let entered = false; const store = new MemoryEvolutionStore(), original = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (id, revision, value) => { if (value.state === "running") { entered = true; await gate.promise; } return original(id, revision, value); };
  const fake = makePorts(), controller = new EvolutionController({ store, ports: fake.ports });
  const campaign = await controller.create(spec(), "retirement-admission"), running = controller.run(campaign.id); await waitFor(() => entered);
  controller.suspend(); gate.resolve(); const current = await running;
  assert.equal(current.state, "interrupted"); assert.equal(fake.calls.length, 0); await controller.close();
});
test("Pausing and resuming a ready candidate does not silently open another round", () => fixture(async ({ controller, campaign, calls }) => {
  const ready = await controller.run(campaign.id); const paused = await controller.pause(ready.id);
  const resumed = await controller.resume(paused.id); assert.equal(resumed.state, "awaiting-external-validation");
  assert.equal(resumed.attempts.length, 1); assert.equal(calls.filter(item => item[0] === "generate").length, 1);
}));
test("Ticket digests and references must belong to exactly the selected source traces", async () => {
  const trace = (id, hash, sourceKind = "production") => ({ id, digest: hash, sourceKind, runId: `run-${id}`, terminalStatus: "run.failed", taskOutcome: "unknown", evidenceRefs: [`source:${id}`], summary: "Failure evidence", capturedAt: "2026-10-22T00:00:00.000Z" });
  const evidence = (mutation = {}) => ({ traces: [trace("one", sha), trace("two", bsha)], tickets: [{ id: "ticket", traceIds: ["one"], traceDigests: [sha], failureCategory: "unknown", evidenceRefs: ["source:one"], summary: "Investigate", problem: "Failure", hypothesis: "Unknown cause", target: "prompt", confidence: 0, ...mutation }], usage: local });
  for (const invalid of [evidence({ traceDigests: [bsha] }), evidence({ evidenceRefs: ["source:two"] }), { ...evidence(), traces: [trace("one", sha, "evolution"), trace("two", bsha)] }]) {
    await fixture(async ({ controller, campaign, calls }) => {
      const current = await controller.run(campaign.id); assert.equal(current.state, "reconciliation-required");
      assert.match(current.error, /trace_digest_mismatch|reference_mismatch|self_evidence_forbidden/); assert.equal(calls.some(item => item[0] === "generate"), false);
    }, { evidence: async () => invalid });
  }
});
