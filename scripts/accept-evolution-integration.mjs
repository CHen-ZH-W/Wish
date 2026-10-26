import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, base } from "./fixtures/candidates.mjs";
import { EvolutionController } from "../dist/evolution/controller.js";
import { StorageEvolutionStore } from "../dist/evolution/store.js";
import { LOCAL_USAGE, ModelEvolutionGenerator, promptCandidate } from "../dist/evolution/generator.js";
import { createCandidateEvolutionPorts } from "../dist/evolution/adapters/candidates.js";
import { digest } from "../dist/agent-profiles/validation.js";

const SECTION = "Check committed operation evidence before retrying a failed task. Preserve unknown outcomes.";
const RESPONSE = "ordinary-main-run-ok";
const measuredUsage = { inputTokens: 24, outputTokens: 16, totalTokens: 40 };

function modelResponse(content) {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 16, total_tokens: 40 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

async function ordinaryRun(ctx, directory) {
  const app = await ctx.get("application").open({ maxRunSteps: 2 });
  try {
    const session = await app.createSession({ workspaceRoot: directory });
    const handle = await app.startRun({ sessionId: session.sessionId, inputSource: "user", payload: { text: "Reply with the normal main-task result." } });
    const completion = await handle.completion;
    assert.equal(completion.status, "completed", completion.snapshot.error?.message);
    const history = await app.readSessionHistory({ sessionId: session.sessionId });
    const output = history.records.filter(item => item.kind === "message" && item.message.role === "assistant").at(-1);
    assert.equal(output?.message.content, RESPONSE);
  } finally { await app.runGeneration?.retire(); }
}

function openStore(ctx) {
  const storage = ctx.get("storageBackend");
  return new StorageEvolutionStore(storage.acquire(storage.id, { kv: { list: true } }));
}

function assertDeferred(campaign, diagnostics = "") {
  assert.equal(campaign.state, "awaiting-external-validation", [campaign.error, diagnostics].filter(Boolean).join("\n"));
  assert.equal(campaign.stopReason, "technical-candidate-ready");
  assert.equal(campaign.attempts.length, 1);
  const attempt = campaign.attempts[0];
  assert.deepEqual(attempt.operations.map(item => item.stage), ["evidence", "generate", "candidate", "feedback"]);
  assert.ok(attempt.operations.every(item => item.status === "completed"));
  assert.ok(attempt.candidate?.artifactDigest); assert.ok(attempt.candidate?.snapshotDigest);
  assert.equal(attempt.verdict, undefined); assert.equal(campaign.bestScore, undefined);
  assert.equal(campaign.review, undefined); assert.equal(campaign.publication, undefined);
  assert.equal("baselineScore" in attempt, false); assert.equal("candidateScore" in attempt, false);
  return attempt;
}

test("real confined prompt admission persists a deferred campaign without evaluation or publication", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-integration-"));
  const originalFetch = globalThis.fetch;
  let host, controller, reopened;
  const ordinaryRequests = [];
  globalThis.fetch = async (_url, init) => { ordinaryRequests.push(JSON.parse(init.body)); return modelResponse(RESPONSE); };
  try {
    host = await boot(directory, { WISH_EVOLUTION_ENABLED: "0" });
    let ctx = host.surfaceContext;
    const baseline = await base(ctx);
    const beforeSections = ctx.get("systemPrompt").capture();
    const models = [];
    // Only the model Port is deterministic. Build, node:test, Loader admission,
    // lifecycle verification and unload use the production Linux CandidateRunner.
    const generator = new ModelEvolutionGenerator(async () => ({
      reference: baseline.model,
      model: { async *stream(request, signal) {
        signal?.throwIfAborted(); models.push(request);
        yield { type: "start", model: request.model };
        yield { type: "text_delta", text: JSON.stringify({ content: SECTION, rationale: "A bounded recovery hypothesis requiring independent future evaluation." }) };
        yield { type: "done", usage: measuredUsage };
      } },
    }));
    const ports = createCandidateEvolutionPorts({ candidates: ctx.get("candidates"), agentProfiles: ctx.get("agentProfiles"),
      evidence: async context => ({ traces: [], tickets: [{ id: "manual-request", traceIds: [], traceDigests: [], failureCategory: "unknown", evidenceRefs: [],
        summary: "Explicit user improvement request", problem: context.campaign.spec.objective,
        hypothesis: "A prompt section may improve recovery; this is untested", target: "prompt", confidence: 0 }], usage: LOCAL_USAGE }),
      generate: context => generator.generate(context),
    });
    let forbiddenCalls = 0;
    const experiments = ctx.get("experiments"), candidates = ctx.get("candidates");
    const originalStart = experiments.start, originalEvaluate = candidates.evaluate;
    experiments.start = candidates.evaluate = async () => { forbiddenCalls++; throw new Error("Deferred generation must not start effect evaluation"); };
    try {
      controller = new EvolutionController({ store: openStore(ctx), ports });
      const created = await controller.create({ objective: "Improve failed-operation recovery guidance", baselineSnapshotDigest: baseline.digest,
        allowedTargets: ["prompt"], evaluationMode: "deferred", maxRounds: 1, patience: 1,
        budget: { modelCalls: 2, tokens: 2048, costByCurrency: {}, timeoutMs: 120_000 },
        context: { workspaceRoot: directory, parentId: "app", entryId: "evolved-recovery-guidance" },
      }, "integration-request");
      const done = await controller.run(created.id);
      const attempt = assertDeferred(done, JSON.stringify((await candidates.history()).validations.map(item => ({ id: item.id, status: item.status, error: item.error }))));
      assert.equal(models.length, 1); assert.deepEqual(models[0].tools, []);
      assert.equal(models[0].invocationScope.runId, attempt.id);
      assert.deepEqual(models[0].model, baseline.model);
      assert.equal(done.usage.modelCalls, 1); assert.equal(done.usage.tokens, measuredUsage.totalTokens);
      assert.equal(forbiddenCalls, 0);

      const expected = promptCandidate({ id: `evolved-${digest({ campaign: done.id, target: "prompt" }).slice(0, 24)}`,
        version: 1, content: SECTION, purpose: done.spec.objective, runId: attempt.id });
      assert.deepEqual(attempt.proposal.source, expected);
      assert.equal(attempt.candidate.candidateDigest, digest(expected));
      const history = await candidates.history();
      const validation = history.validations.find(item => item.id === attempt.candidate.validationId);
      assert.equal(validation.status, "passed", validation.error);
      assert.equal(validation.checks.typecheck, "passed"); assert.equal(validation.checks.build, "passed");
      assert.equal(validation.checks.tests.passed, 1); assert.equal(validation.checks.tests.failed, 0);
      for (const name of ["activation", "interfaces", "ownership", "unload"]) assert.equal(validation.checks[name], "passed");
      assert.equal(history.evaluations.length, 0); assert.equal(history.promotions.length, 0);
      assert.equal((await experiments.list()).length, 0);
      const artifactRoot = candidates.artifactPath(attempt.candidate.artifactDigest);
      const admission = JSON.parse(await readFile(join(artifactRoot, "admission.json"), "utf8"));
      assert.equal(admission.sourceDigest, attempt.candidate.candidateDigest);
      assert.equal(admission.digest, validation.admissionDigest);
      const candidateSnapshot = await ctx.get("agentProfiles").get(attempt.candidate.snapshotDigest);
      assert.equal(candidateSnapshot.candidate.artifactDigest, attempt.candidate.artifactDigest);
      await candidates.verifySnapshot(candidateSnapshot);
      await assert.rejects(ctx.get("application").open({ agentProfile: candidateSnapshot.digest }), { code: "profile_candidate_requires_sandbox" });
      assert.deepEqual(ctx.get("systemPrompt").capture(), beforeSections, "Candidate compilation and validation must not register its Prompt in the production Host");
      await assert.rejects(controller.approve(done.id, { expectedRevision: done.revision, requestId: "not-approved", approvedDigest: "a".repeat(64) }), { code: "evolution_approval_digest_mismatch" });

      await controller.close(); controller = undefined;
      assert.deepEqual(ctx.get("systemPrompt").capture(), beforeSections);
      await ordinaryRun(ctx, directory);
      assert.equal(ordinaryRequests.length, 1);
      assert.equal(ordinaryRequests[0].messages.some(item => typeof item.content === "string" && item.content.includes(SECTION)), false);

      // Dispose and reboot the entire Host, rather than only reopening an in-memory store.
      experiments.start = originalStart; candidates.evaluate = originalEvaluate;
      await host.dispose(); host = await boot(directory, { WISH_EVOLUTION_ENABLED: "0" }); ctx = host.surfaceContext;
      reopened = new EvolutionController({ store: openStore(ctx), ports });
      const persisted = await reopened.get(done.id);
      assert.deepEqual(persisted, done);
      assertDeferred(persisted);
      assert.equal((await ctx.get("candidates").history()).validations.find(item => item.id === validation.id).status, "passed");
      assert.equal((await ctx.get("candidates").history()).promotions.length, 0);
      assert.deepEqual(ctx.get("systemPrompt").capture(), beforeSections);
      await assert.rejects(reopened.run(done.id), { code: "evolution_run_state" });
    } finally { experiments.start = originalStart; candidates.evaluate = originalEvaluate; }
  } finally {
    globalThis.fetch = originalFetch;
    await reopened?.close(); await controller?.close(); await host?.dispose();
    if (process.env.WISH_EVOLUTION_KEEP_TEST_DATA === "1") process.stderr.write(`Evolution integration data retained: ${directory}\n`);
    else await rm(directory, { recursive: true, force: true });
  }
});

test("optional Evolution service uses its configured pipeline while ordinary Runs stay independent", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-feature-"));
  const originalFetch = globalThis.fetch;
  let host;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const generation = request.messages.some(item => typeof item.content === "string" && item.content.includes("Propose a bounded Wish Harness improvement."));
    return modelResponse(generation ? JSON.stringify({ content: SECTION, rationale: "A generated, technically validated and still unmeasured prompt hypothesis." }) : RESPONSE);
  };
  try {
    host = await boot(directory, { WISH_EVOLUTION_ENABLED: "1" });
    const ctx = host.surfaceContext, evolution = ctx.get("evolution");
    assert.ok(evolution, "WISH_EVOLUTION_ENABLED=1 must load the optional Evolution service");
    assert.equal(evolution.available, true);
    const beforeSections = ctx.get("systemPrompt").capture();
    const created = await evolution.begin({ objective: "Improve operation recovery guidance", requestId: "feature-request", workspaceRoot: directory, target: "prompt" });
    const done = await evolution.waitFor(created.id);
    const attempt = assertDeferred(done, JSON.stringify((await ctx.get("candidates").history()).validations.map(item => ({ id: item.id, status: item.status, error: item.error }))));
    assert.equal((await ctx.get("candidates").history()).validations.find(item => item.id === attempt.candidate.validationId).status, "passed");
    assert.equal((await ctx.get("experiments").list()).length, 0);
    assert.equal((await ctx.get("candidates").history()).evaluations.length, 0);
    assert.equal((await ctx.get("candidates").history()).promotions.length, 0);
    assert.deepEqual(ctx.get("systemPrompt").capture(), beforeSections);
    assert.equal(requests.length, 1);
    await evolution.controller.close();
    await ordinaryRun(ctx, directory);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.some(item => typeof item.content === "string" && item.content.includes(SECTION)), false);
  } finally {
    globalThis.fetch = originalFetch; await host?.dispose();
    if (process.env.WISH_EVOLUTION_KEEP_TEST_DATA === "1") process.stderr.write(`Evolution feature data retained: ${directory}\n`);
    else await rm(directory, { recursive: true, force: true });
  }
});
