import test from "node:test";
import assert from "node:assert/strict";
import { RunClientModel } from "../dist/apps/webui/client/model/run.js";
import { SessionClientModel } from "../dist/apps/webui/client/model/session.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { projectLedger } from "../dist/apps/webui/client/projection/ledger.js";
import { groupSessionsByWorkspace, projectWorkspaceChoices } from "../dist/apps/webui/client/projection/sessions.js";

test("active and archived Sessions group by exact Host workspace identity without merging equal folder names", () => {
  const sessions = Object.freeze([
    Object.freeze({ sessionId: "a", scope: "/home/user/one/wish", status: "active" }),
    Object.freeze({ sessionId: "b", scope: "/home/user/two/wish", status: "active" }),
    Object.freeze({ sessionId: "c", scope: "/home/user/one/wish", status: "active" }),
    Object.freeze({ sessionId: "old-a", scope: "/home/user/one/wish", status: "archived" }),
    Object.freeze({ sessionId: "old-b", scope: "/home/user/two/wish", status: "archived" }),
  ]);
  const active = groupSessionsByWorkspace(sessions, "active"), archived = groupSessionsByWorkspace(sessions, "archived");
  assert.deepEqual(active.map(group => group.sessions.map(item => item.sessionId)), [["a", "c"], ["b"]]);
  assert.deepEqual(archived.map(group => group.sessions.map(item => item.sessionId)), [["old-a"], ["old-b"]]);
  assert.notEqual(active[0].label, active[1].label);
  assert.equal(active[0].scope, archived[0].scope);
  assert.ok(Object.isFrozen(active) && Object.isFrozen(active[0]) && Object.isFrozen(active[0].sessions));
  assert.equal(active[0].sessions[0], sessions[0]);
  assert.deepEqual(groupSessionsByWorkspace([], "active"), []);
  const choices = projectWorkspaceChoices(sessions);
  assert.equal(choices.length, 2);
  assert.equal(choices[0].root, "/home/user/one/wish");
  assert.deepEqual(projectWorkspaceChoices([]), [], "a configured Host root is not a user choice");
  assert.equal(choices.find(item => item.root === "/home/user/one/wish").sessionCount, 3);
  assert.notEqual(choices.find(item => item.root === "/home/user/one/wish").label, choices.find(item => item.root === "/home/user/two/wish").label);
});

test("new Session stays browser-only until an explicit Workspace is confirmed", async () => {
  class Connection extends SnapshotStore {
    sessions = [{ sessionId: "a", scope: "/work/one", status: "active" }];
    writes = [];
    constructor() { super({ online: true, businessAvailable: true, instanceId: "one" }); }
    onInvalidation() { return () => {}; }
    stream() { return { addEventListener() {}, close() {} }; }
    async request(path, body) {
      if (path === "/api/sessions" && body) {
        this.writes.push(body);
        const session = { sessionId: "created", scope: body.workspaceRoot, status: "active" };
        this.sessions = [...this.sessions, session];
        return { session };
      }
      if (path === "/api/sessions") return { sessions: this.sessions, workspaceRoot: "/work/default" };
      if (path.endsWith("/history")) return { history: { sessionId: path.split("/")[3], historyRevision: "v1", records: [] } };
      return { runs: [] };
    }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().selectedId, "a");
    assert.equal("defaultWorkspaceRoot" in model.getSnapshot(), false, "Host deployment root never becomes a Browser selection");
    model.select("a");
    model.startCreate();
    assert.equal(model.getSnapshot().creating, true);
    assert.equal(model.getSnapshot().selectedId, null);
    assert.equal(connection.writes.length, 0, "opening the creation view must not create a Host Session");
    model.browse("active");
    assert.equal(model.getSnapshot().selectedId, "a", "cancel restores the previously selected Session");
    model.startCreate();
    assert.equal(connection.writes.length, 0);
    await assert.rejects(model.create("  "), /选择工作区/);
    assert.equal(await model.create("/work/two"), "created");
    assert.deepEqual(connection.writes, [{ workspaceRoot: "/work/two" }]);
    assert.equal(model.getSnapshot().creating, false);
    assert.equal(model.getSnapshot().selectedId, "created");
  } finally { model.close(); }
});

test("ledger projection prefers canonical transcript, joins tool input/result and safely retains unknown tools", () => {
  const base = { kind: "message", runId: "r", userTurnId: "turn", stepId: "step", createdAt: "2026-09-14T00:00:00Z" };
  const history = { records: [
    { ...base, recordId: "one", origin: "assistant", message: { role: "assistant", content: "Canonical answer", toolCalls: [{ id: "call", name: "future_tool", argumentsJson: "{}" }] } },
    { ...base, recordId: "two", origin: "tool", message: { role: "tool", content: "Stored result", toolCallId: "call" } },
  ] };
  const live = [{ runId: "r", userTurnId: "turn", stepId: "step", occurredAt: base.createdAt, type: "model.stream", payload: { type: "text_delta", text: "Live duplicate" } }];
  const blocks = projectLedger(history, live).flatMap(turn => turn.blocks);
  assert.equal(blocks.length, 2); assert.equal(blocks[0].text, "Canonical answer");
  assert.equal(blocks[1].toolName, "future_tool"); assert.equal(blocks[1].text, "Stored result"); assert.equal(blocks[1].input, "{}");
});

class Stream {
  listeners = new Map(); closed = false;
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  close() { this.closed = true; }
  emit(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
}

test("Session actions keep archive selection separate, preserve history on rename and discard stale reads", async () => {
  class Connection extends SnapshotStore {
    sessions = [{ sessionId: "a", status: "active", title: "A" }, { sessionId: "b", status: "active", title: "B" }, { sessionId: "old", status: "archived" }];
    writes = []; gate; fail = false;
    constructor() { super({ online: true, businessAvailable: true, instanceId: "one" }); }
    onInvalidation() { return () => {}; }
    stream() { return new Stream(); }
    async request(path, body, method) {
      if (body) {
        this.writes.push({ path, body, method });
        if (this.fail) throw new Error("session_busy");
        const id = path.split("/")[3], session = this.sessions.find(item => item.sessionId === id);
        if (method === "DELETE") { this.sessions = this.sessions.filter(item => item !== session); return {}; }
        const changed = { ...session, ...(body.title ? { title: body.title } : { status: path.endsWith("/archive") ? "archived" : "active" }) };
        this.sessions = this.sessions.map(item => item === session ? changed : item); return { session: changed };
      }
      if (path === "/api/sessions") { const sessions = this.sessions; if (this.gate) await this.gate; return { sessions }; }
      if (path.endsWith("/history")) return { history: { sessionId: path.split("/")[3], historyRevision: "v1", records: [] } };
      return { runs: [] };
    }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    await model.refresh(); const history = model.getSnapshot().history;
    await model.rename("a", " New A "); assert.equal(model.getSnapshot().sessions[0].title, "New A");
    assert.equal(model.getSnapshot().history, history);
    await assert.rejects(model.rename("a", " "), /1–256/);
    await model.archive("a"); assert.equal(model.getSnapshot().selectedId, "b");
    model.browse("archived"); model.select("a"); await model.refresh();
    await assert.rejects(model.send("hello", "queue"), /归档/);
    await model.restore("a"); assert.equal(model.getSnapshot().selectedId, "old");
    model.browse("active"); model.select("a"); await model.refresh();
    connection.fail = true; await assert.rejects(model.delete("a"), /session_busy/);
    assert.equal(model.getSnapshot().selectedId, "a"); connection.fail = false;
    let release; connection.gate = new Promise(resolve => { release = resolve; });
    const reading = model.refresh(); await new Promise(resolve => setImmediate(resolve));
    const removing = model.delete("a"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().selectedId, "b"); assert.equal(model.getSnapshot().history, null);
    connection.gate = undefined; release(); await Promise.all([reading, removing]);
    assert.equal(model.getSnapshot().sessions.some(item => item.sessionId === "a"), false);
    assert.equal(model.getSnapshot().history.sessionId, "b");
    await model.delete("b"); assert.equal(model.getSnapshot().selectedId, null, "only archived sessions do not auto-select in the active workspace");
    assert.equal(model.getSnapshot().sessions[0].status, "archived");
  } finally { model.close(); }
});
const event = (sequence, payload) => ({ schemaVersion: 1, eventId: String(sequence), runId: "r", sequence, type: "runtime.transition", occurredAt: "2026-09-14T00:00:00Z", payload });
test("active/archive browsing remembers independent selections, rejects stale history and never mutates Host", async () => {
  class Connection extends SnapshotStore {
    sessions = ["a", "b", "old-a", "old-b"].map(sessionId => ({ sessionId, status: sessionId.startsWith("old") ? "archived" : "active" }));
    gate;
    constructor() { super({ online: true, businessAvailable: true, instanceId: "one" }); }
    onInvalidation() { return () => {}; }
    stream() { return new Stream(); }
    async request(path, body) {
      assert.equal(body, undefined, "browsing must not issue Host mutations");
      if (path === "/api/sessions") return { sessions: this.sessions };
      if (path.endsWith("/history")) {
        if (this.gate) await this.gate;
        return { history: { sessionId: path.split("/")[3], historyRevision: "v1", records: [] } };
      }
      return { runs: [] };
    }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    await model.refresh(); model.select("b"); await model.refresh();
    let release; connection.gate = new Promise(resolve => { release = resolve; });
    const oldRead = model.refresh(); await new Promise(resolve => setImmediate(resolve));
    model.browse("archived");
    assert.equal(model.getSnapshot().selectedId, "old-a");
    assert.equal(model.getSnapshot().history, null);
    assert.deepEqual(model.getSnapshot().runs, []);
    model.select("b"); assert.equal(model.getSnapshot().selectedId, "old-a", "other list cannot leak into current view");
    connection.gate = undefined; release(); await oldRead;
    assert.equal(model.getSnapshot().history.sessionId, "old-a");
    model.select("old-b"); await model.refresh();
    model.browse("active"); await model.refresh(); assert.equal(model.getSnapshot().selectedId, "b");
    model.browse("archived"); await model.refresh(); assert.equal(model.getSnapshot().selectedId, "old-b");
    connection.sessions = connection.sessions.filter(item => item.sessionId !== "old-b");
    await model.refresh(); assert.equal(model.getSnapshot().selectedId, "old-a");
    connection.sessions = connection.sessions.filter(item => item.status === "active");
    await model.refresh(); assert.equal(model.getSnapshot().selectedId, null); assert.equal(model.getSnapshot().history, null);
    model.browse("active"); await model.refresh(); assert.equal(model.getSnapshot().selectedId, "b");
  } finally { model.close(); }
});
test("Run observer deduplicates, separates queue/steer, closes on terminal and never cancels Host", () => {
  const streams = []; let settled = 0;
  const run = new RunClientModel({ stream(path) { const stream = new Stream(); streams.push({ path, stream }); return stream; } }, () => settled++);
  run.observe("r"); const stream = streams[0].stream;
  run.accepted({ accepted: true, runId: "r", controlId: "one" }, "More", "queue");
  run.accepted({ accepted: true, runId: "r", controlId: "two" }, "Change", "steer");
  stream.emit("runtime.transition", event(1, { type: "control.steering_delivered", controlIds: ["two"] }));
  stream.emit("runtime.transition", event(1, { type: "control.steering_delivered", controlIds: ["two"] }));
  stream.emit("runtime.transition", event(2, { type: "run.completed" }));
  assert.equal(run.getSnapshot().events.length, 2); assert.equal(settled, 1); assert.ok(stream.closed);
  assert.deepEqual(run.getSnapshot().deliveries.map(item => item.status), ["not-delivered", "delivered"]);
  run.observe("r"); assert.equal(streams.length, 1);
  run.observe("other"); assert.equal(run.getSnapshot().events.length, 0);
  stream.emit("runtime.transition", event(3, { type: "run.failed" })); assert.equal(run.getSnapshot().runId, "other"); run.close();
});
test("expired event window is explicit and resumes from earliest cursor without replaying commands", () => {
  const streams = []; let refreshed = 0;
  const run = new RunClientModel({ stream(path) { const stream = new Stream(); streams.push({ path, stream }); return stream; } }, () => refreshed++);
  run.observe("r"); streams[0].stream.emit("stream.error", { error: { code: "event_cursor_expired", earliestAvailable: 91 } });
  assert.ok(streams[0].stream.closed); assert.ok(streams[1].path.endsWith("after=90")); assert.equal(refreshed, 1); assert.ok(run.getSnapshot().gap); run.close();
});
test("Session model guards stale selection and readonly disconnect, failed send is not automatically retried", async () => {
  class Connection extends SnapshotStore {
    paths = []; posts = 0; gate;
    constructor() { super({ online: false, businessAvailable: false, instanceId: "root" }); }
    onInvalidation() { return () => {}; }
    stream() { return new Stream(); }
    async request(path, body) {
      this.paths.push(path);
      if (body) { this.posts++; throw new Error("uncertain_result"); }
      if (path === "/api/sessions") return { sessions: [ { sessionId: "a", status: "active" }, { sessionId: "b", status: "active" } ] };
      if (path.includes("/a/history") && this.gate) await this.gate;
      if (path.endsWith("/history")) return { history: { sessionId: path.split("/")[3], records: [] } };
      return { runs: [] };
    }
    online(value) { this.publish({ ...this.getSnapshot(), online: value, businessAvailable: value }); }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    connection.online(true); await model.refresh(); assert.equal(model.getSnapshot().selectedId, "a");
    let release; connection.gate = new Promise(resolve => { release = resolve; });
    const reading = model.refresh(); await new Promise(resolve => setImmediate(resolve)); model.select("b"); release(); await reading;
    assert.equal(model.getSnapshot().history.sessionId, "b");
    await assert.rejects(model.send("hello", "queue"), /uncertain_result/); assert.equal(connection.posts, 1);
    connection.online(false); await assert.rejects(model.send("hello", "queue"), /不可操作/); assert.equal(connection.posts, 1);
    assert.equal(model.getSnapshot().history.sessionId, "b");
  } finally { model.close(); }
});
