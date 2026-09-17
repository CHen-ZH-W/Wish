import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowRuntime } from "../dist/workflow/runtime.js";
import { MemoryWorkflowStore } from "../dist/workflow/store.js";
import { ChildWorkflowScheduler } from "../dist/workflow/child-scheduler.js";
import { TaskGraphScheduler } from "../dist/workflow/task-graph-scheduler.js";
import { TaskRuntime, MemoryTaskStore } from "../dist/tasks/index.js";
import { PlanRuntime, MemoryPlanStateStore } from "../dist/plan/index.js";
import { subagentIdForKey } from "../dist/subagents/identity.js";

const owner = { parentAgentId: "a", parentSessionId: "s", parentRunId: "r", workspaceRoot: "/workspace" };
const spec = (id, dependencies = [], readOnly = true) => ({ id, title: id, dependencies, execution: { role: "worker", readOnly, timeoutMs: 1000 } });
class Children {
  records = new Map(); launches = 0; stopped = [];
  async spawn(input) {
    if (input.task !== undefined) assert.equal(input.task, input.task.trim(), "child prompt must satisfy the Subagent store contract");
    const id = subagentIdForKey(input.idempotencyKey);
    if (this.records.has(id)) return this.records.get(id);
    this.launches++;
    const record = { ...input, id, status: "running", target: { attachCommand: `tmux attach -t ${id}` } };
    this.records.set(id, record); return record;
  }
  async inspect({ id }) { return this.records.get(id); }
  async stop({ id }) { this.stopped.push(id); const record = { ...this.records.get(id), status: "stopped" }; this.records.set(id, record); return record; }
  subscribe() { return () => {}; }
  complete(id, status = "completed") { this.records.set(id, { ...this.records.get(id), status: "exited", result: { status, text: "verified" } }); }
}
test("Approved graph dispatches dependencies, projects results, reconnects without re-launch", async () => {
  const plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  const tasks = new TaskRuntime(new MemoryTaskStore());
  const store = new MemoryWorkflowStore();
  let workflow = new WorkflowRuntime(store);
  const subagents = new Children();
  let children = new ChildWorkflowScheduler({ workflow, subagents, tasks, maxConcurrent: 2 });
  const graphs = new TaskGraphScheduler(plan, tasks, children);
  const request = { owner, permissionProfile: "workspace-write", availableTools: ["read", "write"] };
  await assert.rejects(graphs.start(request), /approved Plan/);
  const graph = await tasks.replace("s", [spec("first"), spec("second", ["first"])], 0);
  await plan.enter({ sessionId: "s" });
  await plan.update({ sessionId: "s", markdown: "# implement", artifacts: [{ kind: "tasks", id: "s", version: graph.version, digest: graph.digest }] });
  const reviewed = await plan.review({ sessionId: "s", markdown: "# implement", expectedPlanVersion: 1 });
  await plan.decide({ sessionId: "s", reviewId: reviewed.review.id, expectedPlanVersion: 1, digest: reviewed.document.digest, actor: "user", decision: "approve" });
  const run = await graphs.start(request);
  const original = run.steps[0].attempts[0];
  assert.equal(subagents.launches, 1);
  assert.equal((await tasks.get("s")).tasks[0].status, "running");
  await children.close();
  workflow = new WorkflowRuntime(store); await workflow.recoverInterrupted();
  children = new ChildWorkflowScheduler({ workflow, subagents, tasks });
  await children.tick();
  assert.equal(subagents.launches, 1);
  assert.equal((await workflow.get(run.id)).steps[0].attempts[0].id, original.id);
  subagents.complete(original.childId); await children.tick();
  assert.equal(subagents.launches, 2);
  assert.equal((await tasks.get("s")).tasks[0].status, "completed");
  subagents.complete((await workflow.get(run.id)).steps[1].attempts[0].childId);
  await children.tick();
  assert.equal((await workflow.get(run.id)).status, "completed");
  assert.equal((await tasks.get("s")).tasks[1].status, "completed");
  await children.close();
});

test("Scheduler serializes workspace writes and retains unknown side effects for reconciliation", async () => {
  const workflow = new WorkflowRuntime(new MemoryWorkflowStore());
  const subagents = new Children(); let clock = Date.now();
  const scheduler = new ChildWorkflowScheduler({ workflow, subagents, now: () => clock, maxConcurrent: 4 });
  const run = await scheduler.submit({ key: "conflicts", kind: "task-graph", owner, tasks: [spec("write", [], false), spec("read")], permissionProfile: "workspace-write", availableTools: ["read", "write"] });
  assert.equal(subagents.launches, 1);
  clock += 2000; await scheduler.tick();
  const attempt = (await workflow.get(run.id)).steps[0].attempts[0];
  assert.equal(attempt.disposition, "needs-reconciliation");
  assert.equal(subagents.stopped.length, 1);
  const revision = (await workflow.get(run.id)).revision;
  await scheduler.tick(); await scheduler.tick();
  assert.equal((await workflow.get(run.id)).revision, revision, "must not repeatedly resume a timed-out child");
  assert.equal(subagents.launches, 1);
  const target = { runId: run.id, stepId: "write", attemptId: attempt.id };
  await workflow.reconcile(target, "not-completed", "human", "Inspected the workspace; no side effects remain");
  await scheduler.tick();
  assert.equal(subagents.launches, 1, "safe-to-retry is not automatic retry authorization");
  clock = Date.now();
  await scheduler.retry(run.id, "write", "retry with bounded input");
  assert.equal(subagents.launches, 2);
  assert.equal((await workflow.get(run.id)).steps[0].attempts[1].ordinal, 2);
  await scheduler.cancel(run.id, "human cancelled");
  assert.equal((await workflow.get(run.id)).status, "cancelled");
  await scheduler.close();
});

test("Dispatch/binding crash recovers the same observable child and never replays unknown launch", async () => {
  const store = new MemoryWorkflowStore(); const subagents = new Children();
  const workflow = new WorkflowRuntime(store);
  const run = await workflow.create({ key: "cut", kind: "subagent", owner, tasks: [spec("child")], permissionProfile: "read-only", availableTools: ["read"] });
  const attempt = await workflow.beginAttempt({ runId: run.id, stepId: "child", strategy: "first" });
  const target = { runId: run.id, stepId: "child", attemptId: attempt.id };
  await workflow.markDispatched(target);
  await subagents.spawn({ ...owner, idempotencyKey: attempt.idempotencyKey });
  const restored = new WorkflowRuntime(store); await restored.recoverInterrupted();
  const scheduler = new ChildWorkflowScheduler({ workflow: restored, subagents });
  await scheduler.tick();
  assert.equal((await restored.get(run.id)).steps[0].attempts[0].status, "running");
  assert.equal(subagents.launches, 1); await scheduler.close();
});
