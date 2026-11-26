import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { MemoryRuntime, JournalMemoryStore } from "../dist/memory/index.js";
import { content, hash } from "../dist/memory/validation.js";

const proposal = { operationId: "propose", targetId: "test", expectedDocumentVersion: 0, actor: { kind: "agent", id: "wish" }, reason: "reusable",
  title: "Tests", content: "Use focused tests", appliesTo: "Wish", keywords: ["test"], evidence: [{ kind: "operator", id: "review", revision: "1", digest: "a".repeat(64) }] };
test("Journal commits content and audit together and reloads across backend instances", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  const memory = new MemoryRuntime(new JournalMemoryStore(backend.journal.open({ namespace: "memory/default" })));
  const candidate = await memory.propose(proposal);
  await memory.decide({ candidateId: candidate.id, expectedCandidateVersion: 1, decision: "accept", operationId: "accept", actor: { kind: "human", id: "operator" }, reason: "Reviewed" });
  await memory.close(); await backend.close();
  const reopened = new FileStorageBackend({ id: "file", rootDirectory: directory });
  t.after(() => reopened.close());
  const restored = new MemoryRuntime(new JournalMemoryStore(reopened.journal.open({ namespace: "memory/default" })));
  const state = await restored.state();
  assert.equal(state.revision, 2);
  assert.equal(state.documents[0].content, proposal.content);
  assert.equal(state.audit.length, 2);
  assert.equal((await restored.propose(proposal)).id, candidate.id);
  assert.equal((await restored.state()).revision, 2);
  await restored.close();
});

test("Journal replay rejects changing proposal content during review or status changes", async () => {
  const entries = [];
  const journal = {
    async *read() { yield* entries; },
    async append(batch) { entries.push({ cursor: entries.length + 1, revision: `r${entries.length + 1}`, value: batch.entries[0] }); },
  };
  const memory = new MemoryRuntime(new JournalMemoryStore(journal));
  const candidate = await memory.propose(proposal);
  await memory.decide({ candidateId: candidate.id, expectedCandidateVersion: 1, decision: "accept", operationId: "accept", actor: { kind: "human", id: "operator" }, reason: "reviewed" });
  const originalDecision = entries[1].value;
  const decision = JSON.parse(new TextDecoder().decode(originalDecision));
  decision.candidate.content = "Different from reviewed candidate";
  decision.document.content = decision.candidate.content;
  decision.document.digest = hash(content(decision.document));
  entries[1].value = new TextEncoder().encode(JSON.stringify(decision));
  await assert.rejects(memory.state(), /cannot rewrite/);
  entries[1].value = originalDecision;
  await memory.changeStatus({ id: "test", expectedVersion: 1, status: "stale", operationId: "stale", actor: { kind: "human", id: "operator" }, reason: "outdated" });
  const change = JSON.parse(new TextDecoder().decode(entries[2].value));
  change.document.content = "Unexpected replacement";
  change.document.digest = hash(content(change.document));
  entries[2].value = new TextEncoder().encode(JSON.stringify(change));
  await assert.rejects(memory.state(), /cannot rewrite/);
});

test("failed Journal append does not publish knowledge or partial audit", async () => {
  const entries = [];
  let fail = true;
  const journal = {
    async *read() { yield* entries; },
    async append(batch) { if (fail) throw new Error("disk failure"); entries.push({ cursor: entries.length + 1, revision: `r${entries.length + 1}`, value: batch.entries[0] }); },
  };
  const memory = new MemoryRuntime(new JournalMemoryStore(journal));
  await assert.rejects(memory.propose(proposal), /disk failure/);
  assert.equal((await memory.state()).revision, 0);
  fail = false;
  await memory.propose(proposal);
  assert.equal((await memory.state()).audit.length, 1);
  entries[0].value = new TextEncoder().encode('{"schemaVersion":99}');
  await assert.rejects(memory.state(), /corrupt/);
});

test("automatic consolidation atomically merges, retires and replays without candidates", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-auto-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  const memory = new MemoryRuntime(new JournalMemoryStore(backend.journal.open({ namespace: "memory/default" })));
  const actor = { kind: "curation", id: "memory-curation" };
  const initial = { operationId: "init", actor, reason: "raw learning", expectedRevision: 0,
    upserts: ["topic", "duplicate"].map(id => ({ ...proposal, id, expectedVersion: 0 })), retirements: [] };
  await memory.consolidate(initial);
  assert.equal((await memory.state()).candidates.length, 0);
  const merge = { operationId: "merge", actor, reason: "combine related learning", expectedRevision: 1,
    upserts: [{ ...proposal, id: "topic", expectedVersion: 1, content: "Combined verified procedures and scope." }],
    retirements: [{ id: "duplicate", expectedVersion: 1, supersededBy: "topic" }] };
  assert.equal(await memory.consolidate(merge), 2); assert.equal(await memory.consolidate(merge), 2);
  assert.deepEqual((await memory.query()).map(item => item.id), ["topic"]);
  assert.equal((await memory.read("duplicate")).status, "superseded");
  await assert.rejects(memory.consolidate({ ...merge, content: "ignored", upserts: [{ ...merge.upserts[0], content: "different" }] }), /idempotency/);
  await assert.rejects(memory.consolidate({ ...merge, operationId: "stale-plan" }), /changed/);
  assert.throws(() => memory.consolidate({ ...merge, actor: { kind: "agent", id: "wish" } }), /curation Host/);
  await memory.close(); await backend.close();
  const reopened = new FileStorageBackend({ id: "file", rootDirectory: directory }); t.after(() => reopened.close());
  const restored = new MemoryRuntime(new JournalMemoryStore(reopened.journal.open({ namespace: "memory/default" })));
  assert.equal(await restored.consolidate(merge), 2);
  assert.equal((await restored.read("topic")).version, 2);
  assert.equal((await restored.state()).audit.length, 2);
  await restored.close();
});

test("failed consolidation journal append exposes neither partial documents nor audit", async () => {
  const entries = []; let fail = true;
  const journal = { async *read() { yield* entries; }, async append(batch) {
    if (fail) throw new Error("disk failure");
    entries.push({ cursor: entries.length + 1, revision: `r${entries.length + 1}`, value: batch.entries[0] });
  } };
  const memory = new MemoryRuntime(new JournalMemoryStore(journal));
  const change = { operationId: "automatic", actor: { kind: "curation", id: "memory-curation" }, reason: "learning", expectedRevision: 0,
    upserts: ["one", "two"].map(id => ({ ...proposal, id, expectedVersion: 0 })), retirements: [] };
  await assert.rejects(memory.consolidate(change), /disk failure/);
  assert.equal((await memory.state()).documents.length, 0); assert.equal((await memory.state()).revision, 0);
  fail = false; await memory.consolidate(change); assert.equal((await memory.query()).length, 2);
  const corrupted = JSON.parse(new TextDecoder().decode(entries[0].value)); corrupted.audit.actor.kind = "agent";
  entries[0].value = new TextEncoder().encode(JSON.stringify(corrupted));
  await assert.rejects(memory.state(), /Invalid Memory consolidation/);
});
