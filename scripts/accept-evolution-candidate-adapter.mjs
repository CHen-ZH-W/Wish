import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

const root = new URL(process.env.WISH_EVOLUTION_TEST_MODULE_ROOT ?? "../dist/evolution/", import.meta.url);
const { createCandidateEvolutionPorts } = await import(new URL("adapters/candidates.js", root));
const { promptCandidate } = await import(new URL("generator.js", root));
const { createEvaluationRequest, validateEvaluationRequest, validateEvaluationReceipt, evaluationStatus } = await import(new URL("external-evaluation.js", root));
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const SHA = "a".repeat(64), ARTIFACT = "b".repeat(64), SNAPSHOT = "c".repeat(64);
const LOCAL_USAGE = { modelCalls: 0, tokens: 0, costByCurrency: {}, complete: true };

function setup() {
  const source = promptCandidate({ id: "evolved-fixture", version: 1, content: "Inspect the existing task evidence before editing.", purpose: "Test technical candidate admission", runId: "attempt-1" });
  const profile = { schemaVersion: 1, id: "baseline", version: 7, description: "Fixed baseline", model: "fixture/a", tools: ["read"], permissionProfile: "read-only", memory: "none", instructions: "Keep this exact recipe.", reasoningEffort: "low", request: { temperature: 0.2, maxOutputTokens: 128 }, maxParallelCalls: 2, reservedOutputTokens: 256, compaction: { strategyId: "model-summary-v1", keepRecentTokens: 256, summaryMaxOutputTokens: 128 } };
  const baseline = { digest: SHA, definition: profile };
  const calls = { submit: 0, validate: 0, verify: 0, promote: 0, reconcile: 0 };
  const history = { validations: [], evaluations: [], promotions: [] };
  const context = { campaign: { id: "campaign-1", spec: { baselineSnapshotDigest: SHA, allowedTargets: ["prompt"], context: { parentId: "app", entryId: "generated-fixture" }, evaluationMode: "deferred" } },
    attempt: { id: "attempt-1", round: 1, proposal: { id: "proposal-1", target: "prompt", source, ticketIds: ["ticket-1"], rationale: "A bounded hypothesis", usage: LOCAL_USAGE } }, operationId: "candidate-operation", signal: new AbortController().signal };
  const candidates = {
    async submit(value) { calls.submit++; assert.deepEqual(value, source); return { digest: hash(value), source: value }; },
    async validate(input) { calls.validate++; const record = { schemaVersion: 1, id: "validation-1", ...input, status: "passed", artifactDigest: ARTIFACT, snapshotDigest: SNAPSHOT }; history.validations.push(record); return record; },
    async verifySnapshot(snapshot) { calls.verify++; assert.equal(snapshot.digest, SNAPSHOT); },
    async history() { return structuredClone(history); },
    async promote(review, approvedDigest) { calls.promote++; assert.equal(review.digest, approvedDigest); return { id: "promotion-1", review, status: "active" }; },
    async reconcile(id) { calls.reconcile++; return history.promotions.find(item => item.id === id); },
  };
  const options = { candidates, agentProfiles: { async get(key) { return key === SHA ? baseline : { digest: SNAPSHOT }; } }, evidence: async () => ({ traces: [], tickets: [], usage: LOCAL_USAGE }), generate: async () => context.attempt.proposal };
  return { context, profile, baseline, source, candidates, options, calls, history, ports: createCandidateEvolutionPorts(options) };
}

test("versioned external requests and receipts remain unscored transport evidence", () => {
  const request = createEvaluationRequest({ id: "request-1", campaignId: "campaign-1", attemptId: "attempt-1", baselineSnapshotDigest: SHA, candidateDigest: SHA, validationId: "validation-1", artifactDigest: ARTIFACT, snapshotDigest: SNAPSHOT, requestedAt: "2026-10-22T12:00:00Z" });
  assert.equal(evaluationStatus().status, "not-requested");
  assert.equal(evaluationStatus({ request }).status, "waiting-external");
  assert.equal(validateEvaluationRequest(request).digest, request.digest);
  const receipt = { schemaVersion: 1, id: "receipt-1", requestId: request.id, requestDigest: request.digest, evaluator: { id: "external-machine", version: "1.0.0" }, completedAt: "2026-10-22T12:01:00Z", outcome: "inconclusive", evidenceDigest: SHA, evidenceRefs: ["external:report-1"], summary: "Independent report received; no publication decision." };
  assert.equal(evaluationStatus({ request, receipt }).status, "completed");
  assert.equal("baselineScore" in receipt, false);
  assert.throws(() => evaluationStatus({ receipt }), { code: "evolution_evaluation_request_required" });
  assert.throws(() => validateEvaluationReceipt({ ...receipt, requestDigest: ARTIFACT }, request), { code: "evolution_evaluation_request_mismatch" });
  assert.throws(() => validateEvaluationReceipt({ ...receipt, completedAt: "2026-10-21T12:00:00Z" }, request), { code: "evolution_evaluation_time_mismatch" });
  assert.throws(() => validateEvaluationReceipt({ ...receipt, evidenceRefs: [] }, request), { code: "evolution_evaluation_evidence_required" });
  assert.throws(() => validateEvaluationReceipt({ ...receipt, review: {} }, request));
  assert.throws(() => validateEvaluationRequest({ ...request, candidateDigest: ARTIFACT }), { code: "evolution_evaluation_request_changed" });
  assert.throws(() => validateEvaluationRequest({ ...request, schemaVersion: 2 }), { code: "evolution_evaluation_schema_invalid" });
});

test("deferred candidate admission freezes the baseline recipe and records pending effect feedback", async () => {
  const f = setup();
  assert.equal(f.ports.evaluate, undefined);
  const receipt = await f.ports.candidate(f.context);
  assert.equal(receipt.candidateDigest, hash(f.source));
  const definition = f.history.validations[0].profile;
  const { id, version, ...semantics } = definition;
  const { id: baseId, version: baseVersion, ...baseSemantics } = f.profile;
  assert.notEqual(id, baseId); assert.equal(version, 1); assert.deepEqual(semantics, baseSemantics);
  assert.deepEqual(f.history.validations[0].target, { parentId: "app", entryId: "generated-fixture" });
  f.context.attempt.candidate = receipt;
  const feedback = await f.ports.feedback(f.context);
  assert.match(feedback.summary, /has not requested or run effect evaluation/u);
  assert.equal("baselineScore" in feedback, false);
  assert.deepEqual(feedback.usage, LOCAL_USAGE);
  assert.deepEqual(f.calls, { submit: 1, validate: 1, verify: 0, promote: 0, reconcile: 0 });
});

test("candidate reconciliation observes exact admission identity without replaying work", async () => {
  const f = setup(), operation = { id: f.context.operationId, stage: "candidate", status: "pending" };
  assert.equal(await f.ports.reconcile(f.context, operation), undefined);
  await f.ports.candidate(f.context);
  const recovered = await f.ports.reconcile(f.context, operation);
  assert.equal(recovered.validationId, "validation-1"); assert.equal(f.calls.validate, 1); assert.equal(f.calls.verify, 1);
  f.history.validations[0].profile = { ...f.history.validations[0].profile, instructions: "Different recipe" };
  assert.equal(await f.ports.reconcile(f.context, operation), undefined);
  assert.equal(f.calls.validate, 1);
});

test("failed, ambiguous and cancelled candidate work cannot produce success receipts", async () => {
  const f = setup();
  const diagnostics = `plugin_architecture_core_boundary: ${"detail ".repeat(1_000)}`;
  const failed = createCandidateEvolutionPorts({ ...f.options, candidates: { ...f.candidates, async validate() { return { status: "failed", error: diagnostics }; } } });
  await assert.rejects(failed.candidate(f.context), { code: "evolution_candidate_validation_failed", message: diagnostics.slice(0, 4_000) });
  await f.ports.candidate(f.context); f.history.validations.push(structuredClone(f.history.validations[0]));
  assert.equal(await f.ports.reconcile(f.context, { id: f.context.operationId, stage: "candidate" }), undefined);
  await assert.rejects(f.ports.candidate({ ...f.context, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/u);
  assert.equal(f.calls.validate, 1);
});

function withReview(f) {
  const candidate = f.context.attempt.candidate;
  const body = { schemaVersion: 1, validationId: candidate.validationId, evaluationId: "evaluation-1", artifactDigest: candidate.artifactDigest, candidateDigest: candidate.candidateDigest, snapshotDigest: candidate.snapshotDigest,
    evidenceDigest: SHA, deploymentDigest: SHA, managementRevision: "revision-1", overlayDigest: SHA, previousOverlay: [], target: { parentId: "app", entryId: "generated-fixture" }, previousEntry: null,
    reviewer: "host-reviewer", reason: "Approved with existing candidate evidence", trust: "trusted-in-process" };
  f.context.campaign.review = { ...body, digest: hash(body) };
  return f.context.campaign.review;
}

test("formal publication requires an exact real CandidateReview and delegates existing checks", async () => {
  const f = setup(); f.context.attempt.candidate = await f.ports.candidate(f.context);
  await assert.rejects(f.ports.publish(f.context, SHA), { code: "evolution_review_required" });
  const review = withReview(f);
  await assert.rejects(f.ports.publish(f.context, SHA), { code: "evolution_review_identity_mismatch" });
  assert.equal(f.calls.promote, 0);
  const published = await f.ports.publish(f.context, review.digest);
  assert.equal(published.status, "active"); assert.equal(published.approvedDigest, review.digest); assert.equal(f.calls.promote, 1);
});

test("publication recovery consults durable Root reconciliation and never republishes", async () => {
  const f = setup(); f.context.attempt.candidate = await f.ports.candidate(f.context);
  const review = withReview(f);
  const operation = { id: "publish-operation", stage: "publish", status: "pending" };
  assert.equal(await f.ports.reconcile(f.context, operation), undefined);
  f.history.promotions.push({ id: "promotion-1", review, status: "active" });
  assert.equal((await f.ports.reconcile(f.context, operation)).status, "active");
  assert.equal(f.calls.promote, 0); assert.equal(f.calls.reconcile, 1);
  f.candidates.reconcile = async () => { throw Object.assign(new Error("unknown"), { code: "candidate_reconciliation_ambiguous" }); };
  assert.equal(await f.ports.reconcile(f.context, operation), undefined);
  assert.equal(f.calls.promote, 0);
});
