import test from "node:test";
import assert from "node:assert/strict";
import { FeaturesClientModel } from "../dist/apps/webui/client/model/features.js";
import { ApprovalClientModel } from "../dist/approval/consumers/webui/model.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";

class Sessions extends SnapshotStore {
  constructor(value) { super({ sessions: [], ...value }); }
  update(value) { this.publish({ ...this.getSnapshot(), ...value }); }
}
test("feature actions carry the displayed token, reject changed session, and close their admission", async () => {
  const sessions = new Sessions({ selectedId: "one", available: true });
  const view = { key: "custom-feature", title: "Custom", text: "v1", token: { version: 1 }, actions: [{ name: "keep", label: "Keep" }] };
  const requests = [], connection = { async request(path, body) { if (body) requests.push({ path, body }); return { features: [view] }; } };
  const model = new FeaturesClientModel(connection, sessions);
  await model.refresh(); await model.act("one", view, "keep", "feedback");
  assert.deepEqual(requests[0].body, { token: { version: 1 }, action: "keep", feedback: "feedback" });
  sessions.update({ selectedId: "two", available: true }); await model.refresh();
  await assert.rejects(model.act("one", view, "keep", "")); assert.equal(requests.length, 1);
  model.close(); await assert.rejects(model.act("two", view, "keep", "")); assert.equal(requests.length, 1);
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
