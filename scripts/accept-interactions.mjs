import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InteractionRuntime } from "../dist/interactions/runtime.js";
import { MemoryInteractionStore, DomainInteractionStore } from "../dist/interactions/store.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";
import { projectConversationTurns, projectLedger } from "../dist/apps/webui/client/projection/ledger.js";
import { InteractionClientModel } from "../dist/interactions/consumers/webui/model.js";
import { FeaturesClientModel } from "../dist/apps/webui/client/model/features.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";

const spec = { title: "Wish 会话体验", questions: [{ id: "focus", question: "先完善哪项体验？", options: [{ id: "feedback", label: "原位反馈", recommended: true }, { id: "project", label: "项目理解" }] }] };
const open = (overrides = {}) => ({ ...spec, sessionId: "session-a", runId: "run-a", userTurnId: "turn-a", stepId: "step-a", toolCallId: "call-a", ...overrides });
const response = request => ({ requestId: request.id, revision: request.revision, answers: [{ questionId: "focus", optionIds: ["feedback"], text: "保留原会话入口" }] });

test("a real answer resolves the waiting call once, with CAS and session isolation", async () => {
  const runtime = new InteractionRuntime(new MemoryInteractionStore());
  try {
    const request = await runtime.open(open());
    assert.deepEqual(await runtime.open(open()), request);
    await assert.rejects(runtime.open(open({ title: "changed" })), /identity_conflict/);
    const waiting = runtime.wait(request);
    await assert.rejects(runtime.respond("session-b", response(request)), /not_found/);
    await assert.rejects(runtime.respond("session-a", { ...response(request), revision: 100 }), /conflict/);
    await assert.rejects(runtime.respond("session-a", { ...response(request), answers: [{ questionId: "focus", optionIds: ["unknown"], text: "" }] }), { code: "interaction_incomplete_answer" });
    assert.equal((await runtime.get("session-a")).requests[0].status, "pending");
    const result = await runtime.respond("session-a", response(request));
    assert.equal((await waiting).status, "answered");
    assert.deepEqual(result.answers, response(request).answers);
    assert.deepEqual(await runtime.respond("session-a", response(request)), result, "same submission replays safely");
    await assert.rejects(runtime.respond("session-a", { ...response(request), dismiss: true }), /already_resolved/);
    assert.equal(request.status, "pending", "old snapshots are immutable");
  } finally { await runtime.close(); }
});

test("multi-choice and free text do not need any recommended option", async () => {
  const runtime = new InteractionRuntime(new MemoryInteractionStore());
  try {
    const request = await runtime.open(open({ questions: [{ ...spec.questions[0], multiple: true }, { id: "own", question: "还有什么要求？" }] }));
    await assert.rejects(runtime.respond("session-a", { requestId: request.id, revision: 1, answers: [] }), { code: "interaction_incomplete_answer" });
    const result = await runtime.respond("session-a", { requestId: request.id, revision: 1, answers: [{ questionId: "focus", optionIds: ["project", "feedback"], text: "" }, { questionId: "own", optionIds: [], text: "自己的方案" }] });
    assert.equal(result.answers[1].text, "自己的方案");
    assert.deepEqual(result.answers[0].optionIds, ["project", "feedback"]);
  } finally { await runtime.close(); }
});

test("answer-before-wait, dismiss, abort and composer interruption all settle without invented choices", async () => {
  const runtime = new InteractionRuntime(new MemoryInteractionStore());
  try {
    let request = await runtime.open(open());
    await runtime.respond("session-a", { requestId: request.id, revision: 1, dismiss: true });
    assert.equal((await runtime.wait(request)).status, "dismissed");
    request = await runtime.open(open({ toolCallId: "call-b" }));
    const stopped = new AbortController(), waiting = runtime.wait(request, stopped.signal);
    stopped.abort(new Error("run stopped")); await assert.rejects(waiting, /run stopped/);
    await runtime.interrupt("session-a", "run-stopped", "run-a");
    assert.equal((await runtime.get("session-a")).requests[1].answers, undefined);
    request = await runtime.open(open({ toolCallId: "call-c" }));
    const continued = runtime.wait(request);
    await runtime.interrupt("session-a", "continued-in-conversation", "run-a");
    assert.equal((await continued).reason, "continued-in-conversation");
    request = await runtime.open(open({ toolCallId: "call-d" }));
    const removed = runtime.wait(request);
    await runtime.delete("session-a");
    assert.equal((await removed).reason, "session-deleted");
    assert.equal(await runtime.get("session-a"), undefined);
  } finally { await runtime.close(); }
});

test("module shutdown releases waiters even when persistence fails", async () => {
  const store = new MemoryInteractionStore(), runtime = new InteractionRuntime(store);
  const request = await runtime.open(open()), waiting = runtime.wait(request);
  const rejected = assert.rejects(waiting, /closed/);
  store.put = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(runtime.close(), /disk unavailable/); await rejected;
  assert.equal(runtime.waitingCount, 0);
});

test("file domain persists answered records, reconciles orphaned waits and guards revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-interactions-store-"));
  const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: root });
  const backend = { id: "fixture", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv };
  const storage = { backend: () => backend, resolve: () => kv };
  const domain = new DomainInteractionStore(storage, "fixture");
  const first = new InteractionRuntime(domain);
  try {
    const request = await first.open(open()); await first.respond("session-a", response(request));
    await first.open(open({ toolCallId: "orphan", runId: "old-run" }));
    const next = new InteractionRuntime(new DomainInteractionStore(storage, "fixture"));
    await next.recover();
    const saved = await next.get("session-a");
    assert.equal(saved.requests[0].status, "answered");
    assert.equal(saved.requests[1].status, "interrupted");
    assert.equal(saved.requests[1].reason, "host-restarted");
    await assert.rejects(domain.put({ ...saved, revision: saved.revision + 1 }, 0), /conflict/);
    await next.close();
  } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
});

test("message contributions stay in the source turn outside collapsed work details", () => {
  const block = { id: "question", runId: "run", turnId: "run/turn", stepId: "step", time: "2026-10-30T00:00:01Z", kind: "system", title: "选择", text: "选择", viewId: "conversation-interactions" };
  const turns = projectLedger(null, [], "zh-CN", [block]);
  const projected = projectConversationTurns(turns);
  assert.equal(projected[0].id, "run/turn");
  assert.deepEqual(projected[0].contributions, [block]);
  assert.deepEqual(projected[0].process, []);
  assert.equal(projected[0].answer, undefined);
});

class MutableStore extends SnapshotStore { update(value) { this.publish({ ...this.getSnapshot(), ...value }); } }
test("client preserves draft through navigation and prevents actions against another session or stale request", async () => {
  const runtime = new InteractionRuntime(new MemoryInteractionStore()), request = await runtime.open(open());
  const run = new MutableStore({ terminal: true, events: [] });
  const sessions = Object.assign(new MutableStore({ selectedId: "session-a", available: true, working: false, sessions: [{ sessionId: "session-a", status: "active" }] }), { run });
  const feature = { key: "conversation-interactions", token: { sessionId: "session-a" }, actions: [{ name: "respond" }], data: await runtime.get("session-a") };
  let actions = 0;
  const features = Object.assign(new MutableStore({ sessionId: "session-a", views: [feature], available: true, pending: false }), { refresh: async () => {}, poll: async () => {}, act: async () => { actions++; throw new Error("offline"); } });
  const model = new InteractionClientModel(features, sessions);
  try {
    model.updateDraft(request.id, "focus", { optionIds: ["feedback"], text: "retain" });
    assert.equal(model.canRespond(request), true);
    await assert.rejects(model.respond(request, response(request)), /offline/);
    assert.equal(model.draft(request.id).focus.text, "retain");
    sessions.update({ selectedId: "session-b" });
    assert.equal(model.getSnapshot().length, 0); assert.equal(model.canRespond(request), false);
    await assert.rejects(model.respond(request, response(request)), /unavailable/); assert.equal(actions, 1);
    sessions.update({ selectedId: "session-a" });
    assert.equal(model.draft(request.id).focus.optionIds[0], "feedback");
    const answered = await runtime.respond("session-a", response(request));
    features.update({ views: [{ ...feature, data: await runtime.get("session-a") }] });
    assert.equal(model.getSnapshot()[0].data.status, "answered");
    assert.equal(model.canRespond(request), false); assert.deepEqual(model.draft(request.id), {});
    assert.equal(model.canRespond(answered), false);
  } finally { model.close(); await runtime.close(); }
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function questionEvent(id, type, sequence) {
  return { eventId: `${id}:${type}`, runId: "run-a", sequence, type: "tool.lifecycle",
    payload: { type, call: { id, name: "ask_user", status: "ready", input: spec } } };
}
function questionSession(events = []) {
  return Object.assign(new MutableStore({ selectedId: "session-a", available: true, working: false,
    sessions: [{ sessionId: "session-a", status: "active" }] }), {
    run: new MutableStore({ runId: "run-a", terminal: false, events }),
  });
}

test("finished question calls do not keep polling for an interaction that was never created", async () => {
  const sessions = questionSession();
  let reads = 0;
  const read = async () => { reads++; };
  const features = Object.assign(new MutableStore({ sessionId: "session-a", views: [], available: true, pending: false }), { refresh: read, poll: read });
  const model = new InteractionClientModel(features, sessions);
  try {
    sessions.run.update({ events: ["tool.failed", "tool.aborted", "tool.authorization_denied", "tool.completed"].flatMap((type, i) => [
      questionEvent(`call-${i}`, "tool.dispatched", i * 2 + 1), questionEvent(`call-${i}`, type, i * 2 + 2),
    ]) });
    const afterTransition = reads;
    await pause(1100);
    assert.equal(reads, afterTransition, "a later terminal event supersedes the same call's earlier dispatched event");
  } finally { model.close(); }
});

test("question polling and same-session updates let a slow feature response publish", async () => {
  const sessions = questionSession();
  const runtime = new InteractionRuntime(new MemoryInteractionStore());
  const request = await runtime.open(open());
  let release, reads = 0, data = { schemaVersion: 1, sessionId: "session-a", requests: [] };
  let blocked = Promise.resolve();
  const features = new FeaturesClientModel({ async request() {
    reads++; await blocked;
    return { features: [{ key: "conversation-interactions", token: {}, actions: [], data }] };
  } }, sessions);
  const model = new InteractionClientModel(features, sessions);
  try {
    await features.refresh();
    blocked = new Promise(resolve => { release = resolve; });
    data = await runtime.get("session-a");
    const before = reads;
    sessions.run.update({ events: [questionEvent(request.toolCallId, "tool.dispatched", 1)] });
    sessions.update({ title: "same-session update" });
    await pause(1100);
    release();
    await pause(30);
    assert.equal(reads, before + 1, "polls join the pending read instead of invalidating it and starting a successor");
    assert.equal(features.readiness.getSnapshot(), false);
    assert.equal(model.getSnapshot()[0]?.data.id, request.id);
    const afterPublication = reads;
    await pause(550);
    assert.equal(reads, afterPublication, "the recorded request stops the fast poll");
  } finally { release?.(); model.close(); features.close(); await runtime.close(); }
});
