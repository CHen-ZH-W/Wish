import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DevelopmentController, currentChange } from "../dist/development/controller.js";
import { DevelopmentRuntime, MemoryDevelopmentStore, captureWorkspaceSnapshot, bytesDigest } from "../dist/development/index.js";
import { PlanRuntime, MemoryPlanStateStore } from "../dist/plan/index.js";
import { GoalRuntime } from "../dist/goal/runtime.js";
import { MemoryGoalStateStore } from "../dist/goal/store.js";
import { DomainDevelopmentOperations, operationIdentity } from "../dist/development/operations.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
const spec = () => ({ objective: "Persist the user's paper", scope: ["Add a paper and reopen it"], outOfScope: ["Sharing"], constraints: ["Local data"], criteria: [{ id: "persist", text: "Paper survives reopen", kind: "technical" }], questions: [], assumptions: ["Single user"], decisions: ["Local first"], planMarkdown: "Implement local paper persistence and check reopening", assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "One focused feature" } });
const req = project => ({ projectId: project.id, changeId: currentChange(project).id, sessionId: "session-a", expectedRevision: project.revision });
const action = (project, name, data = {}, requestId = randomUUID()) => ({ action: name, requestId, projectId: project.id, expectedRevision: project.revision, data: { changeId: currentChange(project).id, ...data } });

class FakeApplication {
  agentId = "wish";
  runs = new Map();
  inputs = [];
  autoExplore = true;
  controls = [];
  sessionPermissions = { forRun: async () => "workspace-write" };
  constructor(root) { this.root = root; this.runGeneration = { snapshot: () => ({ activeRuns: [...this.runs.values()].filter(run => !run.done).map(run => ({ runId: run.handle.runId, scope: "session-a" })) }) }; }
  async getSession({ sessionId }) { return { agentId: this.agentId, sessionId, scope: this.root, status: "active" }; }
  async startRun(input) {
    assert.ok(![...this.runs.values()].some(run => !run.done), "Application must not receive concurrent Runs for one Session");
    const runId = input.runId ?? randomUUID(); this.inputs.push(input);
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    const handle = { agentId: this.agentId, runId, initialUserTurnId: randomUUID(), scope: input.sessionId, completion };
    this.runs.set(runId, { handle, finish, done: false, input });
    if (input.metadata?.kind === "explore" && this.autoExplore) queueMicrotask(() => this.complete(runId));
    return handle;
  }
  complete(runId, status = "completed") { const run = this.runs.get(runId); if (run && !run.done) { run.done = true; run.finish({ runId, status, result: { status } }); } }
  controlRun(runId, control) { this.controls.push({ runId, control }); this.complete(runId, "aborted"); return { accepted: true, runId, type: control.type }; }
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "wish-development-controller-"));
  const state = new DevelopmentRuntime(new MemoryDevelopmentStore()), plan = new PlanRuntime({ store: new MemoryPlanStateStore() }), goal = new GoalRuntime({ store: new MemoryGoalStateStore() });
  const controller = new DevelopmentController({ state, plan, goal: () => goal }), app = new FakeApplication(root);
  try { await writeFile(join(root, "app.js"), "original dirty user code\n"); await run({ root, state, plan, goal, controller, app }); }
  finally { for (const run of app.runs.values()) app.complete(run.handle.runId, "aborted"); await tick(); await controller.close(); await state.close(); await plan.close(); await goal.close(); await rm(root, { recursive: true, force: true }); }
}
async function open(controller, app) { const result = await controller.control(app, "session-a", { action: "open", requestId: "open-one", data: { rawWish: "A local paper manager" } }); await tick(); return result.project; }
async function proposal(controller, app) { let project = await open(controller, app); project = await controller.propose({ ...req(project), spec: spec() }); return project; }
async function approve(controller, app, project, requestId = "implement-one") { const saved = currentChange(project).specs.at(-1); return controller.control(app, "session-a", action(project, "approve-and-start", { specVersion: saved.version, specDigest: saved.digest }, requestId)); }
async function goodReceipt(root, runId) { const output = "Reopened the saved paper"; return { id: randomUUID(), criterionIds: ["persist"], command: "node verify.js", exitCode: 0, timedOut: false, output, outputDigest: bytesDigest(output), code: await captureWorkspaceSnapshot(root), startedAt: "2026-10-20T00:00:00.000Z", endedAt: "2026-10-20T00:00:01.000Z", runId, toolCallId: "verify-call" }; }

test("Ordinary conversation exploration is owned until its actual cleanup completion", async () => fixture(async ({ root, controller, app, state, plan }) => {
  const handle = await app.startRun({ sessionId: "session-a", payload: { text: "Please preserve my paper" }, inputSource: "user" });
  controller.observeConversationRun(app, handle);
  let project = await controller.begin({ sessionId: "session-a", workspaceRoot: root, rawWish: "Please preserve my paper", requestId: "human-message", runId: handle.runId });
  project = await controller.propose({ ...req(project), spec: spec() });
  assert.equal(controller.activeRunCount, 1);
  await assert.rejects(approve(controller, app, project), error => error.code === "development_exploration_busy");
  assert.equal((await plan.get({ sessionId: "session-a" })).review.status, "pending");
  assert.equal(currentChange(await state.get(project.id)).confirmations.length, 0);
  app.complete(handle.runId); await tick();
  assert.equal(controller.activeRunCount, 0);
  const result = await approve(controller, app, project, "after-conversation-cleanup");
  assert.equal(app.inputs.length, 2); assert.equal(currentChange(result.project).starts.length, 1);
}));

test("Ordinary stop and inline pause both stop adopted conversation exploration", async () => fixture(async ({ root, controller, app, state }) => {
  const handle = await app.startRun({ sessionId: "session-a", payload: { text: "A paper manager" } });
  controller.observeConversationRun(app, handle);
  let project = await controller.begin({ sessionId: "session-a", workspaceRoot: root, rawWish: "A paper manager", requestId: "human-explore", runId: handle.runId });
  project = (await controller.control(app, "session-a", action(project, "pause"))).project;
  assert.equal(currentChange(project).phase, "paused"); assert.equal(app.runs.get(handle.runId).done, true);
  const next = await app.startRun({ sessionId: "session-a", payload: { text: "Add search" } });
  controller.observeConversationRun(app, next);
  project = await controller.begin({ sessionId: "session-a", workspaceRoot: root, rawWish: "Add search", requestId: "human-search", runId: next.runId });
  app.controlRun(next.runId, { type: "abort", source: "wish-webui" }); await tick();
  assert.equal(currentChange(await state.get(project.id)).phase, "paused"); assert.equal(controller.activeRunCount, 0);
}));

test("A natural human revision fences implementation and explores after the old Run drains", async () => fixture(async ({ state, goal, controller, app, root }) => {
  const started = await approve(controller, app, await proposal(controller, app));
  const handle = app.runs.get(started.runId).handle;
  controller.observeConversationRun(app, handle);
  await controller.beforeConversationInput("session-a", "Also support searching by title", { kind: "steer", runId: handle.runId, inputSource: "user" });
  let project = await state.get(started.project.id);
  assert.equal(currentChange(project).phase, "stopping"); assert.equal((await goal.get({ sessionId: "session-a" })).activation, "disarmed");
  const human = controller.conversationInput("session-a", handle.runId);
  assert.equal(human.rawWish, "Also support searching by title");
  await controller.begin({ sessionId: "session-a", workspaceRoot: root, ...human, runId: handle.runId });
  assert.equal(app.inputs.length, 2, "The live implementation cannot be replaced before cleanup");
  app.complete(handle.runId);
  for (let n = 0; n < 8; n++) await tick();
  project = await state.get(project.id);
  assert.deepEqual(currentChange(project).wishUpdates, [human.rawWish]);
  assert.equal(currentChange(project).phase, "exploring"); assert.equal(currentChange(project).gate, "none");
  assert.equal(currentChange(project).starts.length, 1, "A revision never approves a new implementation");
  assert.equal(app.inputs.length, 3); assert.equal(app.inputs.at(-1).metadata.kind, "explore");
}));

test("Ordinary stop of an implementation leaves the product paused and the Goal disarmed", async () => fixture(async ({ state, goal, controller, app }) => {
  const started = await approve(controller, app, await proposal(controller, app));
  app.controlRun(started.runId, { type: "abort", source: "wish-webui" });
  for (let n = 0; n < 4; n++) await tick();
  const project = await state.get(started.project.id);
  assert.equal(currentChange(project).phase, "paused"); assert.equal(currentChange(project).starts[0].status, "aborted");
  assert.equal((await goal.get({ sessionId: "session-a" })).activation, "disarmed");
}));

test("Product controller uses exact real Plan review and completes verified delivery before human acceptance", async () => fixture(async ({ root, state, plan, goal, controller, app }) => {
  let project = await proposal(controller, app);
  assert.equal((await plan.get({ sessionId: "session-a" })).review.status, "pending"); assert.equal(app.inputs.length, 1);
  let result = await approve(controller, app, project); project = result.project;
  const approved = await plan.get({ sessionId: "session-a" }), confirmation = currentChange(project).confirmations.at(-1);
  assert.equal(approved.review.status, "approved"); assert.equal(confirmation.planApproval.reviewId, approved.review.id); assert.equal(app.inputs.length, 2);
  assert.equal((await goal.get({ sessionId: "session-a" })).activation, "armed");
  await writeFile(join(root, "app.js"), "implemented without undoing user's code\n");
  project = await controller.recordVerification({ ...req(project), receipt: await goodReceipt(root, result.runId) });
  project = await controller.report({ ...req(project), runId: result.runId, summary: "Paper persistence is verified" });
  assert.equal(currentChange(project).reports.at(-1).criteria[0].status, "verified");
  assert.equal((await goal.get({ sessionId: "session-a" })).phase, "complete");
  app.complete(result.runId); await tick(); project = await state.get(project.id);
  const report = currentChange(project).reports.at(-1);
  result = await controller.control(app, "session-a", action(project, "accept", { reportId: report.id, reportDigest: report.digest }));
  assert.equal(currentChange(result.project).phase, "accepted"); assert.equal(result.project.activeChangeId, undefined);
}));

test("Pause waits for abort completion and resume reconfirms current code without replacing the specification", async () => fixture(async ({ root, state, controller, app }) => {
  let result = await approve(controller, app, await proposal(controller, app)), project = result.project;
  await writeFile(join(root, "app.js"), "half implemented plus the user's existing work\n");
  result = await controller.control(app, "session-a", action(project, "pause")); project = result.project;
  assert.equal(currentChange(project).phase, "paused"); assert.equal(currentChange(project).starts[0].status, "aborted");
  result = await controller.control(app, "session-a", action(project, "resume", {}, "resume-one")); project = result.project;
  assert.equal(currentChange(project).phase, "running"); assert.equal(currentChange(project).specs.length, 1); assert.equal(currentChange(project).starts.length, 2);
  assert.notEqual(currentChange(project).starts[0].runId, result.runId);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "half implemented plus the user's existing work\n");
  app.complete(result.runId); await tick(); assert.equal(currentChange(await state.get(project.id)).phase, "verifying");
}));

test("Controller replays the same start identity and rejects changed request parameters", async () => fixture(async ({ controller, app }) => {
  const project = await proposal(controller, app), saved = currentChange(project).specs.at(-1);
  const body = action(project, "approve-and-start", { specVersion: saved.version, specDigest: saved.digest }, "same-request");
  const first = await controller.control(app, "session-a", body), count = app.inputs.length;
  assert.equal((await controller.control(app, "session-a", body)).runId, first.runId); assert.equal(app.inputs.length, count);
  await assert.rejects(controller.control(app, "session-a", { ...body, data: { ...body.data, specDigest: "b".repeat(64) } }), error => /conflict|stale/u.test(error.code));
}));

test("A repeated open request does not launch a second exploration after the first completed", async () => fixture(async ({ controller, app }) => {
  const body = { action: "open", requestId: "open-one", data: { rawWish: "A local paper manager" } };
  await controller.control(app, "session-a", body); await tick(); const count = app.inputs.length;
  await controller.control(app, "session-a", body); await tick(); assert.equal(app.inputs.length, count);
  await assert.rejects(controller.control(app, "session-a", { ...body, data: { rawWish: "A different wish" } }), error => /idempotency_conflict|request_conflict/u.test(error.code));
}));

test("Plan artifacts must match before human approval is committed", async () => fixture(async ({ plan, state, controller, app }) => {
  const project = await proposal(controller, app), prior = await plan.get({ sessionId: "session-a" });
  const changed = await plan.update({ sessionId: "session-a", markdown: prior.document.markdown, expectedPlanVersion: prior.document.version, artifacts: [...prior.document.artifacts, { kind: "design", id: "unapproved-extra", version: 1, digest: "a".repeat(64) }] });
  await plan.review({ sessionId: "session-a", markdown: changed.document.markdown, expectedPlanVersion: changed.document.version });
  await assert.rejects(approve(controller, app, project), error => ["development_plan_changed", "development_plan_approval_conflict"].includes(error.code));
  assert.equal((await plan.get({ sessionId: "session-a" })).review.status, "pending", "Mismatch must not first approve a different Plan");
  assert.equal(currentChange(await state.get(project.id)).starts.length, 0);
}));

test("A user source edit after the proposal requires investigation before approval", async () => fixture(async ({ root, plan, state, controller, app }) => {
  const project = await proposal(controller, app);
  await writeFile(join(root, "app.js"), "new user edit after design investigation\n");
  await assert.rejects(approve(controller, app, project), error => /code_changed|workspace_changed/u.test(error.code));
  assert.equal((await plan.get({ sessionId: "session-a" })).review.status, "pending");
  assert.equal(currentChange(await state.get(project.id)).starts.length, 0);
  assert.equal(await readFile(join(root, "app.js"), "utf8"), "new user edit after design investigation\n");
}));

test("A report without Host verification cannot be accepted and must preserve an unrelated Goal", async () => fixture(async ({ state, goal, controller, app }) => {
  const unrelated = await goal.create({ sessionId: "session-a", objective: "Review a different repository" });
  let project = await proposal(controller, app);
  project = await controller.report({ ...req(project), summary: "This is an unverified draft report" });
  const report = currentChange(project).reports.at(-1); assert.equal(report.criteria[0].status, "unverified");
  await assert.rejects(controller.control(app, "session-a", action(project, "accept", { reportId: report.id, reportDigest: report.digest })), /verification_incomplete/);
  assert.equal((await goal.get({ sessionId: "session-a" })).id, unrelated.id); assert.equal((await goal.get({ sessionId: "session-a" })).phase, "active");
  assert.equal(currentChange(await state.get(project.id)).phase, "review");
}));

test("Early approval reports exploration busy without blocking the model's final proposal", async () => fixture(async ({ state, controller, app }) => {
  app.autoExplore = false;
  let result = await controller.control(app, "session-a", { action: "open", requestId: "open-one", data: { rawWish: "A local paper manager" } });
  let project = await controller.propose({ ...req(result.project), spec: spec() });
  let approvalError;
  const approval = approve(controller, app, project).catch(error => { approvalError = error; });
  await tick();
  let proposed = false;
  const finalProposal = controller.propose({ ...req(project), spec: spec() }).then(value => { proposed = true; project = value; app.complete(result.runId); });
  try {
    await Promise.race([finalProposal, new Promise(resolve => setTimeout(resolve, 100))]);
    assert.equal(proposed, true, "Human waiting must not hold the queue required by the exploration Run's final proposal");
    assert.equal(approvalError?.code, "development_exploration_busy");
  } finally {
    app.complete(result.runId); await finalProposal.catch(() => {}); await approval.catch(() => {}); await tick();
  }
  project = await state.get(project.id); assert.ok(currentChange(project).specs.length >= 2);
}));

test("A persisted pending action after a crash is inspected rather than replayed by a new controller", async () => fixture(async ({ root, state, plan, app }) => {
  const directory = await mkdtemp(join(tmpdir(), "wish-development-operations-"));
  const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: directory });
  const backend = { id: "fixture", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv }, storage = { backend: () => backend, resolve: () => kv };
  const body = { action: "open", requestId: "uncertain-action", data: { rawWish: "A paper manager" } };
  const identity = operationIdentity("session-a", body), operations = new DomainDevelopmentOperations(storage, "fixture");
  await operations.create({ ...identity, sessionId: "session-a", status: "pending" });
  const restored = new DevelopmentController({ state, plan, operations: new DomainDevelopmentOperations(storage, "fixture") });
  try {
    await assert.rejects(restored.control(app, "session-a", body), { code: "development_operation_incomplete" });
    assert.equal(app.inputs.length, 0); assert.equal((await state.list()).length, 0);
    assert.equal((await operations.get(identity.id)).status, "pending");
    assert.equal((await captureWorkspaceSnapshot(root)).files.length, 1);
  } finally { await restored.close(); await kv.close(); await rm(directory, { recursive: true, force: true }); }
}));
