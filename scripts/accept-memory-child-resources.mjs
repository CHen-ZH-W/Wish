import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { MemoryRuntime } from "../dist/memory/memory.js";
import { InMemoryStateStore } from "../dist/memory/store.js";
import { hash } from "../dist/memory/validation.js";
import { FileSubagentExchange } from "../dist/subagents/files.js";
import { SessionNotFoundError } from "../dist/sessions/types.js";
import { MEMORY_CANDIDATES_RESOURCE } from "../dist/memory/child-resources.js";
import ChildSnapshotMemoryService, { ChildSnapshotMemory } from "../dist/memory/providers/child-snapshot.js";
import MemorySubagentResources, { SubagentMemoryResources } from "../dist/memory/consumers/subagent-resources.js";
import { WishCliSubagentLauncherBackend } from "../dist/apps/cli/subagent-launcher.js";
import { SubagentLauncherService } from "../dist/subagents/launcher.js";

const childIdentity = { id: "child-1", childSessionId: "child-session", childRunId: "child-run" };
const user = { kind: "human", id: "operator" };
const evidence = [{ kind: "operator", id: "operator-evidence", revision: "1", digest: "a".repeat(64) }];
const body = { title: "Inspect project", content: "Inspect the source and focused tests.", appliesTo: "This project", keywords: ["inspect"], evidence };

async function accept(memory, id, value = body) {
  const proposal = await memory.propose({ ...value, targetId: id, expectedDocumentVersion: 0, operationId: `seed:${id}`, actor: user, reason: "Import known guidance" });
  await memory.decide({ candidateId: proposal.id, expectedCandidateVersion: 1, decision: "accept", operationId: `accept:${id}`, actor: user, reason: "Human verified" });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-child-"));
  const parent = new MemoryRuntime(new InMemoryStateStore("knowledge"));
  await accept(parent, "visible");
  await accept(parent, "hidden", { ...body, title: "Hidden secret", content: "Unrelated guidance", keywords: [] });
  const owner = { parentAgentId: "parent", parentSessionId: "parent-session", parentRunId: "parent-run", workspaceRoot: directory };
  const records = [{ schemaVersion: 1, kind: "message", sequence: 1, recordId: "message-1", idempotencyKey: "input-1", runId: childIdentity.childRunId, userTurnId: "turn-child", stepId: "step-child", origin: "user_input", inputSource: "user", createdAt: "2026-09-13T00:00:00Z", message: { role: "user", content: "Inspect source" } }];
  const history = { sessionId: childIdentity.childSessionId, historyRevision: "history-1", records };
  const record = { schemaVersion: 1, ...owner, ...childIdentity, role: "worker", task: "inspect", status: "exited", createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:01:00Z", result: { schemaVersion: 1, ...childIdentity, status: "completed", text: "Inspected", completedAt: "2026-09-13T00:01:00Z" } };
  const exchange = new FileSubagentExchange(directory);
  let current = record;
  const resources = new SubagentMemoryResources({ memory: parent, exchange, subagents: { async inspect() { return current; } }, evidence: { async read() { return history; } } });
  const request = { ...owner, task: "inspect", allowedCapabilities: ["runtime.read", "runtime.control"], availableTools: ["memory_search", "memory_read", "memory_write"] };
  const inputs = await resources.prepare(request, childIdentity);
  const manifest = await exchange.writeInputResources(childIdentity, owner, inputs);
  record.resourceManifestDigest = manifest.digest;
  const child = await ChildSnapshotMemory.open(exchange, manifest);
  const proposal = { ...body, evidence: [{ kind: "session", id: `${childIdentity.childSessionId}:${childIdentity.childRunId}`, revision: history.historyRevision, digest: hash(records), throughSequence: 1 }], targetId: "new-finding", expectedDocumentVersion: 0, operationId: "tool:child-run:call-1", actor: { kind: "agent", id: "worker", sessionId: childIdentity.childSessionId, runId: childIdentity.childRunId }, reason: "Focused source observation" };
  return { directory, parent, exchange, resources, manifest, child, proposal, request, record, history, setCurrent(value) { current = value; }, async close() { await child.close(); await resources.close(); await parent.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("child gets an immutable task-filtered snapshot and a durable private proposal outbox", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.child.query()).map(item => item.id), ["visible"]);
    assert.equal(await f.child.read("hidden"), undefined);
    assert.equal((await f.child.snapshot()).revision, f.manifest.resources[0].payload.snapshot.revision);
    const before = (await f.parent.state()).revision;
    const proposed = await f.child.propose(f.proposal);
    assert.equal(proposed.actor.kind, "child");
    assert.equal((await f.parent.state()).revision, before);
    assert.equal(await f.parent.read("new-finding"), undefined);
    const restored = await ChildSnapshotMemory.open(f.exchange, f.manifest);
    try { assert.deepEqual(await restored.propose(f.proposal), proposed); assert.equal((await restored.state()).candidates.length, 1); }
    finally { await restored.close(); }
    await assert.rejects(f.child.decide({ candidateId: proposed.id, expectedCandidateVersion: 1, decision: "accept", operationId: "forge-human", actor: user, reason: "Forge" }), /cannot accept/u);
    await assert.rejects(f.child.changeStatus({ id: "visible", expectedVersion: 1, status: "deleted", operationId: "forge-delete", actor: user, reason: "Forge" }), /cannot mutate/u);
  } finally { await f.close(); }
});

test("parent imports only sealed successful child proposals, idempotently, without acceptance", async () => {
  const f = await fixture();
  try {
    await f.child.propose(f.proposal);
    const before = (await f.parent.state()).candidates.length;
    await f.resources.consume({ ...f.record, status: "running" });
    await f.resources.consume({ ...f.record, result: { ...f.record.result, status: "aborted" } });
    assert.equal((await f.parent.state()).candidates.length, before);
    await f.resources.consume(f.record);
    await f.resources.consume(f.record);
    const state = await f.parent.state();
    assert.equal(state.candidates.length, before + 1);
    const proposal = state.candidates.at(-1);
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.actor.id, childIdentity.id);
    assert.equal(proposal.reviewSessionId, f.record.parentSessionId);
    assert.equal(await f.parent.read("new-finding"), undefined);
    await f.parent.decide({ candidateId: proposal.id, expectedCandidateVersion: 1, decision: "accept", operationId: "human-review", actor: user, reason: "Verified" });
    await f.resources.consume(f.record);
    assert.equal((await f.parent.state()).candidates.length, before + 1);
  } finally { await f.close(); }
});

test("foreign evidence, non-delegated writes, hidden targets and mismatched results fail closed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.child.propose({ ...f.proposal, evidence }), /own Session and Run/u);
    await assert.rejects(f.child.propose({ ...f.proposal, actor: { ...f.proposal.actor, runId: "foreign-run" } }), /another execution/u);
    await f.child.propose({ ...f.proposal, targetId: "hidden" });
    await assert.rejects(f.resources.consume(f.record), /outside its snapshot/u);
    f.setCurrent({ ...f.record, result: { ...f.record.result, id: "foreign-child" } });
    await assert.rejects(f.resources.consume(f.record), /identity mismatch/u);
    assert.deepEqual(await f.resources.prepare({ ...f.request, allowedCapabilities: [] }, childIdentity), []);
    const resources = await f.resources.prepare({ ...f.request, allowedCapabilities: ["runtime.read"] }, childIdentity);
    const identity = { ...childIdentity, id: "read-only-child" };
    const manifest = await f.exchange.writeInputResources(identity, f.request, resources);
    const readOnly = await ChildSnapshotMemory.open(f.exchange, manifest);
    try { await assert.rejects(readOnly.propose(f.proposal), /not delegated/u); } finally { await readOnly.close(); }
  } finally { await f.close(); }
});

test("parent verifies child proposal digests against the committed Session prefix", async () => {
  const f = await fixture();
  try {
    await f.child.propose({ ...f.proposal, evidence: [{ ...f.proposal.evidence[0], digest: "b".repeat(64) }] });
    await assert.rejects(f.resources.consume(f.record), /digest mismatch/u);
    assert.equal((await f.parent.state()).candidates.some(item => item.actor.kind === "child"), false);
    const output = await f.exchange.readOutputResource(f.manifest, MEMORY_CANDIDATES_RESOURCE);
    assert.equal(output.payload.candidates.length, 1, "rejected import retains the child's candidate for reconciliation");
  } finally { await f.close(); }
});

test("parent rejects a self-consistent resource file not matching its durable Host binding", async () => {
  const f = await fixture();
  try {
    await f.child.propose(f.proposal);
    f.setCurrent({ ...f.record, resourceManifestDigest: "f".repeat(64) });
    await assert.rejects(f.resources.consume(f.record), /Host-committed snapshot/u);
    assert.equal((await f.parent.state()).candidates.some(item => item.actor.kind === "child"), false);
  } finally { await f.close(); }
});

test("consumer close aborts and drains in-flight snapshot preparation", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const resources = new SubagentMemoryResources({ memory: { async snapshot() { entered(); await blocked; return { schemaVersion: 1, libraryId: "knowledge", revision: 0, documents: [] }; } }, exchange: {}, subagents: {}, evidence: {} });
  const preparation = resources.prepare({ task: "inspect", allowedCapabilities: ["runtime.read"] }, childIdentity);
  await started;
  let closed = false;
  const closing = resources.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await assert.rejects(preparation, /closed/u);
  await closing;
  await assert.rejects(resources.prepare({ task: "inspect" }, childIdentity), /closed/u);
});

test("child snapshot Cordis Provider validates Host path, identity and digest before activation", async () => {
  const f = await fixture();
  const root = new Context();
  try {
    const launcher = new WishCliSubagentLauncherBackend({ dataDirectory: f.directory, prepareResources: (request, identity) => f.resources.prepare(request, identity) });
    const identity = { ...childIdentity, id: "plugin-child" };
    const launch = await launcher.resolve(f.request, identity);
    root.provide("launch", { surface: "cli", argv: launch.command.args.slice(1), cwd: f.directory, environment: launch.command.environment });
    const provider = await root.plugin(ChildSnapshotMemoryService);
    assert.equal(provider.state, 2);
    assert.equal(root.memory.libraryId, "knowledge");
    assert.deepEqual((await root.memory.query()).map(item => item.id), ["visible"]);
    await provider.dispose();
    await launch.cleanupOnFailure();
  } finally { await root.fiber.dispose(); await f.close(); }
});

test("parent Consumer recovers missed completions and unregisters resources and observers on disposal", async () => {
  const f = await fixture();
  const root = new Context();
  let listeners = 0, acquisitions = 0, releases = 0;
  class Launcher extends SubagentLauncherService { resolve(request, identity) { return this.prepareResources(request, identity); } }
  try {
    await f.child.propose(f.proposal);
    root.provide("memory", f.parent);
    root.provide("sessions", { dataDirectory: f.directory, manager: { async get() { return { sessionId: f.record.parentSessionId, agentId: f.record.parentAgentId, scope: f.record.workspaceRoot }; } }, acquire() {
      acquisitions++;
      return { manager: { async readHistory() { return f.history; } }, release() { releases++; } };
    } });
    root.provide("runtimeLifecycle", { async readEvents() { return [{ type: "run.opened", runId: f.record.parentRunId, agentId: f.record.parentAgentId, scope: f.record.parentSessionId }]; } });
    root.provide("subagents", { async list() { return [f.record]; }, async inspect() { return f.record; }, subscribe() { listeners++; return () => { listeners--; }; } });
    await root.plugin(Launcher);
    const plugin = await root.plugin(MemorySubagentResources);
    const deadline = Date.now() + 1000;
    while (!(await f.parent.state()).candidates.some(item => item.actor.kind === "child") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.parent.state()).candidates.filter(item => item.actor.kind === "child").length, 1);
    assert.equal(listeners, 1);
    assert.equal((await root.subagentLauncher.resolve(f.request, childIdentity)).length, 1);
    await plugin.dispose();
    assert.equal(listeners, 0);
    assert.equal(acquisitions, releases);
    assert.deepEqual(await root.subagentLauncher.resolve(f.request, childIdentity), []);
  } finally { await root.fiber.dispose(); await f.close(); }
});

test("deleted parent Session is skipped during child Memory recovery", async () => {
  const f = await fixture();
  const root = new Context();
  let scans = 0, lists = 0, listener;
  const originalWrite = process.stderr.write;
  const diagnostics = [];
  class Launcher extends SubagentLauncherService {}
  try {
    await f.child.propose(f.proposal);
    root.provide("memory", f.parent);
    root.provide("sessions", { dataDirectory: f.directory, manager: {
      async get({ sessionId }) { throw new SessionNotFoundError(sessionId); },
      async wasDeleted() { return true; },
    } });
    root.provide("runtimeLifecycle", { async readEvents() {
      scans++;
      return [{ type: "run.opened", runId: f.record.parentRunId,
        agentId: f.record.parentAgentId, scope: f.record.parentSessionId }];
    } });
    root.provide("subagents", { async list() { lists++; return [f.record]; },
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; } });
    process.stderr.write = function (chunk, ...rest) {
      diagnostics.push(String(chunk));
      return true;
    };
    await root.plugin(Launcher);
    await root.plugin(MemorySubagentResources);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans, 1);
    assert.equal(lists, 0, "a deleted parent must not authorize child proposal import");
    listener({ type: "subagent.updated", record: f.record, occurredAt: f.record.updatedAt });
    listener({ type: "subagent.updated", record: f.record, occurredAt: f.record.updatedAt });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.parent.state()).candidates.some(item => item.actor.kind === "child"), false);
    assert.deepEqual(diagnostics, [
      "wish: Memory child result not imported: parent Session parent-session was deleted (child child-1)\n",
    ]);
  } finally {
    process.stderr.write = originalWrite;
    await root.fiber.dispose();
    await f.close();
  }
});

test("child events from another Application data root import without rescanning historical Runs", async () => {
  const f = await fixture();
  const root = new Context();
  let scans = 0, listener;
  class Launcher extends SubagentLauncherService {}
  try {
    await f.child.propose(f.proposal);
    root.provide("memory", f.parent);
    root.provide("sessions", { dataDirectory: f.directory, manager: {
      async get({ sessionId }) { throw new SessionNotFoundError(sessionId); },
      async wasDeleted() { return false; },
    }, acquire() { return { manager: { async readHistory() { return f.history; } }, release() {} }; } });
    root.provide("runtimeLifecycle", { async readEvents() { scans++; return []; } });
    root.provide("subagents", { async inspect() { return f.record; },
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; } });
    await root.plugin(Launcher);
    await root.plugin(MemorySubagentResources);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans, 1);
    listener({ type: "subagent.updated", record: f.record, occurredAt: f.record.updatedAt });
    const deadline = Date.now() + 1000;
    while (!(await f.parent.state()).candidates.some(item => item.actor.kind === "child") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal((await f.parent.state()).candidates.filter(item => item.actor.kind === "child").length, 1);
    assert.equal(scans, 1);
  } finally { await root.fiber.dispose(); await f.close(); }
});

test("missing child Session evidence remains a visible import failure", async () => {
  const f = await fixture();
  const root = new Context();
  const originalWrite = process.stderr.write;
  const diagnostics = [];
  class Launcher extends SubagentLauncherService {}
  try {
    await f.child.propose(f.proposal);
    root.provide("memory", f.parent);
    root.provide("sessions", { dataDirectory: f.directory, manager: { async get() {
      return { sessionId: f.record.parentSessionId, agentId: f.record.parentAgentId, scope: f.record.workspaceRoot };
    } }, acquire() { return { manager: { async readHistory() {
      throw new SessionNotFoundError(f.record.childSessionId);
    } }, release() {} }; } });
    root.provide("runtimeLifecycle", { async readEvents() { return [{ type: "run.opened",
      runId: f.record.parentRunId, agentId: f.record.parentAgentId, scope: f.record.parentSessionId }]; } });
    root.provide("subagents", { async list() { return [f.record]; }, async inspect() { return f.record; },
      subscribe() { return () => {}; } });
    process.stderr.write = function (chunk) { diagnostics.push(String(chunk)); return true; };
    await root.plugin(Launcher);
    await root.plugin(MemorySubagentResources);
    const deadline = Date.now() + 1000;
    while (!diagnostics.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /Memory child proposal import failed/u);
    assert.match(diagnostics[0], /Unknown Session: child-session/u);
    assert.equal((await f.parent.state()).candidates.some(item => item.actor.kind === "child"), false);
  } finally {
    process.stderr.write = originalWrite;
    await root.fiber.dispose();
    await f.close();
  }
});
