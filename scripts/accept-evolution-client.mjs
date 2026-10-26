import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EvolutionClientModel } from "../dist/evolution/consumers/webui/model.js";
import { EvolutionView } from "../dist/evolution/consumers/webui/view.js";
import { createEvolutionControl } from "../dist/evolution/consumers/webui-control.js";
import { campaignView } from "../dist/evolution/presentation.js";
import { promptCandidate } from "../dist/evolution/generator.js";
import { digest } from "../dist/agent-profiles/validation.js";
const campaign = (id = "one", revision = 1) => ({ id, revision, state: "awaiting-external-validation", spec: { objective: "Improve verification", maxRounds: 3, context: { workspaceRoot: "/workspace", sessionId: "session" } }, attempts: [], updatedAt: "2026-10-22T01:00:00Z" });
test("presentation describes development state and never uses fabricated effectiveness scores", async () => {
  const model = new EvolutionClientModel({ async request() { return { value: { available: true, campaigns: [campaign()], traces: [] } }; } });
  const stop = model.activate("session");
  try {
    await model.refresh();
    const html = renderToStaticMarkup(React.createElement(EvolutionView, { model, sessionId: "session" }));
    assert.match(html, /候选已准备/); assert.match(html, /外部效果评测尚未接入/);
    assert.doesNotMatch(html, /Pass@1|成功率|提升率|分数|已正式发布/);
    assert.match(html, /根据反馈继续/);
  } finally { stop(); }
});
test("late reads from another Session cannot overwrite the selected improvement records", async () => {
  let finish;
  const model = new EvolutionClientModel({ request: async path => path.includes("/old/") ? new Promise(resolve => { finish = resolve; }) : { value: { available: true, campaigns: [campaign("new")], traces: [] } } });
  const oldStop = model.activate("old"), pending = model.refresh(); oldStop();
  const stop = model.activate("new");
  try { await model.refresh(); finish({ value: { available: true, campaigns: [campaign("old")], traces: [] } }); await pending; assert.equal(model.getSnapshot().campaigns[0].id, "new"); }
  finally { stop(); }
});
test("actions bind the displayed revision; failed submission preserves retry identity", async () => {
  const calls = []; let fail = true;
  const model = new EvolutionClientModel({ async request(path, body) {
    if (!body) return { value: { available: true, campaigns: [campaign()], traces: [] } };
    calls.push(body); if (fail) throw new Error("offline"); return { value: { campaign: campaign("created") } };
  } });
  const stop = model.activate("session");
  try { await model.refresh(); await assert.rejects(model.create("Improve validation", "prompt"), /offline/); fail = false; await model.create("Improve validation", "prompt"); assert.equal(calls[0].requestId, calls[1].requestId); await assert.rejects(model.act(campaign("one", 99), "cancel"), /conflict/); }
  finally { stop(); }
});
test("Host controls derive workspace from the real Session and reject cross-workspace or forged evaluation actions", async () => {
  const rows = [campaign(), { ...campaign("other"), spec: { context: { workspaceRoot: "/other" } } }];
  const port = createEvolutionControl({ available: true, list: async () => rows, traces: async () => [], get: async id => rows.find(item => item.id === id), begin: async input => { assert.equal(input.workspaceRoot, "/workspace"); return campaign(); } });
  const application = { getSession: async () => ({ status: "active", scope: "/workspace" }) }, signal = new AbortController().signal;
  assert.equal((await port.inspectSession(application, "session", signal)).campaigns.length, 1);
  await assert.rejects(port.updateSession(application, "session", { action: "create", requestId: "x", objective: "Improve", workspaceRoot: "/other" }, signal), /action|identity/);
  await assert.rejects(port.updateSession(application, "session", { action: "publish", requestId: "x", campaignId: "other", expectedRevision: 1 }, signal), /another workspace/);
  await port.updateSession(application, "session", { action: "create", requestId: "x", objective: "Improve" }, signal);
});
test("polling cannot overwrite an in-flight mutation and Host revision conflicts remain actionable", async () => {
  let release, reads = 0;
  const model = new EvolutionClientModel({ async request(_path, body) {
    if (body) return new Promise(resolve => { release = resolve; });
    reads++; return { value: { available: true, campaigns: [campaign("one", reads > 1 ? 2 : 1)], traces: [] } };
  } });
  const stop = model.activate("session");
  try {
    await model.refresh(); const pending = model.act(campaign(), "cancel");
    await model.refresh(); assert.equal(reads, 1);
    release({ value: { campaign: campaign("one", 2) } }); await pending;
    assert.equal(model.getSnapshot().campaigns[0].revision, 2); assert.equal(reads, 2);
  } finally { stop(); }
  const port = createEvolutionControl({ available: true, get: async () => campaign(), control: async () => { const error = new Error("evolution_revision_conflict"); error.code = "evolution_revision_conflict"; throw error; } });
  await assert.rejects(port.updateSession({ getSession: async () => ({ status: "active", scope: "/workspace" }) }, "session", { action: "cancel", requestId: "cancel", campaignId: "one", expectedRevision: 1 }, new AbortController().signal), error => error.status === 409 && error.code === "evolution_revision_conflict");
});
test("reconnected reads clear transient errors while retaining an unresolved action failure", async () => {
  let offline = true;
  const model = new EvolutionClientModel({ async request(_path, body) {
    if (offline) throw new Error("temporary_read_failure");
    if (body) throw new Error("evolution_conflict");
    return { value: { available: true, campaigns: [campaign()], traces: [] } };
  } });
  const stop = model.activate("session");
  try {
    await model.refresh(); assert.equal(model.getSnapshot().error, "temporary_read_failure");
    offline = false; await model.refresh(); assert.equal(model.getSnapshot().error, null);
    await assert.rejects(model.act(campaign(), "cancel"), /evolution_conflict/);
    await model.refresh(); assert.equal(model.getSnapshot().error, "evolution_conflict");
  } finally { stop(); }
});
test("two retained Evolution windows in one Session have distinct accessible form identities", () => {
  const model = new EvolutionClientModel({ request: async () => { throw new Error("not mounted"); } });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(EvolutionView, { model, sessionId: "same-session" }), React.createElement(EvolutionView, { model, sessionId: "same-session" })));
  const ids = [...html.matchAll(/<textarea id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.ok(html.includes(`for="${id}"`));
});
test("polling omits full source and transcripts; read-only details bind the exact candidate bytes and workspace", async () => {
  const source = promptCandidate({ id: "details", version: 1, content: "Review evidence first.", purpose: "A hypothesis", runId: "run" });
  const full = { ...campaign(), attempts: [{ id: "attempt", round: 1, operations: [{ id: "op", stage: "generate", status: "completed", receipt: { source } }], proposal: { id: "proposal", target: "prompt", ticketIds: [], rationale: "A hypothesis", source }, evidence: { tickets: [], traces: [{ id: "trace", digest: "a".repeat(64), runId: "run", sessionId: "session", taskOutcome: "unknown", sourceKind: "production", terminalStatus: "run.completed", capturedAt: "2026-10-22T01:00:00Z", evidenceRefs: [], summary: "unknown", untrustedTranscript: "RAW_TRANSCRIPT_MARKER" }] } }] };
  const view = campaignView(full);
  assert.equal(view.attempts[0].proposal.source.files, undefined); assert.ok(view.attempts[0].proposal.fileNames.includes("index.ts"));
  assert.equal(view.attempts[0].operations[0].receipt, undefined); assert.equal(JSON.stringify(view).includes("RAW_TRANSCRIPT_MARKER"), false);
  const control = createEvolutionControl({ available: true, get: async () => full });
  const application = { getSession: async () => ({ scope: "/workspace" }) }, signal = new AbortController().signal;
  const query = { action: "source", campaignId: full.id, attemptId: "attempt", sourceDigest: digest(source) };
  assert.deepEqual((await control.querySession(application, "session", query, signal)).source, source);
  await assert.rejects(control.querySession(application, "session", { ...query, sourceDigest: "f".repeat(64) }, signal), error => error.code === "evolution_source_changed");
  await assert.rejects(control.querySession({ getSession: async () => ({ scope: "/another" }) }, "session", query, signal), error => error.status === 404);
});
test("late source reads cannot return data into another Session", async () => {
  let finish;
  const model = new EvolutionClientModel({ request: async path => path.includes("/queries/") ? new Promise(resolve => { finish = resolve; }) : { value: { campaigns: [campaign()], traces: [], available: true } } });
  const oldStop = model.activate("old"); await model.refresh(); const reading = model.source(campaign(), "attempt", "a".repeat(64)); oldStop();
  const stop = model.activate("new");
  try { finish({ value: { sourceDigest: "a".repeat(64), source: { files: {} } } }); await assert.rejects(reading, /source_view_changed/); }
  finally { stop(); }
});
test("failed measured stages expose accounting and explicit continuation without a score", async () => {
  const record = { ...campaign(), state: "failed", elapsedMs: 1234, usage: { modelCalls: 1, tokens: 45, costByCurrency: { CNY: null }, complete: true },
    spec: { ...campaign().spec, baselineSnapshotDigest: "a".repeat(64), budget: { modelCalls: 3, tokens: 1000 } }, attempts: [{ id: "attempt", round: 1, operations: [{ id: "generate", stage: "generate", status: "failed", failure: { reason: "Malformed JSON" } }] }] };
  const model = new EvolutionClientModel({ request: async () => ({ value: { campaigns: [record], traces: [], available: true } }) }), stop = model.activate("session");
  try {
    await model.refresh(); const html = renderToStaticMarkup(React.createElement(EvolutionView, { model, sessionId: "session" }));
    assert.match(html, /已确认失败/); assert.match(html, /CNY 金额未知/); assert.match(html, /根据反馈继续/); assert.doesNotMatch(html, /成功率|Pass@1/);
  } finally { stop(); }
});
