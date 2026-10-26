import test from "node:test";
import assert from "node:assert/strict";
import { captureTaskTrace, validateTrace, diagnoseTraces } from "../dist/evolution/observations.js";
import { ModelEvolutionGenerator, promptCandidate } from "../dist/evolution/generator.js";
import { digest } from "../dist/agent-profiles/validation.js";
import { experimentDeployment } from "../dist/agent-profiles/composition.js";

const sha = "a".repeat(64), at = "2026-10-22T01:00:00.000Z";
test("Worker composition excludes explicitly marked Host controls and selects CLI from a frozen WebUI deployment", () => {
  const original = [{ id: "control", name: "file:///custom/independent-owner.js", experiment: "exclude", disabled: false },
    { id: "cli", name: "file:///release/apps/cli/plugin.js", disabled: true },
    { id: "webui", name: "file:///release/apps/webui/plugin.js", disabled: false },
    { id: "business", name: "file:///custom/business.js", disabled: false, config: { policy: "fixed" } }];
  const rows = JSON.parse(experimentDeployment(original, "/isolated"));
  assert.equal(rows[0].disabled, true); assert.equal(rows[1].disabled, false); assert.equal(rows[2].disabled, true);
  assert.deepEqual(rows[3].config, original[3].config); assert.equal(original[0].disabled, false);
});
function capture(runId, outcome, sourceKind = "production", reason) {
  return captureTaskTrace({ sessionId: "session", runId,
    history: { sessionId: "session", historyRevision: "history-1", records: [{ schemaVersion: 1, kind: "message", recordId: "record", sequence: 1, idempotencyKey: "message-1", runId, userTurnId: "turn", stepId: "step", origin: "agent", createdAt: at,
      message: { role: "assistant", content: "All tests passed, according to the assistant." } }] },
    events: [{ schemaVersion: 1, type: "run.opened", runId, scope: "session", occurredAt: at }, ...(reason ? [{ schemaVersion: 1, type: "tool.failed", runId, occurredAt: at, reason }] : []), { schemaVersion: 1, type: "run.completed", runId, occurredAt: at }], attempts: [],
    ...(outcome ? { outcome: { runId, taskId: runId, verifierId: "trusted-check", verifierVersion: 1, result: outcome, sourceKind, evidenceDigest: sha } } : { sourceKind }),
  });
}
test("committed completion and assistant prose never manufacture an independent task result", () => {
  const unknown = capture("run-1"); assert.equal(unknown.taskOutcome, "unknown"); assert.equal(validateTrace(unknown).digest, unknown.digest);
  const failed = capture("run-1", "failed"); assert.equal(failed.taskOutcome, "failed"); assert.notEqual(failed.digest, unknown.digest);
  assert.throws(() => validateTrace({ ...failed, taskOutcome: "passed" }), /digest/);
  assert.throws(() => captureTaskTrace({ sessionId: "s", runId: "r", history: { sessionId: "s", records: [] }, events: [], attempts: [] }), /committed_terminal/);
});
test("aggregation requires independent tasks and excludes held-out/evolution evidence", () => {
  const one = capture("r1", "failed"), two = capture("r2", "failed"), three = capture("r3", "failed");
  assert.equal(diagnoseTraces([one, one, one]).length, 0);
  assert.equal(diagnoseTraces([one, two, three]).length, 1);
  assert.equal(diagnoseTraces([one, two, capture("r3", "failed", "held-out")]).length, 0);
  const environment = ["n1", "n2", "n3"].map(id => capture(id, "failed", "production", "network_unavailable"));
  assert.equal(diagnoseTraces(environment)[0].failureCategory, "environment");
  assert.ok(diagnoseTraces(environment)[0].confidence < 0.5);
});
test("self-consistent hashes cannot disguise a held-out receipt or manufacture a task result", () => {
  const rehash = trace => { const { id, digest: oldDigest, ...body } = trace; const key = digest(body); return { ...body, id: `trace-${key}`, digest: key }; };
  const heldout = capture("heldout", "failed", "held-out");
  assert.throws(() => validateTrace(rehash({ ...heldout, sourceKind: "production" })), /outcome_mismatch/);
  assert.throws(() => validateTrace(rehash({ ...capture("unknown"), taskOutcome: "passed" })), /outcome_required/);
  assert.throws(() => validateTrace(rehash({ ...heldout, events: heldout.events.map(event => ({ ...event, runId: "other" })) })), /invalid/);
  assert.throws(() => validateTrace(rehash({ ...heldout, terminalStatus: "run.failed" })), /terminal_mismatch/);
});
function context() {
  const ticket = { id: "ticket", traceIds: [], traceDigests: [], evidenceRefs: [], failureCategory: "unknown", summary: "Human hypothesis", problem: "Verify edits", hypothesis: "Make verification explicit", target: "prompt", confidence: 0 };
  return { campaign: { id: "campaign", spec: { objective: "Verify changes before finishing", allowedTargets: ["prompt"], budget: { tokens: 1000 } }, usage: { tokens: 0 }, attempts: [] }, attempt: { id: "attempt-1", round: 1, evidence: { tickets: [ticket], traces: [] } }, operationId: "attempt-1-generate", signal: new AbortController().signal };
}
const usage = { inputTokens: 30, outputTokens: 20, totalTokens: 50, source: "provider" };
test("generation produces immutable candidate data with real lifecycle tests, without any verdict", async () => {
  const model = { async *stream(request) { assert.deepEqual(request.tools, []); assert.ok(request.instructions[0].content.includes("untrusted")); yield { type: "text_delta", text: JSON.stringify({ content: "Verify the relevant behavior before reporting completion.", rationale: "This may make missing validation visible." }) }; yield { type: "done", usage }; } };
  const generator = new ModelEvolutionGenerator(async () => ({ model, reference: { provider: "fixture", model: "a" } }));
  const proposal = await generator.generate(context());
  assert.equal(proposal.target, "prompt"); assert.equal(proposal.usage.tokens, 50);
  assert.equal(proposal.verdict, undefined); assert.equal(proposal.review, undefined);
  assert.match(proposal.source.files["index.test.ts"], /fork.dispose/);
  assert.match(proposal.source.files["index.ts"], /PluginWorkOwner/);
  assert.equal(proposal.source.manifest.permissions.capabilities.length, 0);
});
test("tool calls, forged Host output and incomplete streams cannot become generated candidates", async () => {
  const run = events => new ModelEvolutionGenerator(async () => ({ reference: { provider: "fixture", model: "a" }, model: { async *stream() { yield* events; } } })).generate(context());
  await assert.rejects(run([{ type: "tool_call", call: { id: "x", name: "promote", argumentsJson: "{}" } }]), /tool_call_forbidden/);
  await assert.rejects(run([{ type: "text_delta", text: '{"content":"x","rationale":"x","passed":true}' }, { type: "done", usage }]), /invalid_proposal/);
  await assert.rejects(run([{ type: "text_delta", text: "{}" }]), /incomplete/);
  const candidate = promptCandidate({ id: "prompt-test", version: 1, content: "Read first.", purpose: "Inspect before editing", runId: "run-1" });
  assert.ok(Object.isFrozen(candidate));
});
test("Skill generation retains complete resources and respects the frozen model output ceiling", async () => {
  const value = context(); value.campaign.spec.allowedTargets = ["skill"]; value.attempt.evidence.tickets[0].target = "skill";
  const manifest = "---\nname: generated-review\ndescription: Inspect changes and verify behavior.\ndisable-model-invocation: true\n---\nRead references/check.md before checking.\n";
  const model = { async *stream(request) {
    assert.equal(request.maxOutputTokens, 256); JSON.parse(request.messages[0].content);
    yield { type: "text_delta", text: JSON.stringify({ name: "generated-review", files: { "SKILL.md": manifest, "references/check.md": "Retain exact evidence.\n", "scripts/check.sh": "printf review\n" }, rationale: "Reusable verification instructions; effectiveness is unverified." }) };
    yield { type: "done", usage };
  } };
  const proposal = await new ModelEvolutionGenerator(async () => ({ model, reference: { provider: "fixture", model: "small" }, maxOutputTokens: 256 })).generate(value);
  assert.equal(proposal.target, "skill"); assert.match(proposal.source.files["index.ts"], /FrozenSkills/);
  assert.ok(proposal.source.files["index.ts"].includes("scripts/check.sh"));
  assert.equal(proposal.source.manifest.contracts.requires.skills.methods[0], "registerSource");
  assert.equal(proposal.verdict, undefined);
});
test("Skill feedback patches one pinned complete package and preserves every unchanged script and reference", async () => {
  const value = context(); value.campaign.spec.allowedTargets = ["skill"]; value.attempt.evidence.tickets[0].target = "skill";
  const manifest = "---\nname: safe-review\ndescription: Check changes\n---\nRead references/guide.md.\n";
  let response = { name: "safe-review", files: { "SKILL.md": manifest, "references/guide.md": "Original guide", "scripts/check.sh": "printf preserved\n" }, rationale: "A reusable hypothesis" };
  const generator = new ModelEvolutionGenerator(async () => ({ model: { async *stream() { yield { type: "text_delta", text: JSON.stringify(response) }; yield { type: "done", usage }; } }, reference: { provider: "fixture", model: "a" } }));
  const first = await generator.generate(value), base = JSON.parse(first.source.files["skill-package.json"]);
  value.campaign.attempts = [{ ...value.attempt, proposal: first }]; value.attempt = { ...value.attempt, id: "attempt-2", round: 2 };
  response = { baseDigest: base.digest, changes: [{ path: "references/guide.md", content: "Refined guide" }], rationale: "Narrow revision based on feedback" };
  const next = await generator.generate(value), pkg = JSON.parse(next.source.files["skill-package.json"]);
  assert.equal(pkg.resources.find(item => item.path === "scripts/check.sh").content, "printf preserved\n");
  assert.equal(pkg.resources.find(item => item.path === "references/guide.md").content, "Refined guide");
  assert.equal(pkg.skill.packageId, base.skill.packageId); assert.notEqual(pkg.digest, base.digest);
  response.baseDigest = "f".repeat(64); await assert.rejects(generator.generate(value), /patch_base_missing/);
});
test("the next generation receives Host-recorded validation failures rather than losing failed-round evidence", async () => {
  const value = context(); value.attempt = { ...value.attempt, id: "attempt-2", round: 2 };
  value.campaign.attempts = [{ id: "attempt-1", round: 1, operations: [{ stage: "candidate", failure: { reason: "TypeScript cannot resolve an undeclared service contract" } }] }];
  const model = { async *stream(request) {
    const input = JSON.parse(request.messages[0].content);
    assert.equal(input.previousAttempt.failures[0].stage, "candidate"); assert.match(input.previousAttempt.failures[0].reason, /undeclared service contract/);
    yield { type: "text_delta", text: JSON.stringify({ content: "Read the declared public API before changing behavior.", rationale: "A bounded repair hypothesis" }) }; yield { type: "done", usage };
  } };
  assert.equal((await new ModelEvolutionGenerator(async () => ({ model, reference: { provider: "fixture", model: "a" } })).generate(value)).target, "prompt");
});
