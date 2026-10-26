import test from "node:test";
import assert from "node:assert/strict";
import { FeaturesClientModel } from "../dist/apps/webui/client/model/features.js";
import { ApprovalClientModel } from "../dist/approval/consumers/webui/model.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { ClientApiError } from "../dist/apps/webui/client/connection.js";
import { ReasoningClientModel } from "../dist/models/consumers/webui/reasoning-model.js";
import { PermissionProfileClientModel } from "../dist/permissions/consumers/webui/profile-model.js";

class Sessions extends SnapshotStore {
  constructor(value) { super({ sessions: [], ...value }); }
  update(value) { this.publish({ ...this.getSnapshot(), ...value }); }
}
test("feature actions carry the displayed token, reject changed session, and close their admission", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true });
  const view = { key: "custom-feature", title: "Custom", text: "v1", token: { version: 1 }, actions: [{ name: "keep", label: "Keep" }] };
  const updated = { ...view, text: "v2", token: { version: 2 } };
  const requests = [], connection = { async request(path, body) { requests.push({ path, body }); return { features: [body ? updated : view] }; } };
  const model = new FeaturesClientModel(connection, sessions);
  await model.refresh(); const beforeAction = requests.length;
  await model.act("one", view, "keep", "feedback");
  assert.equal(requests.length, beforeAction + 1, "a successful action adopts its response without a duplicate GET");
  assert.deepEqual(requests.at(-1).body, { token: { version: 1 }, action: "keep", feedback: "feedback" });
  assert.equal(model.getSnapshot().views[0].text, "v2");
  sessions.update({ selectedId: "two", available: true }); await model.refresh();
  const afterSelection = requests.length;
  await assert.rejects(model.act("one", view, "keep", "")); assert.equal(requests.length, afterSelection);
  model.close(); await assert.rejects(model.act("two", view, "keep", "")); assert.equal(requests.length, afterSelection);
});
test("approval model cannot approve another selected Run or submit after owner removal", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, runs: [{ runId: "r", status: "running" }] });
  const approval = { approvalId: "request", scope: { runId: "r" } }, writes = [];
  const connection = { async request(path, body) { if (body) writes.push(body); return { approvals: [approval] }; } };
  const model = new ApprovalClientModel(connection, sessions);
  try {
    await model.refresh(); await model.decide(approval, true, "once"); assert.deepEqual(writes, [{ approved: true, scope: "once" }]);
    sessions.update({ selectedId: "two", available: true, runs: [{ runId: "other", status: "running" }] });
    await assert.rejects(model.decide(approval, true, "workspace"));
    model.close(); await assert.rejects(model.decide(approval, false, "once")); assert.equal(writes.length, 1);
  } finally { model.close(); }
});

test("feature reads and actions pause during Session mutations and discard in-flight results", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, working: false });
  const view = { key: "custom-feature", title: "Custom", text: "v1", token: { version: 1 }, actions: [{ name: "keep", label: "Keep" }] };
  let reads = 0, pending;
  const connection = { async request() { reads++; return pending ? await pending : { features: [view] }; } };
  const model = new FeaturesClientModel(connection, sessions);
  try {
    await model.refresh();
    const initial = reads;
    sessions.update({ working: true }); await model.refresh();
    await assert.rejects(model.act("one", view, "keep", ""));
    assert.equal(reads, initial, "mutation notifications must not read or act on a resource being deleted");
    sessions.update({ working: false }); await model.refresh();
    assert.ok(reads > initial, "failed or completed mutations resume reads");

    let release;
    pending = new Promise(resolve => { release = resolve; });
    const inFlight = model.refresh(), beforeMutation = reads;
    sessions.update({ working: true });
    release({ features: [{ ...view, text: "stale" }] });
    await inFlight;
    assert.equal(reads, beforeMutation);
    assert.equal(model.getSnapshot().views[0].text, "v1", "pre-mutation results cannot overwrite current features");
    sessions.update({ selectedId: null, working: false }); await model.refresh();
    assert.equal(reads, beforeMutation);
    assert.equal(model.getSnapshot().sessionId, null);
    assert.deepEqual(model.getSnapshot().views, []);
  } finally { model.close(); }
});

class Connection extends SnapshotStore {
  requests = [];
  constructor(read) { super({ online: true, businessAvailable: true, instanceId: "host-a" }); this.read = read; }
  onInvalidation() { return () => {}; }
  update(value) { this.publish({ ...this.getSnapshot(), ...value }); }
  async request(path, body) { this.requests.push({ path, body }); return this.read(path, body); }
}

test("feature read failures preserve their displayed cards but revoke writes; real empty results and changed tokens remain authoritative", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, working: false });
  const view = { key: "plan", title: "Plan", text: "review this version", token: { version: 1 }, actions: [{ name: "approve", label: "Approve" }] };
  let failing = false, features = [view];
  const connection = new Connection(async () => { if (failing) throw Error("temporary read failure"); return { features }; });
  const model = new FeaturesClientModel(connection, sessions);
  try {
    await model.refresh();
    const verified = model.getSnapshot().views;
    failing = true; await model.refresh();
    assert.strictEqual(model.getSnapshot().views, verified);
    assert.equal(model.getSnapshot().available, false);
    const reads = connection.requests.length;
    await assert.rejects(model.act("one", view, "approve", ""));
    assert.equal(connection.requests.length, reads, "display retention does not retain old action admission");
    failing = false; features = [{ ...view, token: { version: 2 } }]; await model.refresh();
    await assert.rejects(model.act("one", view, "approve", ""), /操作已不可用/u);
    features = []; await model.refresh();
    assert.deepEqual(model.getSnapshot().views, [], "a successful empty feature response removes cleared Goal/Todo/Plan/Workflow state");
  } finally { model.close(); }
});

test("a replacement Host clears feature tokens immediately and fences the previous Host's late action response", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, working: false });
  const view = { key: "goal", title: "Goal", text: "host-a", token: { version: 1 }, actions: [{ name: "pause", label: "Pause" }] };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = new Connection(async (_path, body) => body ? await gate : { features: [{ ...view, text: connection.getSnapshot().instanceId }] });
  const model = new FeaturesClientModel(connection, sessions);
  try {
    await model.refresh();
    const acting = model.act("one", model.getSnapshot().views[0], "pause", "");
    connection.update({ instanceId: "host-b" });
    assert.deepEqual(model.getSnapshot().views, []);
    assert.equal(model.getSnapshot().available, false);
    await model.refresh();
    release({ features: [{ ...view, text: "retired action response" }] }); await acting;
    assert.equal(model.getSnapshot().views[0].text, "host-b");
    assert.equal(model.getSnapshot().pending, false);
  } finally { release(); model.close(); }
});

for (const [name, Model, value, choice] of [
  ["reasoning", ReasoningClientModel, { model: { provider: "fixture", model: "fixture" }, control: { format: "deepseek-chat", efforts: ["low", "high"], defaultEffort: "high" } }, "low"],
  ["permissions", PermissionProfileClientModel, { availableProfiles: ["read-only", "workspace-write"], selected: "read-only", source: "session", shellBackend: "linux-native", workspaceIsolation: false }, "workspace-write"],
]) test(name + " keeps the selected composer value during read failure without permitting stale writes or late cross-Host receipts", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, working: false });
  let failing = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = new Connection(async (_path, body) => {
    if (body) return await gate;
    if (failing) throw Error("temporary read failure");
    return { value };
  });
  const model = new Model(connection, sessions);
  try {
    await model.refresh();
    const verified = model.getSnapshot().view;
    failing = true; await model.refresh();
    assert.strictEqual(model.getSnapshot().view, verified);
    assert.equal(model.getSnapshot().writable, false);
    const requests = connection.requests.length;
    await assert.rejects(model.select(choice));
    assert.equal(connection.requests.length, requests);
    failing = false; await model.refresh();
    assert.equal(model.getSnapshot().writable, true);
    const selecting = model.select(choice);
    connection.update({ instanceId: "host-b" });
    assert.equal(model.getSnapshot().view, null);
    await model.refresh();
    release({ value: { ...value, selected: choice } }); await selecting;
    assert.deepEqual(model.getSnapshot().view, value, "a retired Host response cannot change the new Host's displayed setting");
    assert.equal(model.getSnapshot().pending, false);
    sessions.update({ working: true });
    assert.equal(model.getSnapshot().writable, false);
    assert.deepEqual(model.getSnapshot().view, value, "a Session mutation disables admission without flashing a new loading placeholder");
  } finally { release(); model.close(); }
});

test("approval failures keep the request visible and disabled while terminal or changed Run scope removes it", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, runs: [{ runId: "r", status: "running" }] });
  const approval = { approvalId: "request", scope: { runId: "r" } };
  let failing = false;
  const connection = new Connection(async () => { if (failing) throw Error("temporary"); return { approvals: [approval] }; });
  const model = new ApprovalClientModel(connection, sessions);
  try {
    await model.refresh(); const verified = model.getSnapshot().approvals;
    failing = true; await model.refresh();
    assert.strictEqual(model.getSnapshot().approvals, verified);
    assert.equal(model.getSnapshot().available, false);
    await assert.rejects(model.decide(approval, true, "once"));
    sessions.update({ runs: [{ runId: "r", status: "completed" }] });
    assert.deepEqual(model.getSnapshot().approvals, [], "a terminal Run does not keep obsolete approval UI from the display cache");
  } finally { model.close(); }
});

test("Session working transitions retain the same approval display while submission awaits authoritative revalidation", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true, working: false, runs: [{ runId: "r", status: "running" }] });
  const approval = { approvalId: "request", scope: { runId: "r" } };
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = new Connection(async () => { if (held) await gate; return { approvals: [approval] }; });
  const model = new ApprovalClientModel(connection, sessions);
  try {
    await model.refresh(); const verified = model.getSnapshot().approvals;
    sessions.update({ working: true }); await model.refresh();
    assert.strictEqual(model.getSnapshot().approvals, verified, "a mutation does not unmount a visible approval and its selected scope");
    assert.equal(model.getSnapshot().available, false);
    await assert.rejects(model.decide(approval, true, "once"));
    held = true; sessions.update({ working: false });
    assert.strictEqual(model.getSnapshot().approvals, verified, "settling keeps the display while the resumed authority read is pending");
    assert.equal(model.getSnapshot().available, false);
    await assert.rejects(model.decide(approval, true, "once"));
    release(); await model.refresh();
    assert.equal(model.getSnapshot().available, true);
    assert.equal(model.getSnapshot().approvals[0].approvalId, approval.approvalId);
    assert.equal(connection.requests.some(request => request.body), false);
  } finally { release(); model.close(); }
});

const reasoningChoice = { model: { provider: "fixture", model: "fixture" }, control: { efforts: ["low", "high"], defaultEffort: "high" } };
const permissionChoice = { availableProfiles: ["read-only", "workspace-write"], selected: "read-only" };
const featureChoice = { key: "goal", token: { revision: 1 }, actions: [{ name: "pause", label: "Pause" }] };
const approvalChoice = { approvalId: "approval", scope: { runId: "r" } };
for (const [name, Model, response, content, act] of [
  ["reasoning", ReasoningClientModel, { value: reasoningChoice }, state => state.view, model => model.select("low")],
  ["permission", PermissionProfileClientModel, { value: permissionChoice }, state => state.view, model => model.select("workspace-write")],
  ["features", FeaturesClientModel, { features: [featureChoice] }, state => state.views, model => model.act("one", featureChoice, "pause", "")],
  ["approval", ApprovalClientModel, { approvals: [approvalChoice] }, state => state.approvals, model => model.decide(approvalChoice, true, "once")],
]) {
  test(name + " distinguishes temporary read failure from explicit resource revocation", async () => {
    const sessions = new Sessions({ selectedId: "one", available: true, working: false, runs: [{ runId: "r", status: "running" }] });
    let failure;
    const connection = new Connection(async () => { if (failure) throw failure; return response; });
    const model = new Model(connection, sessions);
    try {
      await model.refresh(); const verified = content(model.getSnapshot());
      for (const error of [new ClientApiError("business_unavailable", 503), new ClientApiError("unknown_route", 404), Error("temporary network failure")]) {
        failure = error; await model.refresh();
        assert.strictEqual(content(model.getSnapshot()), verified, "temporary or unrecognized errors retain the verified read-only display");
        assert.equal(model.getSnapshot().writable ?? model.getSnapshot().available, false);
      }
      for (const [code, status] of [["control_not_found", 404], ["session_not_found", 404], ["forbidden", 403], ["unauthorized", 401]]) {
        failure = undefined; await model.refresh();
        assert.ok(content(model.getSnapshot()));
        failure = new ClientApiError(code, status); await model.refresh();
        const remaining = content(model.getSnapshot());
        assert.ok(remaining === null || remaining.length === 0, code + " clears the revoked presentation");
        assert.equal(model.getSnapshot().writable ?? model.getSnapshot().available, false);
      }
    } finally { model.close(); }
  });
  test(name + " clears a revoked POST display even when the following freshness read fails temporarily", async () => {
    const sessions = new Sessions({ selectedId: "one", available: true, working: false, runs: [{ runId: "r", status: "running" }] });
    let failReads = false;
    const connection = new Connection(async (_path, body) => {
      if (body) throw new ClientApiError("forbidden", 403);
      if (failReads) throw new ClientApiError("business_unavailable", 503);
      return response;
    });
    const model = new Model(connection, sessions);
    try {
      await model.refresh(); failReads = true;
      await assert.rejects(act(model), error => error instanceof ClientApiError && error.status === 403);
      await model.refresh();
      const remaining = content(model.getSnapshot());
      assert.ok(remaining === null || remaining.length === 0, "a later temporary read must not restore revoked content");
      assert.equal(model.getSnapshot().writable ?? model.getSnapshot().available, false);
    } finally { model.close(); }
  });
}
