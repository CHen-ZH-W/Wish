import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";
import { ExperienceWiki, createExperience, validateExperience } from "../dist/evolution/experience.js";
import { EvolutionObservationRegistry, EvolutionTraceArchive, captureTaskTrace, diagnoseTraces } from "../dist/evolution/observations.js";
import { layeredSkillMetadata, proposeStrategyGene, retrieveStrategyGenes } from "../dist/evolution/strategy.js";
import { researchSkill, skillUsageSummary, SkillUsageLedger } from "../dist/evolution/skill-research.js";
import { createSkillPackageSnapshot } from "../dist/skills/local.js";
import { proposeSkillPatch } from "../dist/evolution/skill-proposals.js";
const sha = "a".repeat(64), at = "2026-10-22T01:00:00Z";
function trace(id, result = "passed", extraEvents = [], attempts = []) {
  return captureTaskTrace({ sessionId: "s", runId: id, history: { sessionId: "s", records: extraEvents.filter(event => event.type === "tool.dispatched").map((event, index) => ({ kind: "message", runId: id, sequence: index + 1, message: { role: "assistant", content: "", toolCalls: [{ id: event.callId, name: event.toolName, argumentsJson: JSON.stringify({ path: "same-input" }) }] } })) }, events: [
    { schemaVersion: 1, type: "run.opened", runId: id, scope: "s", occurredAt: at }, ...extraEvents.map(event => ({ schemaVersion: 1, occurredAt: at, runId: id, ...event })),
    { schemaVersion: 1, type: "run.completed", runId: id, occurredAt: at }], attempts,
    ...(result ? { outcome: { runId: id, taskId: id, verifierId: "independent", verifierVersion: 1, sourceKind: "production", result, evidenceDigest: sha } } : {}) });
}
const draft = row => ({ scope: "/workspace", topic: "Verification", claim: "A proposed strategy may avoid repeating work.", conditions: ["retry"], actions: ["Inspect committed output first"], warnings: ["Outcome is not causal proof"], traceIds: [row.id] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wish-experience-")); t.after(() => rm(root, { recursive: true, force: true }));
  const kv = new FileKvStorageBackend({ backendId: "research", rootDirectory: root }); t.after(() => kv.close());
  const backend = { id: "research", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv };
  return { id: "research", backend: () => backend, resolve: () => kv };
}
test("Wiki keeps contradictory experience and independent outcomes, and production Memory still requires separate acceptance", async t => {
  const storage = await fixture(t), wiki = new ExperienceWiki(storage, storage.id), first = trace("one");
  const entry = await wiki.record(draft(first), [first]);
  assert.equal(entry.status, "hypothesis"); assert.equal(entry.evidence[0].outcome, "passed");
  assert.equal((await wiki.record(draft(first), [first])).digest, entry.digest);
  let note;
  const automaticMemory = { async addNote(input) { note = input; return { noteId: "note", status: "recorded" }; } };
  assert.equal((await wiki.proposeMemory(automaticMemory, { subjectDigest: entry.digest, operationId: "memory-note" })).status, "recorded");
  assert.match(note.text, /hypothesis/);
  await wiki.review({ subjectDigest: entry.digest, decision: "accepted", actorId: "operator", reason: "Reviewed scope and evidence" });
  await wiki.proposeMemory(automaticMemory, { subjectDigest: entry.digest, operationId: "reviewed-note" });
  assert.equal(note.evidence[0].digest, entry.digest);
  const failed = trace("two", "failed");
  const counter = await wiki.record({ ...draft(failed), claim: "The first strategy may be inappropriate for this condition.", contradicts: [entry.digest] }, [failed]);
  assert.equal((await wiki.inspect("/workspace"))[0].contradictions.length, 1);
  await wiki.proposeMemory(automaticMemory, { subjectDigest: entry.digest, operationId: "contradicting-note" });
  assert.match(note.text, new RegExp(counter.digest));
  assert.equal((await new ExperienceWiki(storage, storage.id).list("/workspace")).length, 2);
  assert.equal(validateExperience(counter).digest, counter.digest);
  assert.throws(() => createExperience({ ...draft(first), status: "accepted" }, [first]), /untrusted_status/);
  assert.throws(() => createExperience({ ...draft(first), traceIds: ["missing"] }, [first]), /evidence_missing/);
});
test("Host outcome registration pins provenance; newest independent result supersedes an unknown generation view", async t => {
  const storage = await fixture(t), registry = new EvolutionObservationRegistry(storage, storage.id), archive = new EvolutionTraceArchive(storage, storage.id);
  const origin = { runId: "one", sessionId: "s", taskId: "one", sourceKind: "production", ownerId: "task-runner" };
  const unknown = trace("one", null), known = trace("one", "passed");
  await archive.put(unknown); await archive.put(known); await archive.put(known);
  assert.equal((await archive.list()).length, 2); assert.equal((await archive.list({ forGeneration: true })).length, 1); assert.equal((await archive.list({ forGeneration: true }))[0].taskOutcome, "passed");
  await assert.rejects(registry.recordOutcome(known.outcome), /provenance_required/);
  await registry.recordOrigin(origin); await registry.recordOutcome(known.outcome);
  await assert.rejects(registry.recordOrigin({ ...origin, sourceKind: "held-out" }), { code: "profile_immutable_conflict" });
  assert.equal((await new EvolutionObservationRegistry(storage, storage.id).get("one")).outcome.result, "passed");
  const heldout = captureTaskTrace({ sessionId: "s", runId: "one", history: { sessionId: "s", records: [] }, events: known.events, attempts: [], sourceKind: "held-out" });
  await assert.rejects(archive.put(heldout), { code: "profile_immutable_conflict" });
  await assert.rejects(new EvolutionTraceArchive(storage, storage.id).put(heldout), { code: "profile_immutable_conflict" });
  assert.equal((await archive.list({ forGeneration: true }))[0].sourceKind, "production");
});
test("successful but repetitive or expensive tasks produce measured hypotheses with alternative explanations", () => {
  const repeats = [1, 2, 3].map(index => trace(`r${index}`, "passed", Array.from({ length: 3 }, (_, call) => ({ type: "tool.dispatched", toolName: "read", callId: `call-${call}`, callFingerprint: sha }))));
  const tickets = diagnoseTraces(repeats); assert.equal(tickets[0].pattern, "repeated-tool"); assert.ok(tickets[0].alternatives.length > 0); assert.equal(tickets[0].confidence, .5);
  const heavy = [1, 2, 3].map(index => trace(`h${index}`, "passed", [], [{ runId: `h${index}`, attemptId: `a${index}`, status: "completed", usage: { totalTokens: 50000 } }]));
  assert.equal(diagnoseTraces(heavy)[0].pattern, "high-token-use");
  const unknown = heavy.map(row => trace(row.runId, "passed", [], [{ runId: row.runId, status: "failed" }]));
  assert.deepEqual(diagnoseTraces(unknown, 3, { maxCostByCurrency: { CNY: 0 } }), []);
  const infrastructure = [1, 2, 3].map(index => trace(`infra${index}`, "failed", [], [{ runId: `infra${index}`, status: "failed", error: { code: "network_error", message: "Connection failed", retryable: true } }]));
  assert.equal(diagnoseTraces(infrastructure)[0].failureCategory, "environment");
  assert.ok(diagnoseTraces(infrastructure).every(ticket => ticket.pattern === "failure"));
});
test("layered skills and compact genes retain scope and provenance and do not become accepted policies", () => {
  const row = trace("gene"), experience = createExperience(draft(row), [row]);
  const metadata = layeredSkillMetadata({ schemaVersion: 1, layer: "functional", scope: "/workspace", dependencies: [{ packageDigest: sha, layer: "atomic" }], experienceDigests: [experience.digest] });
  assert.equal(metadata.layer, "functional");
  assert.throws(() => layeredSkillMetadata({ ...metadata, dependencies: [{ packageDigest: sha, layer: "planning" }] }), /dependency_invalid/);
  const input = { id: "recovery", version: 1, scope: "/workspace", applicability: ["retry"], actions: ["Inspect receipt"], warnings: [{ condition: "unknown", avoid: "blind repetition", instead: "reconcile" }], experienceDigests: [experience.digest], skillDigests: [sha] };
  const gene = proposeStrategyGene(input, [experience], [sha]);
  assert.equal(gene.status, "proposal"); assert.equal(retrieveStrategyGenes([gene], { scope: "/workspace", query: "retry task" })[0].digest, gene.digest);
  assert.deepEqual(retrieveStrategyGenes([gene], { scope: "/another", query: "retry task" }), []);
  assert.throws(() => proposeStrategyGene({ ...input, scope: "/another" }, [experience], [sha]), /provenance_missing/);
  assert.throws(() => proposeStrategyGene({ ...input, version: 2 }, [experience], [sha]), /lineage_required/);
});
const pkg = () => { const content = "---\nname: research\ndescription: Preserve resources\n---\nOriginal instructions.\n"; return createSkillPackageSnapshot({ name: "research", description: "Preserve resources", source: "workspace", location: "/workspace/research/SKILL.md", packageId: sha, digest: createHash("sha256").update(content).digest("hex"), modelInvocable: true }, { "SKILL.md": content, "scripts/check.sh": "printf original\n" }); };
test("same-base research consolidates independent patches hierarchically and preserves scripts", async () => {
  const base = pkg(), inputs = [], traces = Array.from({ length: 10 }, (_, index) => trace(`p${index}`));
  const result = await researchSkill({ id: "batch", base, expectedBaseDigest: base.digest, traces, concurrency: 2, signal: new AbortController().signal,
    analyze: async ({ base: frozen, trace }) => { inputs.push(frozen.digest); return proposeSkillPatch({ id: `proposal-${trace.runId}`, version: 1, base: frozen, expectedBaseDigest: base.digest, reason: "Local evidence", changes: [{ path: `references/${trace.runId}.md`, content: "A bounded lesson" }] }); } });
  assert.equal(new Set(inputs).size, 1); assert.equal(result.status, "ready"); assert.equal(result.analyses.length, 10); assert.equal(result.merges.length, 3);
  assert.equal(result.result.outputs[0].resources.find(row => row.path === "scripts/check.sh").content, "printf original\n");
  const conflict = await researchSkill({ id: "conflict", base, expectedBaseDigest: base.digest, traces: traces.slice(0, 2), signal: new AbortController().signal,
    analyze: async ({ trace }) => proposeSkillPatch({ id: `proposal-${trace.runId}`, version: 1, base, expectedBaseDigest: base.digest, reason: "Competing lesson", changes: [{ path: "references/same.md", content: trace.runId }] }) });
  assert.equal(conflict.status, "conflicted"); assert.equal(conflict.result, undefined); assert.equal(conflict.merges[0].conflicts.length, 1);
});
test("reads, invocations, execution and independently verified success are separate durable counts", async t => {
  const storage = await fixture(t), ledger = new SkillUsageLedger(storage, storage.id), outcome = trace("one").outcome;
  const row = { packageDigest: sha, runId: "one", taskId: "one", evidenceRef: "archive:exact" };
  const read = { ...row, operationId: "read", kind: "read" }, verified = { ...row, operationId: "verify", kind: "verification", verification: outcome };
  assert.equal(skillUsageSummary([read, verified]).verifiedSuccessTasks, 0);
  for (const receipt of [read, read, verified, { ...row, operationId: "invoke", kind: "invoke" }, { ...row, operationId: "execute", kind: "execute" }]) await ledger.record(receipt);
  assert.deepEqual(await ledger.summary(sha), { reads: 1, invocations: 1, executions: 1, verifiedSuccessTasks: 1, verifiedFailureTasks: 0 });
  assert.equal((await new SkillUsageLedger(storage, storage.id).summary(sha)).executions, 1);
  assert.throws(() => skillUsageSummary([{ ...row, operationId: "fake", kind: "read", verification: outcome }]), /usage_invalid/);
});
