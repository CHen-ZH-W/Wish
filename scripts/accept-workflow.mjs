import assert from "node:assert/strict";
import { WorkflowRuntime } from "../dist/workflow/runtime.js";
import { MemoryWorkflowStore } from "../dist/workflow/store.js";
import { DomainWorkflowStore } from "../dist/workflow/store.js";
import { createWorkflowSessionFeature, workflowBlocksSessionRemoval } from "../dist/workflow/consumers/session-feature.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const task = (id, dependencies = []) => ({ id, title: id, dependencies, execution: { role: "worker", readOnly: true, timeoutMs: 1000 } });
const owner = { parentAgentId: "a", parentSessionId: "s", parentRunId: "r", workspaceRoot: "/tmp" };
const request = { key: "first", kind: "task-graph", owner, tasks: [task("a"), task("b", ["a"])], permissionProfile: "read-only", availableTools: ["read"] };
const store = new MemoryWorkflowStore();
const runtime = new WorkflowRuntime(store);
const run = await runtime.create(request);
assert.equal((await runtime.create(request)).id, run.id);
await assert.rejects(runtime.create({ ...request, budget: { maxTotalAttempts: 1 } }), /conflict/);
await assert.rejects(runtime.beginAttempt({ runId: run.id, stepId: "b", strategy: "first" }), /dependencies/);
const first = await runtime.beginAttempt({ runId: run.id, stepId: "a", strategy: "first" });
const target = { runId: run.id, stepId: "a", attemptId: first.id };
await runtime.markDispatched(target);
await runtime.bindChild(target, "child-1");
await assert.rejects(runtime.recoverInterrupted(), /startup-only/);
const restored = new WorkflowRuntime(store);
await restored.recoverInterrupted();
assert.equal((await restored.get(run.id)).steps[0].attempts[0].disposition, "resumable");
await assert.rejects(restored.beginAttempt({ runId: run.id, stepId: "a", strategy: "first" }), /same-Attempt/);
const resumed = await restored.resumeAttempt(target);
assert.equal(resumed.id, first.id);
assert.equal(resumed.idempotencyKey, first.idempotencyKey);
assert.equal(resumed.deadline, first.deadline);
await restored.finishAttempt(target, "failed", "bad input");
assert.equal((await restored.get(run.id)).status, "blocked");
assert.equal(workflowBlocksSessionRemoval(await restored.get(run.id)), false, "an idle failed Workflow must not make its owner Session undeletable");
await assert.rejects(restored.beginAttempt({ runId: run.id, stepId: "a", strategy: "first" }), /Repeated error/);
const retry = await restored.beginAttempt({ runId: run.id, stepId: "a", strategy: "changed input" });
assert.equal(retry.ordinal, 2);
await assert.rejects(restored.finishAttempt(target, "completed", "late"), /Stale/);
await restored.finishAttempt({ ...target, attemptId: retry.id }, "completed", "done");
assert.equal((await restored.get(run.id)).steps[1].status, "pending");
const second = await restored.beginAttempt({ runId: run.id, stepId: "b", strategy: "first" });
await restored.markDispatched({ ...target, stepId: "b", attemptId: second.id });
const crashed = new WorkflowRuntime(store);
await crashed.recoverInterrupted();
const unresolved = { ...target, stepId: "b", attemptId: second.id };
assert.equal(workflowBlocksSessionRemoval(await crashed.get(run.id)), true, "an uncertain interrupted Attempt must still fence Session archiving");
await assert.rejects(crashed.resumeAttempt(unresolved), /not resumable/);
await assert.rejects(crashed.beginAttempt({ runId: run.id, stepId: "b", strategy: "retry" }), /reconciliation/);
await crashed.reconcile(unresolved, "completed", "human", "Observed the output artifact");
assert.equal((await crashed.get(run.id)).status, "completed");
assert.equal(workflowBlocksSessionRemoval(await crashed.get(run.id)), false);
assert.equal((await crashed.get(run.id)).events.length, (await crashed.get(run.id)).revision);
await assert.rejects(crashed.finishAttempt(unresolved, "failed", "late"), /Terminal/);
assert.throws(() => { run.steps[0].task.execution.readOnly = false; }, TypeError);
console.log("workflow lifecycle, budgets, same-attempt recovery and reconciliation passed");

{
  const workflow = new WorkflowRuntime(new MemoryWorkflowStore());
  const scheduler = { lastError: undefined, async tick() {}, async cancel(id, reason) { await workflow.cancel(id, reason); } };
  const feature = createWorkflowSessionFeature(workflow, scheduler);
  const cancellable = await workflow.create({ ...request, key: "session-removal-cancel" });
  await assert.rejects(feature.beforeRemoval("s", "archive"), /关联 Workflow/);
  await feature.beforeRemoval("s", "delete");
  assert.equal((await workflow.get(cancellable.id)).status, "cancelled");
  await feature.purgeSession("s");
  assert.equal(await workflow.get(cancellable.id), undefined);
  await feature.beforeRemoval("s", "archive");

  const uncertain = await workflow.create({ ...request, key: "session-removal-reconcile" });
  const attempt = await workflow.beginAttempt({ runId: uncertain.id, stepId: "a", strategy: "first" });
  await workflow.markDispatched({ runId: uncertain.id, stepId: "a", attemptId: attempt.id });
  await workflow.interruptAttempt({ runId: uncertain.id, stepId: "a", attemptId: attempt.id }, "outcome unknown");
  await assert.rejects(feature.beforeRemoval("s", "archive"), /关联 Workflow/);
  await feature.beforeRemoval("s", "delete");
  const cancelled = (await workflow.get(uncertain.id)).steps[0].attempts[0];
  assert.equal(cancelled.status, "cancelled");
  await feature.purgeRun("s", "r");
  assert.equal(await workflow.get(uncertain.id), undefined, "stopping the owner removes its Workflow ledger");
  await feature.purgeRun("s", "r");
  const recreated = await workflow.create({ ...request, key: "session-removal-reconcile" });
  assert.equal(recreated.id, uncertain.id, "released Workflow identity is reusable");
  await feature.purgeRun("s", "r");
  await feature.beforeRemoval("s", "archive");
}

{
  const workflow = new WorkflowRuntime(new MemoryWorkflowStore());
  let scheduler;
  const feature = createWorkflowSessionFeature(workflow, () => scheduler);
  await feature.purgeRun("s", "r");
  const terminal = await workflow.create({ ...request, key: "scheduler-missing-terminal" });
  await workflow.cancel(terminal.id, "already stopped");
  await feature.purgeSession("s");
  assert.equal(await workflow.get(terminal.id), undefined, "terminal ledger cleanup needs no scheduler");
  const active = await workflow.create({ ...request, key: "scheduler-missing-active" });
  await assert.rejects(feature.beforeRemoval("s", "delete"), /scheduler is unavailable/u);
  await assert.rejects(feature.purgeRun("s", "r"), /scheduler is unavailable/u);
  await workflow.block(active.id, "waiting for review");
  assert.equal(workflowBlocksSessionRemoval(await workflow.get(active.id)), false);
  await assert.rejects(feature.beforeRemoval("s", "delete"), /scheduler is unavailable/u,
    "even an idle blocked ledger still needs a Scheduler for cancellation");
  assert.ok(await workflow.get(active.id), "active work stays recorded while its scheduler is unavailable");
  scheduler = { lastError: undefined, async tick() {}, async cancel(id, reason) { await workflow.cancel(id, reason); } };
  await feature.beforeRemoval("s", "delete");
  await feature.purgeRun("s", "r");
  assert.equal(await workflow.get(active.id), undefined, "cleanup resumes when the scheduler returns");
}

for (const budget of [{ maxTotalAttempts: 1 }, { maxAttemptsPerStep: 1 }, { maxCallsPerEdge: 1 }, { circuitThreshold: 1 }]) {
  const limited = new WorkflowRuntime(new MemoryWorkflowStore());
  const run = await limited.create({ ...request, budget });
  const attempt = await limited.beginAttempt({ runId: run.id, stepId: "a", strategy: "first" });
  await limited.finishAttempt({ runId: run.id, stepId: "a", attemptId: attempt.id }, "failed", "failure");
  await assert.rejects(limited.beginAttempt({ runId: run.id, stepId: "a", strategy: "different" }), /budget|circuit/);
}
const directory = await mkdtemp(join(tmpdir(), "wish-workflow-store-"));
const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: directory });
const storage = { backend: () => ({ id: "fixture", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv }) };
try {
  const durable = new WorkflowRuntime(new DomainWorkflowStore(storage, "fixture"));
  const run = await durable.create(request);
  const attempt = await durable.beginAttempt({ runId: run.id, stepId: "a", strategy: "first" });
  await durable.close();
  const restored = new WorkflowRuntime(new DomainWorkflowStore(storage, "fixture"));
  await restored.recoverInterrupted();
  assert.equal((await restored.get(run.id)).steps[0].attempts[0].id, attempt.id);
  assert.equal((await restored.get(run.id)).steps[0].attempts[0].disposition, "resumable");
  await restored.cancel(run.id, "Owner Run ended");
  await restored.remove(run.id);
  assert.equal(await restored.get(run.id), undefined);
  await restored.close();
  assert.deepEqual(await new DomainWorkflowStore(storage, "fixture").list(), []);
} finally { await kv.close(); await rm(directory, { recursive: true, force: true }); }

const compactDirectory = await mkdtemp(join(tmpdir(), "wish-workflow-config-"));
const compactKv = new FileKvStorageBackend({ backendId: "compact", rootDirectory: compactDirectory });
const compactStorage = { backend: () => ({ id: "compact", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv: compactKv }) };
try {
  const configuration = { catalog: "x".repeat(100_000) };
  const store = new DomainWorkflowStore(compactStorage, "compact");
  const workflow = new WorkflowRuntime(store);
  const first = await workflow.create({ ...request, key: "compact-first", modelsConfiguration: configuration });
  const second = await workflow.create({ ...request, key: "compact-second", modelsConfiguration: configuration });
  const readPayload = async () => {
    const stored = await compactKv.get({ namespace: "workflow/runs", key: "global" });
    const envelope = JSON.parse(Buffer.from(stored.value).toString("utf8"));
    return { envelope, payload: JSON.parse(Buffer.from(envelope.payloadBase64, "base64").toString("utf8")) };
  };
  const compact = await readPayload();
  assert.equal(compact.envelope.domainSchemaVersion, 2);
  assert.equal(Object.keys(compact.payload.configurations).length, 1);
  assert.equal(compact.payload.runs[0].modelsConfigurationRef, compact.payload.runs[1].modelsConfigurationRef);
  assert.equal(compact.payload.runs[0].modelsConfiguration, undefined);
  assert.deepEqual((await store.get(second.id)).modelsConfiguration, configuration);
  await workflow.close();

  const legacyEnvelope = {
    schemaVersion: 1, type: "wish_storage_domain", domainId: "workflow/runs", domainSchemaVersion: 1,
    payloadBase64: Buffer.from(JSON.stringify([first])).toString("base64"),
  };
  await compactKv.put({ namespace: "workflow/runs", key: "global", value: Buffer.from(JSON.stringify(legacyEnvelope)), precondition: { kind: "any" } });
  const migrated = new WorkflowRuntime(new DomainWorkflowStore(compactStorage, "compact"));
  assert.deepEqual((await migrated.get(first.id)).modelsConfiguration, configuration);
  await migrated.cancel(first.id, "migration checked");
  assert.equal((await readPayload()).envelope.domainSchemaVersion, 2);
  await migrated.close();
} finally { await compactKv.close(); await rm(compactDirectory, { recursive: true, force: true }); }
