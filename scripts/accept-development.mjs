import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentRuntime, MemoryDevelopmentStore, DomainDevelopmentStore, captureWorkspaceSnapshot, bytesDigest, digest } from "../dist/development/index.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

const spec = (overrides = {}) => ({ objective: "Keep a paper after reopening", scope: ["Add and reopen a paper"], outOfScope: ["Sharing"], constraints: ["Local data"], criteria: [{ id: "persist", text: "Paper survives reopening", kind: "technical" }, { id: "usable", text: "User can understand the form", kind: "user" }], questions: [], assumptions: ["One user"], decisions: ["Use local storage"], planMarkdown: "Implement persistence and verify reopening", assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "One local feature" }, ...overrides });
const current = project => project.changes.find(change => change.id === project.activeChangeId) ?? project.changes.at(-1);
const request = project => ({ projectId: project.id, changeId: current(project).id, sessionId: current(project).sessionId, expectedRevision: project.revision });
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "wish-development-"));
  const store = new MemoryDevelopmentStore(), state = new DevelopmentRuntime(store);
  try { await writeFile(join(root, "app.js"), "export const papers = [];\n"); await run({ root, state, store }); }
  finally { await state.close(); await rm(root, { recursive: true, force: true }); }
}
async function proposed(state, root, overrides) {
  let project = await state.open({ sessionId: "session-a", workspaceRoot: root, rawWish: "A paper tool", requestId: "open-a" });
  return state.propose({ ...request(project), spec: spec(overrides) });
}
async function confirmed(state, project) { const saved = current(project).specs.at(-1); return state.confirm({ ...request(project), specVersion: saved.version, specDigest: saved.digest, actor: "human-session-surface" }); }
async function started(state, project, id = "start-a") {
  project = await state.reserveStart({ ...request(project), requestId: id, confirmationDigest: current(project).confirmations.at(-1).digest });
  const start = current(project).starts.at(-1);
  return state.bindStart({ projectId: project.id, requestId: start.id, runId: start.runId });
}
async function receipt(root, extras = {}) { return { id: "verify-a", criterionIds: ["persist"], command: "node verify.js", exitCode: 0, timedOut: false, output: "Reopened the saved paper", outputDigest: bytesDigest("Reopened the saved paper"), code: await captureWorkspaceSnapshot(root), startedAt: "2026-10-20T00:00:00.000Z", endedAt: "2026-10-20T00:00:01.000Z", ...extras }; }

test("Wish opening and exact confirmation persist identity; approval alone starts nothing", async () => fixture(async ({ state, root }) => {
  let project = await proposed(state, root);
  const original = project, change = current(project);
  assert.deepEqual(await state.open({ sessionId: "session-a", workspaceRoot: root, rawWish: "A paper tool", requestId: "open-a" }), project);
  await assert.rejects(state.open({ sessionId: "session-a", workspaceRoot: root, rawWish: "Changed", requestId: "open-a" }), /idempotency_conflict/);
  await assert.rejects(state.open({ sessionId: "session-b", workspaceRoot: root, rawWish: "A paper tool" }), /other_session/);
  await assert.rejects(state.propose({ ...request(project), expectedRevision: 1, spec: spec() }), /conflict/);
  await assert.rejects(state.propose({ ...request(project), spec: { ...spec(), code: await captureWorkspaceSnapshot(root) } }), { code: "development_invalid_spec_field" });
  const withArtifact = spec({ artifacts: [{ kind: "design", id: "first", version: 1, digest: "a".repeat(64) }] });
  assert.notEqual(digest(withArtifact), change.specs.at(-1).digest);
  project = await confirmed(state, project);
  assert.equal(current(project).phase, "ready"); assert.equal(current(project).starts.length, 0);
  assert.equal(current(original).confirmations.length, 0, "Stored snapshots must be immutable");
}));

test("Baseline mutation blocks start; same request replays exactly while another Session cannot steal it", async () => fixture(async ({ state, root }) => {
  let project = await confirmed(state, await proposed(state, root));
  await writeFile(join(root, "app.js"), "export const papers = ['existing user edit'];\n");
  await assert.rejects(state.reserveStart({ ...request(project), requestId: "start-a", confirmationDigest: current(project).confirmations.at(-1).digest }), { code: "development_code_changed" });
  await assert.rejects(confirmed(state, project), { code: "development_proposal_code_changed" });
  project = await state.propose({ ...request(project), spec: spec() });
  project = await confirmed(state, project);
  const startInput = { ...request(project), requestId: "start-a", confirmationDigest: current(project).confirmations.at(-1).digest };
  project = await state.reserveStart(startInput);
  assert.deepEqual(await state.reserveStart(startInput), project);
  await assert.rejects(state.reserveStart({ ...startInput, sessionId: "session-b" }), /idempotency_conflict/);
  await assert.rejects(state.reserveStart({ ...request(project), requestId: "start-b", confirmationDigest: startInput.confirmationDigest }), /not_ready/);
  assert.equal(current(project).starts.length, 1);
}));

test("Pause fences an admitted start; revision waits for final Run state and preserves raw wish", async () => fixture(async ({ state, root }) => {
  let project = await started(state, await confirmed(state, await proposed(state, root)));
  const runId = current(project).starts.at(-1).runId;
  await assert.rejects(state.revise({ ...request(project), rawWish: "Make it shared" }), /still_running/);
  project = await state.requestPause(request(project)); assert.equal(current(project).phase, "stopping");
  await assert.rejects(state.propose({ ...request(project), spec: spec() }), /still_running/);
  await assert.rejects(state.settlePause({ projectId: project.id, changeId: current(project).id }), /still_running/);
  project = await state.finishRun({ projectId: project.id, runId, status: "aborted" });
  project = await state.settlePause({ projectId: project.id, changeId: current(project).id });
  project = await state.revise({ ...request(project), rawWish: "Make it shared" });
  assert.equal(current(project).rawWish, "A paper tool"); assert.deepEqual(current(project).wishUpdates, ["Make it shared"]);
  await assert.rejects(confirmed(state, project), { code: "development_proposal_missing" });
}));

test("Host receipts bind actual output, source, spec and Run; delivery waits for human acceptance", async () => fixture(async ({ state, root }) => {
  let project = await started(state, await confirmed(state, await proposed(state, root)));
  const runId = current(project).starts.at(-1).runId;
  await writeFile(join(root, "app.js"), "export const papers = ['implemented'];\n");
  const valid = await receipt(root, { runId, toolCallId: "call-verify" });
  await assert.rejects(state.recordVerification({ ...request(project), receipt: { ...valid, outputDigest: "a".repeat(64) } }), /output_digest_mismatch/);
  project = await state.recordVerification({ ...request(project), receipt: valid });
  project = await state.report({ ...request(project), runId, summary: "Paper survives reopening; please review the form" });
  assert.deepEqual(current(project).reports.at(-1).criteria.map(item => item.status), ["verified", "waiting-user"]);
  const report = current(project).reports.at(-1);
  await assert.rejects(state.accept({ ...request(project), reportId: report.id, reportDigest: report.digest, actor: "human" }), /still_running/);
  project = await state.finishRun({ projectId: project.id, runId, status: "completed" }); assert.equal(current(project).phase, "review");
  project = await state.accept({ ...request(project), reportId: report.id, reportDigest: report.digest, actor: "human" });
  assert.equal(project.activeChangeId, undefined); assert.equal(current(project).phase, "accepted"); assert.equal(current(project).verifications[0].output, valid.output);
  await state.detachSession("session-a");
  const retained = await state.get(project.id); assert.equal(retained.sessionIds.length, 0); assert.equal(retained.changes[0].reports[0].acceptedBy, "human");
  const next = await state.open({ sessionId: "session-b", workspaceRoot: root, rawWish: "Add bulk tagging" }); assert.equal(next.id, project.id); assert.equal(next.changes.length, 2);
}));

test("No evidence, failed checks and source changes never become a successful acceptance", async () => fixture(async ({ state, root }) => {
  let project = await confirmed(state, await proposed(state, root));
  project = await state.report({ ...request(project), summary: "Implementation still needs checking" });
  let report = current(project).reports.at(-1); assert.equal(report.criteria[0].status, "unverified");
  await assert.rejects(state.accept({ ...request(project), reportId: report.id, reportDigest: report.digest, actor: "human" }), /verification_incomplete/);
  project = await state.recordVerification({ ...request(project), receipt: await receipt(root, { exitCode: 1 }) });
  project = await state.report({ ...request(project), summary: "Persistence check failed" }); assert.equal(current(project).reports.at(-1).criteria[0].status, "failed");
  project = await state.recordVerification({ ...request(project), receipt: await receipt(root, { id: "verify-b" }) });
  project = await state.report({ ...request(project), summary: "Persistence verified" }); report = current(project).reports.at(-1);
  await writeFile(join(root, "app.js"), "export const papers = ['changed again'];\n");
  await assert.rejects(state.accept({ ...request(project), reportId: report.id, reportDigest: report.digest, actor: "human" }), /report_code_changed/);
  project = await state.report({ ...request(project), summary: "New source needs new verification" }); assert.equal(current(project).reports.at(-1).criteria[0].status, "unverified");
}));

test("New runtime recovers dispatched work as interrupted and never automatically replays it", async () => fixture(async ({ state, store, root }) => {
  let project = await confirmed(state, await proposed(state, root));
  const input = { ...request(project), requestId: "start-a", confirmationDigest: current(project).confirmations.at(-1).digest };
  project = await state.reserveStart(input);
  const restored = new DevelopmentRuntime(store);
  try {
    await restored.recover(); project = await restored.get(project.id);
    assert.equal(current(project).phase, "interrupted"); assert.equal(current(project).starts[0].status, "interrupted");
    assert.deepEqual(await restored.reserveStart(input), project); assert.equal(current(project).starts.length, 1);
    project = await confirmed(restored, project);
    project = await started(restored, project, "start-b"); assert.equal(current(project).starts.length, 2);
  } finally { await restored.close(); }
}));

test("Workspace snapshot hashes actual bytes, declares exclusions, bounds scans and refuses symlinks", async () => fixture(async ({ root }) => {
  const first = await captureWorkspaceSnapshot(root);
  await mkdir(join(root, ".wish")); await writeFile(join(root, ".wish", "state"), "mutable service state");
  assert.equal((await captureWorkspaceSnapshot(root)).digest, first.digest);
  await mkdir(join(root, "dist")); await writeFile(join(root, "dist", "output.js"), "built behavior");
  assert.notEqual((await captureWorkspaceSnapshot(root)).digest, first.digest);
  await assert.rejects(captureWorkspaceSnapshot(root, { maxBytes: 1 }), { code: "development_snapshot_limit" });
  await symlink(join(root, "app.js"), join(root, "alias.js")); await assert.rejects(captureWorkspaceSnapshot(root), { code: "development_snapshot_symlink" });
}));

test("Domain storage reloads full independent project records with CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-development-store-"));
  const workspace = join(root, "workspace"), data = join(root, "data"); await mkdir(workspace); await writeFile(join(workspace, "app.js"), "ok");
  const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: data });
  const backend = { id: "fixture", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv };
  const storage = { backend: () => backend, resolve: () => kv };
  let state = new DevelopmentRuntime(new DomainDevelopmentStore(storage, "fixture"));
  try {
    const project = await proposed(state, workspace); await state.close(); state = new DevelopmentRuntime(new DomainDevelopmentStore(storage, "fixture"));
    assert.deepEqual(await state.get(project.id), project); assert.equal((await state.list()).length, 1);
    const second = new DomainDevelopmentStore(storage, "fixture"); await assert.rejects(second.put({ ...project, revision: project.revision + 1 }, 0), /conflict/);
  } finally { await state.close(); await kv.close(); await rm(root, { recursive: true, force: true }); }
});
