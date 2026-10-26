import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DevelopmentClientModel } from "../dist/development/consumers/webui/model.js";
import { DevelopmentProjectView, DevelopmentConversationCard } from "../dist/development/consumers/webui/view.js";
import { DevelopmentClientUi } from "../dist/development/consumers/webui/index.js";
import { createDevelopmentWebUiControl } from "../dist/development/consumers/webui-control.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";

const timestamp = "2026-10-20T01:00:00.000Z";
const code = { schemaVersion: 1, workspaceRoot: "/workspace", digest: "code-sha", files: [], totalBytes: 0, excluded: [] };
function fixtureProject(revision = 1) {
  const spec = { version: 1, digest: "spec-sha", createdAt: timestamp, objective: "Add tags to papers", scope: ["Tag a paper"], outOfScope: ["Cloud sync"], constraints: ["Local data"], criteria: [{ id: "persist", text: "Tags survive reopening", kind: "technical" }, { id: "comfort", text: "Tags feel easy to use", kind: "user" }], questions: [], assumptions: [], decisions: ["Keep data local"], planMarkdown: "Read the store and implement tags.", assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "One local feature" } };
  return { schemaVersion: 1, id: "project", workspaceRoot: "/workspace", title: "Papers", sessionIds: ["one"], revision, activeChangeId: "change", changes: [{ id: "change", sessionId: "one", rawWish: "Help me find papers by tag", wishUpdates: [], specs: [spec], phase: "exploring", gate: "confirmation", executionEpoch: 1, confirmations: [], starts: [], verifications: [], reports: [], createdAt: timestamp, updatedAt: timestamp }], createdAt: timestamp, updatedAt: timestamp };
}
class Sessions extends SnapshotStore {
  constructor(value = {}) { super({ selectedId: "one", sessions: [{ sessionId: "one", scope: "/workspace", status: "active" }, { sessionId: "two", scope: "/other", status: "active" }], runs: [], available: true, working: false, ...value }); }
  update(value) { this.publish({ ...this.getSnapshot(), ...value }); }
  async refresh() {}
}
function transport(project = fixtureProject()) {
  const requests = [];
  return { requests, project, async request(path, body) {
    requests.push({ path, body });
    if (path.endsWith("/default")) return { value: { projects: [this.project] } };
    if (body) { this.project = { ...this.project, revision: this.project.revision + 1 }; return { value: { project: this.project } }; }
    return { value: { project: path.includes("/one/") ? this.project : null } };
  } };
}

test("development actions bind the displayed project revision and selected active Session", async () => {
  const sessions = new Sessions(), connection = transport(), model = new DevelopmentClientModel(connection, sessions);
  try {
    await model.refresh(); const before = model.getSnapshot().projects[0];
    await model.act("approve-and-start", before, { changeId: "change", specVersion: 1, specDigest: "spec-sha" });
    const request = connection.requests.find(item => item.body);
    assert.equal(request.path, "/api/sessions/one/controls/wish-development");
    assert.equal(request.body.projectId, "project"); assert.equal(request.body.expectedRevision, 1);
    assert.equal(request.body.data.specDigest, "spec-sha"); assert.equal(typeof request.body.requestId, "string");
    const count = connection.requests.filter(item => item.body).length;
    await assert.rejects(model.act("pause", before), /development_revision_conflict/);
    sessions.update({ selectedId: "two" }); await model.refresh();
    await assert.rejects(model.act("pause", model.getSnapshot().projects[0]), /development_session_changed/);
    assert.equal(connection.requests.filter(item => item.body).length, count);
    model.close(); await assert.rejects(model.act("pause", before));
  } finally { model.close(); }
});

test("project reports remain readable without a surviving source Session", async () => {
  const project = fixtureProject(); project.sessionIds = [];
  project.changes[0].phase = "review"; project.changes[0].gate = "user-acceptance";
  project.changes[0].verifications = [{ id: "old-evidence", criterionIds: ["persist"], command: "node persistence.test.mjs", exitCode: 0, timedOut: false, outputDigest: "output-sha", output: "Stored verification output survives the source conversation.", code, startedAt: timestamp, endedAt: timestamp, specVersion: 1, specDigest: "spec-sha", executionEpoch: 0, digest: "evidence-sha" }];
  project.changes[0].reports = [{ id: "report", digest: "report-sha", specVersion: 1, specDigest: "spec-sha", executionEpoch: 1, code, evidenceDigests: [], criteria: [{ criterionId: "persist", status: "unverified", evidenceIds: [] }, { criterionId: "comfort", status: "waiting-user", evidenceIds: [] }], summary: "Tags were implemented; persistence still needs verification.", limitations: ["Restart behavior unverified"], nextSteps: ["Check reopening"], createdAt: timestamp }];
  const sessions = new Sessions({ selectedId: "continuation", sessions: [{ sessionId: "continuation", scope: "/workspace", status: "active" }] }), connection = transport(project), model = new DevelopmentClientModel(connection, sessions);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().projects.length, 1); assert.equal(model.getSnapshot().sessionProjectId, "project");
    const html = renderToStaticMarkup(React.createElement(DevelopmentConversationCard, { model, sessionId: "continuation" }));
    assert.match(html, /Tags were implemented/); assert.match(html, /尚未验证/); assert.match(html, /等待用户体验确认/);
    assert.match(html, /项目交付记录/); assert.match(html, /restart|Restart/); assert.match(html, /code-sha/);
    assert.match(html, /Stored verification output survives/); assert.match(html, /历史验证：不适用于当前版本/);
    assert.doesNotMatch(html, /全部通过|<form|<select|<textarea/);
    assert.equal(model.canAct(project), false);
    const acceptedProject = structuredClone(project);
    acceptedProject.changes[0].reports[0].acceptedAt = timestamp;
    acceptedProject.changes[0].reports[0].acceptedBy = "human";
    const acceptedHtml = renderToStaticMarkup(React.createElement(DevelopmentProjectView, { model, project: acceptedProject }));
    assert.match(acceptedHtml, /用户已确认/); assert.doesNotMatch(acceptedHtml, /等待用户体验确认/);
  } finally { model.close(); }
});

test("late control responses cannot switch the selected Session or replace its project view", async () => {
  const sessions = new Sessions(), connection = transport(), model = new DevelopmentClientModel(connection, sessions);
  try {
    await model.refresh();
    let resolveMutation;
    const original = connection.request.bind(connection);
    connection.request = async (path, body) => body ? new Promise(resolve => { resolveMutation = resolve; }) : original(path, body);
    const pending = model.act("pause", model.getSnapshot().projects[0]);
    sessions.update({ selectedId: "two" });
    resolveMutation({ value: { project: { ...fixtureProject(99), id: "late-project" } } });
    await pending;
    assert.equal(model.getSnapshot().sessionId, "two");
    assert.equal(model.getSnapshot().projects.some(project => project.id === "late-project"), false);
    sessions.update({ selectedId: "one", working: true }); await model.refresh();
    assert.equal(model.canAct(model.getSnapshot().projects[0]), false);
  } finally { model.close(); }
});

test("same-Session work preserves its verified project while actions stay closed until settlement", async () => {
  const sessions = new Sessions(), connection = transport(), model = new DevelopmentClientModel(connection, sessions);
  try {
    await model.refresh();
    const project = model.getSnapshot().projects[0], reads = connection.requests.length;
    assert.equal(model.canAct(project), true);
    sessions.update({ working: true });
    await model.refresh();
    assert.equal(model.getSnapshot().sessionProjectId, project.id);
    assert.equal(model.getSnapshot().projects[0], project);
    assert.match(renderToStaticMarkup(React.createElement(DevelopmentConversationCard, { model, sessionId: "one" })), /Add tags to papers/);
    assert.equal(connection.requests.length, reads, "work does not re-read using an empty Session binding");
    assert.equal(model.canAct(project), false);
    await assert.rejects(model.act("approve-and-start", project), /development_session_changed/);
    sessions.update({ working: true, runs: [{ runId: "new-run", status: "running" }] });
    await model.refresh();
    assert.equal(model.getSnapshot().sessionProjectId, project.id);
    assert.equal(connection.requests.length, reads);
    connection.project = fixtureProject(2);
    sessions.update({ working: false });
    assert.equal(model.canAct(project), false, "actions wait for the settled Session's freshness read");
    await model.refresh();
    assert.equal(model.getSnapshot().projects[0].revision, 2);
    assert.equal(model.getSnapshot().sessionProjectId, project.id);
    assert.equal(model.canAct(model.getSnapshot().projects[0]), true);
    sessions.update({ working: true, selectedId: "two" });
    assert.equal(model.getSnapshot().sessionProjectId, null, "a real Session change still revokes the binding synchronously");
    sessions.update({ selectedId: null });
    await model.refresh();
    assert.equal(model.getSnapshot().sessionId, null);
    assert.equal(model.getSnapshot().sessionProjectId, null);
  } finally { model.close(); }
});

test("confirmation is reachable for a proposed exploring spec and does not claim execution", async () => {
  const project = fixtureProject(), sessions = new Sessions(), connection = transport(project), model = new DevelopmentClientModel(connection, sessions);
  try {
    await model.refresh();
    const html = renderToStaticMarkup(React.createElement(DevelopmentProjectView, { model, project }));
    assert.match(html, /查看方案并确认/); assert.match(html, /验收标准/); assert.match(html, /目标、方案与进展/);
    assert.doesNotMatch(html, /<details[^>]*\sopen|<form|<select|<textarea|wish-development-page/);
    assert.equal(connection.requests.some(item => item.body), false);
    const card = renderToStaticMarkup(React.createElement(DevelopmentConversationCard, { model, sessionId: "one" }));
    assert.match(card, /Add tags to papers/); assert.match(card, /开发目标/);
    assert.equal(renderToStaticMarkup(React.createElement(DevelopmentConversationCard, { model, sessionId: "two" })), "");
  } finally { model.close(); }
});

test("development presentation contributes only an inline conversation card and releases it on unload", async () => {
  const sessions = new Sessions(), connection = transport(), cards = [], effects = [];
  DevelopmentClientUi.apply({ wishConnection: connection, wishSession: sessions,
    wishUiSlots: { conversationCard(card) { cards.push(card); return () => cards.splice(cards.indexOf(card), 1); }, panel() { assert.fail("Conversation development must not add a separate product page"); } },
    effect(factory) { const release = factory(); if (typeof release === "function") effects.push(release); },
  });
  try { assert.equal(cards.length, 1); assert.equal(cards[0].id, "wish-development"); }
  finally { for (const release of effects.reverse()) release(); }
  assert.equal(cards.length, 0);
});

test("WebUI development control keeps project reads Session-independent and rejects unbounded envelopes", async () => {
  let inspections = 0, controls = 0;
  const project = fixtureProject();
  const control = createDevelopmentWebUiControl({ async list() { return [project]; }, async inspect() { inspections++; return { project }; }, async control(application, sessionId, body) { controls++; assert.equal(sessionId, "one"); assert.equal(body.requestId, "request"); return { project }; } });
  const application = { async getSession() { return { status: "active" }; } }, signal = new AbortController().signal;
  assert.equal((await control.inspectDefault({}, signal)).projects[0].id, "project"); assert.equal(inspections, 0);
  assert.equal((await control.inspectSession(application, "one", signal)).project.id, "project");
  await assert.rejects(control.updateSession(application, "one", { action: "open", requestId: "request", rawShell: "ignored" }, signal), /required/);
  assert.equal(controls, 0);
  await control.updateSession(application, "one", { action: "open", requestId: "request", data: { rawWish: "wish" } }, signal); assert.equal(controls, 1);
  await assert.rejects(control.updateSession({ async getSession() { return { status: "archived" }; } }, "one", { action: "pause", requestId: "request" }, signal), /read-only/);
  assert.equal(controls, 1);
});
