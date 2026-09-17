import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";

const human = { kind: "human", id: "operator" }, agent = { kind: "agent", id: "wish", sessionId: "s", runId: "r" };
const proposal = (operationId = "p-1", targetId = "testing", expectedDocumentVersion = 0) => ({
  operationId, targetId, expectedDocumentVersion, actor: agent, reason: "Reusable project test guidance",
  title: "Tests", content: "Run focused tests before broader integration checks.", appliesTo: "Wish development", keywords: ["tests", "Wish"],
  evidence: [{ kind: "session", id: "s:r", revision: "session-v1", digest: "a".repeat(64) }],
});
const decide = (candidate, decision = "accept", operationId = "accept-1") => ({ candidateId: candidate.id, expectedCandidateVersion: candidate.version, decision, operationId, actor: human, reason: "Reviewed source and applicability" });

test("Memory separates proposals from accepted knowledge and requires human review", async () => {
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const candidate = await memory.propose(proposal());
  assert.equal(candidate.status, "pending");
  assert.deepEqual(await memory.query(), []);
  assert.throws(() => memory.decide({ ...decide(candidate), actor: agent }), /human/);
  await memory.decide(decide(candidate));
  const accepted = await memory.read("testing");
  assert.equal(accepted.version, 1);
  assert.equal(accepted.status, "accepted");
  assert.equal((await memory.query({ text: "focused" }))[0].id, accepted.id);
  assert.equal((await memory.query({ text: "unrelatedword" })).length, 0);
  assert.equal(Object.isFrozen((await memory.state()).documents[0].evidence), true);
  await memory.close();
});

test("Memory deduplicates operations, detects conflicts and preserves deleted content for audit", async () => {
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const candidate = await memory.propose(proposal());
  assert.equal((await memory.propose(proposal())).id, candidate.id);
  await assert.rejects(memory.propose({ ...proposal(), content: "different" }), /idempotency/);
  await memory.decide(decide(candidate));
  await memory.decide(decide(candidate));
  assert.equal((await memory.state()).revision, 2);
  const next = await memory.propose(proposal("p-2", "testing", 1));
  await memory.changeStatus({ id: "testing", expectedVersion: 1, status: "stale", operationId: "stale", actor: human, reason: "Source changed" });
  await assert.rejects(memory.decide(decide(next, "accept", "accept-2")), /changed/);
  assert.deepEqual(await memory.query(), []);
  await memory.changeStatus({ id: "testing", expectedVersion: 2, status: "deleted", operationId: "delete", actor: human, reason: "No longer applicable" });
  assert.match((await memory.read("testing")).content, /focused/);
  assert.equal((await memory.state()).audit.length, 5);
  assert.throws(() => memory.changeStatus({ id: "testing", expectedVersion: 3, status: "deleted", operationId: "bad", actor: agent, reason: "No" }), /human/);
});

test("Memory rejects invalid content, cancellation and writes after closing", async () => {
  const memory = new MemoryRuntime(new InMemoryStateStore());
  assert.throws(() => memory.propose({ ...proposal(), targetId: "../secret" }), /identity/);
  assert.throws(() => memory.propose({ ...proposal(), evidence: [] }), /evidence/);
  await assert.rejects(memory.propose({ ...proposal(), signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  assert.equal((await memory.state()).revision, 0);
  await memory.close();
  await assert.rejects(memory.state(), /closed/);
  assert.throws(() => memory.propose(proposal()), /closed/);
});
