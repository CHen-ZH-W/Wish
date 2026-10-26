import test from "node:test";
import assert from "node:assert/strict";
import { EvolutionController } from "../dist/evolution/controller.js";
import { MemoryEvolutionStore } from "../dist/evolution/store.js";
import { MemoryEvolutionOperationJournal, journalEvolutionPorts } from "../dist/evolution/journal.js";
import { digest } from "../dist/evolution/validation.js";
import { promptCandidate, LOCAL_USAGE } from "../dist/evolution/generator.js";
const sha = "a".repeat(64), usage = { modelCalls: 1, tokens: 12, costByCurrency: { CNY: null }, complete: true };
const spec = { objective: "Clarify recovery", baselineSnapshotDigest: sha, allowedTargets: ["prompt"], maxRounds: 3, patience: 3, budget: { modelCalls: 5, tokens: 1000, costByCurrency: {}, timeoutMs: 10000 } };
function ports(overrides = {}) {
  return { evidence: async () => ({ traces: [], tickets: [{ id: "ticket", traceIds: [], traceDigests: [], evidenceRefs: [], failureCategory: "unknown", target: "prompt", confidence: 0, problem: "Uncertain recovery", summary: "Manual request", hypothesis: "Check operation receipts" }], usage: LOCAL_USAGE }),
    generate: async context => ({ id: `proposal-${context.attempt.round}`, ticketIds: ["ticket"], target: "prompt", rationale: "Preserve uncertainty", source: promptCandidate({ id: "recovery", version: context.attempt.round, content: "Inspect the operation receipt.", purpose: "Recovery", runId: context.attempt.id }), usage }),
    candidate: async context => ({ candidateDigest: digest(context.attempt.proposal.source), validationId: "validation", artifactDigest: sha, snapshotDigest: sha, usage: LOCAL_USAGE }),
    feedback: async () => ({ id: "feedback", summary: "Technical result only", evidenceRefs: [], usage: LOCAL_USAGE }), ...overrides };
}
test("durable generation acknowledgement recovers a paused late receipt without repeating the model", async () => {
  const store = new MemoryEvolutionStore(), journal = new MemoryEvolutionOperationJournal();
  let release, entered, calls = 0;
  const inside = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const raw = ports(), wrapped = journalEvolutionPorts(ports({ generate: async context => { calls++; entered(); await gate; return raw.generate(context); } }), journal);
  const controller = new EvolutionController({ store, ports: wrapped });
  try {
    const created = await controller.create(spec, "late");
    const running = controller.run(created.id); await inside;
    const paused = await controller.pause(created.id); release(); await running;
    for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve));
    const recovered = await controller.recover(created.id, { expectedRevision: paused.revision });
    assert.equal(recovered.state, "waiting-input");
    const done = await controller.run(created.id);
    assert.equal(done.state, "awaiting-external-validation"); assert.equal(calls, 1); assert.equal(done.usage.tokens, 12);
  } finally { release(); await controller.close(); }
});
test("confirmed failed generation records its billed usage and explicit feedback starts a new attempt", async () => {
  let calls = 0; const raw = ports();
  const wrapped = journalEvolutionPorts(ports({ generate: async context => { calls++; if (calls === 1) throw new Error("Malformed model output"); return raw.generate(context); } }), new MemoryEvolutionOperationJournal(), async (_context, stage) => stage === "generate" ? usage : undefined);
  const controller = new EvolutionController({ store: new MemoryEvolutionStore(), ports: wrapped });
  try {
    const created = await controller.create(spec, "failed"); const failed = await controller.run(created.id);
    assert.equal(failed.state, "failed"); assert.equal(failed.attempts[0].operations.at(-1).status, "failed"); assert.equal(failed.usage.modelCalls, 1);
    const waiting = await controller.continue(created.id, { expectedRevision: failed.revision, requestId: "repair", feedback: "Produce valid JSON" });
    const done = await controller.run(waiting.id);
    assert.equal(done.state, "awaiting-external-validation"); assert.equal(done.attempts.length, 2); assert.equal(done.attempts[1].parentAttemptId, done.attempts[0].id);
    assert.equal(done.usage.modelCalls, 2); assert.equal(done.usage.tokens, 24);
  } finally { await controller.close(); }
});
test("unknown generation results remain fenced, and incomplete billing prevents a new attempt", async () => {
  const controller = new EvolutionController({ store: new MemoryEvolutionStore(), ports: journalEvolutionPorts(ports({ generate: async () => { throw new Error("Lost transport"); } }), new MemoryEvolutionOperationJournal()) });
  try {
    const created = await controller.create(spec, "unknown"), failed = await controller.run(created.id);
    assert.equal(failed.state, "reconciliation-required");
    assert.equal((await controller.recover(created.id)).state, "reconciliation-required");
    await assert.rejects(controller.continue(created.id, { expectedRevision: (await controller.get(created.id)).revision, requestId: "unsafe", feedback: "Retry" }), /evolution_continue_state/);
  } finally { await controller.close(); }
});
test("identical candidate content stops before another technical validation while preserving generation cost", async () => {
  let checks = 0; const raw = ports();
  const controller = new EvolutionController({ store: new MemoryEvolutionStore(), ports: ports({ candidate: async context => { checks++; return raw.candidate(context); } }) });
  try {
    const created = await controller.create(spec, "duplicate"), first = await controller.run(created.id);
    await controller.continue(created.id, { expectedRevision: first.revision, requestId: "change", feedback: "Try a different hypothesis" });
    const done = await controller.run(created.id);
    assert.equal(done.state, "completed"); assert.equal(done.stopReason, "duplicate-candidate"); assert.equal(checks, 1); assert.equal(done.usage.modelCalls, 2);
    assert.equal(done.attempts[1].duplicateOf, done.attempts[0].id); assert.equal(done.bestScore, undefined);
  } finally { await controller.close(); }
});
