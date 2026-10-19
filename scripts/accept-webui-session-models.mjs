import test from "node:test";
import assert from "node:assert/strict";
import { RunClientModel } from "../dist/apps/webui/client/model/run.js";
import { SessionClientModel } from "../dist/apps/webui/client/model/session.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { projectConversationTurns, projectLedger } from "../dist/apps/webui/client/projection/ledger.js";
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

test("ledger retains persisted Tool failures and structured live outcomes", () => {
  const base = { kind: "message", runId: "r", userTurnId: "turn", stepId: "step", createdAt: "2026-09-14T00:00:00Z" };
  const history = { records: [
    { ...base, recordId: "call", origin: "assistant", message: { role: "assistant", content: "", toolCalls: [{ id: "bash-call", name: "bash", argumentsJson: "{}" }] } },
    { ...base, recordId: "result", origin: "tool", message: { role: "tool", content: "Tool failed [execution_failed]: Command exited with code 1", toolCallId: "bash-call" } },
  ] };
  const persisted = projectLedger(history, []).flatMap(turn => turn.blocks).find(block => block.kind === "tool");
  assert.equal(persisted.status, "tool.failed");
  const live = [{ type: "tool.lifecycle", runId: "r", userTurnId: "turn", stepId: "step", occurredAt: "2026-09-14T00:00:01Z", payload: {
    type: "tool.failed", call: { status: "ready", id: "bash-call", name: "bash", input: {} }, result: { ok: false, callId: "bash-call", toolName: "bash", error: { code: "execution_failed", message: "failed" }, phase: "completed" },
  } }];
  const genericHistory = { records: [history.records[0], { ...history.records[1], message: { ...history.records[1].message, content: "A custom renderer's result" } }] };
  const projected = projectLedger(genericHistory, live).flatMap(turn => turn.blocks).find(block => block.kind === "tool");
  assert.equal(projected.status, "tool.failed");
  assert.equal(projected.text, genericHistory.records[1].message.content, "durable result text stays authoritative");
});

test("conversation projection keeps the final answer primary and moves reasoning and tools into process", () => {
  const blocks = [
    { id: "user", turnId: "r/t", stepId: "s1", time: "1", kind: "user", title: "Your request", text: "Please inspect this" },
    { id: "work", turnId: "r/t", stepId: "s1", time: "2", kind: "assistant", title: "Wish", text: "I am checking.", reasoning: "Locate the implementation." },
    { id: "tool", turnId: "r/t", stepId: "s1", time: "3", kind: "tool", title: "read", text: "source", status: "tool.completed" },
    { id: "answer", turnId: "r/t", stepId: "s2", time: "4", kind: "assistant", title: "Wish", text: "Final result", reasoning: "Synthesize the evidence." },
  ];
  const [completed] = projectConversationTurns([{ id: "r/t", title: "Please inspect this", blocks }]);
  assert.deepEqual(completed.requests.map(block => block.id), ["user"]);
  assert.equal(completed.answer.id, "answer");
  assert.deepEqual(completed.process.map(block => block.id), ["work", "tool", "answer/reasoning"]);
  assert.equal(completed.toolCount, 1);
  const [live] = projectConversationTurns([{ id: "r/t", title: "Please inspect this", blocks }], "r/t");
  assert.equal(live.answer, undefined);
  assert.deepEqual(live.process.map(block => block.id), ["work", "tool", "answer"]);
  assert.equal(live.live, true);
  assert.deepEqual(projectConversationTurns([{ id: "checkpoint", title: "Context", blocks: [{ id: "checkpoint", turnId: "checkpoint", stepId: "", time: "1", kind: "checkpoint", title: "Context", text: "summary" }] }]), []);
});

test("live tool completion updates a durable call until the canonical result arrives", () => {
  const base = { kind: "message", runId: "r", userTurnId: "turn", stepId: "step", createdAt: "2026-09-14T00:00:00Z" };
  const history = { records: [{ ...base, recordId: "one", origin: "assistant", message: { role: "assistant", content: "", toolCalls: [{ id: "call", name: "read", argumentsJson: "{\"path\":\"a\"}" }] } }] };
  const live = [{ type: "tool.lifecycle", runId: "r", userTurnId: "turn", stepId: "step", occurredAt: "2026-09-14T00:00:01Z", payload: {
    type: "tool.completed", call: { status: "ready", id: "call", name: "read", input: { path: "a" } }, result: { ok: true, callId: "call", toolName: "read", output: "live result", phase: "completed" },
  } }];
  const tool = projectLedger(history, live).flatMap(turn => turn.blocks).find(block => block.kind === "tool");
  assert.equal(tool.status, "tool.completed");
  assert.match(tool.text, /live result/u);
});

test("ledger keeps internal continuations out of the visible conversation", () => {
  const base = { kind: "message", runId: "r", userTurnId: "continued", stepId: "step", createdAt: "2026-09-14T00:00:00Z" };
  const history = { records: [
    { ...base, recordId: "internal", origin: "user_input", inputSource: "continuation", message: { role: "user", content: "Subagent result received" } },
    { ...base, recordId: "answer", origin: "assistant", message: { role: "assistant", content: "Parent synthesis" } },
  ] };
  const live = [{
    type: "runtime.transition", runId: "r", userTurnId: "live-continuation", stepId: "live-step",
    occurredAt: "2026-09-14T00:00:01Z", payload: { type: "user_turn.started", userTurnId: "live-continuation", inputSource: "continuation", input: { text: "Child failed" } },
  }];
  const turns = projectLedger(history, live);
  const blocks = turns.flatMap(turn => turn.blocks);
  assert.deepEqual(blocks, [], "a continuation without a visible parent is not a new round");
});

test("continuation work stays in its originating visible round, including live Tool events", () => {
  const record = (recordId, runId, userTurnId, stepId, createdAt, message, extra = {}) => ({
    kind: "message", recordId, runId, userTurnId, stepId, createdAt, origin: message.role === "user" ? "user_input" : "assistant", message, ...extra,
  });
  const history = { records: [
    record("human-one", "run", "human-one", "one:1", "2026-10-19T00:00:00Z", { role: "user", content: "Inspect the project" }, { inputSource: "user" }),
    record("answer-one", "run", "human-one", "one:2", "2026-10-19T00:00:01Z", { role: "assistant", content: "Initial report" }),
    record("internal", "run", "internal-one", "internal:1", "2026-10-19T00:00:02Z", { role: "user", content: "Private child result" }, { inputSource: "continuation" }),
    record("call", "run", "internal-one", "internal:1", "2026-10-19T00:00:03Z", { role: "assistant", content: "", toolCalls: [{ id: "read-call", name: "read", argumentsJson: "{}" }] }),
    record("result", "run", "internal-one", "internal:1", "2026-10-19T00:00:04Z", { role: "tool", toolCallId: "read-call", content: "Source text" }),
    record("human-two", "run", "human-two", "two:1", "2026-10-19T00:00:06Z", { role: "user", content: "Now review it" }, { inputSource: "follow_up" }),
  ] };
  const turns = projectLedger(history, []);
  assert.deepEqual(turns.map(turn => turn.id), ["run/human-one", "run/human-two"]);
  assert.equal(turns[0].blocks.find(block => block.toolName === "read")?.turnId, "run/human-one");
  assert.equal(turns.flatMap(turn => turn.blocks).some(block => block.text === "Private child result"), false);
  assert.equal(projectConversationTurns(turns).length, 2);

  const liveHistory = { records: history.records.slice(0, 2) };
  const events = [
    { type: "runtime.transition", runId: "run", userTurnId: "live-internal", occurredAt: "2026-10-19T00:00:02Z", payload: {
      type: "user_turn.started", userTurnId: "live-internal", inputSource: "continuation", input: { text: "Private live child result" },
    } },
    { type: "tool.lifecycle", runId: "run", userTurnId: "live-internal", stepId: "live:1", occurredAt: "2026-10-19T00:00:03Z", payload: {
      type: "tool.dispatched", call: { status: "ready", id: "live-call", name: "bash", input: {} },
    } },
  ];
  const liveTurns = projectLedger(liveHistory, events);
  assert.deepEqual(liveTurns.map(turn => turn.id), ["run/human-one"]);
  assert.equal(liveTurns[0].blocks.find(block => block.toolName === "bash")?.turnId, "run/human-one");
  assert.equal(projectConversationTurns(liveTurns, "run/human-one")[0].live, true);
  const mixed = projectLedger(history, events);
  assert.equal(mixed.find(turn => turn.id === "run/human-one")?.blocks.find(block => block.toolName === "bash")?.turnId, "run/human-one",
    "older live child events stay with their original turn even when a later human turn is loaded");
});

test("a child result delivered inside the active UserTurn stays private in the same round", () => {
  const history = { records: [
    { kind: "message", recordId: "human", runId: "run", userTurnId: "turn", stepId: "turn:1", createdAt: "2026-10-19T00:00:00Z", origin: "user_input", inputSource: "user", message: { role: "user", content: "Review this" } },
    { kind: "message", recordId: "child", runId: "run", userTurnId: "turn", stepId: "turn:2", createdAt: "2026-10-19T00:00:01Z", origin: "steering", inputSource: "continuation", message: { role: "user", content: "Private child result" } },
    { kind: "message", recordId: "answer", runId: "run", userTurnId: "turn", stepId: "turn:2", createdAt: "2026-10-19T00:00:02Z", origin: "assistant", message: { role: "assistant", content: "Combined answer" } },
  ] };
  const turns = projectLedger(history, []);
  assert.deepEqual(turns.map(turn => turn.id), ["run/turn"]);
  assert.deepEqual(turns[0].blocks.map(block => block.text), ["Review this", "Combined answer"]);
  assert.equal(projectConversationTurns(turns)[0].answer.text, "Combined answer");
});

test("continuation history without its parent page does not invent a visible round", () => {
  const history = { records: [
    { kind: "message", recordId: "child", runId: "run", userTurnId: "internal", stepId: "internal:1", createdAt: "2026-10-19T00:00:01Z", origin: "user_input", inputSource: "continuation", message: { role: "user", content: "Private child result" } },
    { kind: "message", recordId: "answer", runId: "run", userTurnId: "internal", stepId: "internal:1", createdAt: "2026-10-19T00:00:02Z", origin: "assistant", message: { role: "assistant", content: "Internal synthesis" } },
  ] };
  assert.deepEqual(projectLedger(history, []), []);
});

test("stopping a Run stays in its own visible turn without cancellation fields", () => {
  const history = { records: [
    { kind: "message", recordId: "first", runId: "first-run", userTurnId: "first-turn", stepId: "step-1", createdAt: "2026-09-14T00:00:00Z", origin: "user_input", message: { role: "user", content: "First task" } },
    { kind: "message", recordId: "next", runId: "next-run", userTurnId: "next-turn", stepId: "step-2", createdAt: "2026-09-14T00:00:03Z", origin: "user_input", message: { role: "user", content: "Next task" } },
  ] };
  const events = [{ type: "runtime.transition", runId: "first-run", occurredAt: "2026-09-14T00:00:02Z", payload: {
    type: "run.aborted", cancellation: { reason: "User requested stop from WebUI", source: "wish-webui", requestedAt: "2026-09-14T00:00:01Z" },
  } }];
  const turns = projectLedger(history, events);
  assert.deepEqual(turns.map(turn => turn.id), ["first-run/first-turn", "next-run/next-turn"]);
  const stopped = turns[0].blocks.find(block => block.status === "run.aborted");
  assert.equal(stopped.turnId, "first-run/first-turn");
  assert.equal(stopped.title, "运行已停止");
  assert.equal(stopped.text, "");
  assert.equal(turns[1].blocks.some(block => block.status === "run.aborted"), false);
  const conversation = projectConversationTurns(turns);
  assert.equal(conversation[0].stopped, true);
  assert.equal(conversation[0].failed, false);
  assert.equal(conversation[1].stopped, false);
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
test("stopping a Run waits for Host terminal status before reporting success", async () => {
  let finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  class Connection extends SnapshotStore {
    stopped = false;
    constructor() { super({ online: true, businessAvailable: true, instanceId: "one" }); }
    onInvalidation() { return () => {}; }
    stream() { return new Stream(); }
    async request(path, body) {
      if (path === "/api/sessions") return { sessions: [{ sessionId: "a", status: "active", historyRevision: "v1" }] };
      if (path.endsWith("/history")) return { history: { sessionId: "a", historyRevision: "v1", records: [] } };
      if (path.endsWith("/runs")) return { runs: [{ runId: "run", sessionId: "a", status: this.stopped ? "aborted" : "running" }] };
      if (path.endsWith("/controls")) { assert.equal(body.type, "abort"); return { receipt: { accepted: true, runId: "run", kind: "abort", controlId: "stop" } }; }
      if (path === "/api/runs/run") { await terminal; this.stopped = true; return { run: { runId: "run", sessionId: "a", status: "aborted" } }; }
      throw new Error(`unexpected path ${path}`);
    }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    await model.refresh();
    const stopping = model.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().working, true, "an accepted abort is not yet a stopped Run");
    finish(); await stopping;
    assert.equal(model.getSnapshot().working, false);
    assert.equal(model.getSnapshot().runs[0].status, "aborted");
  } finally { finish(); model.close(); }
});

test("Session refresh reuses history while the metadata revision is unchanged", async () => {
  class Connection extends SnapshotStore {
    revision = "v1"; historyReads = 0; runReads = 0;
    constructor() { super({ online: true, businessAvailable: true, instanceId: "one" }); }
    onInvalidation() { return () => {}; }
    stream() { return new Stream(); }
    async request(path) {
      if (path === "/api/sessions") return { sessions: [{ sessionId: "a", status: "active", historyRevision: this.revision }] };
      if (path.endsWith("/history")) { this.historyReads++; return { history: { sessionId: "a", historyRevision: this.revision, records: [] } }; }
      this.runReads++; return { runs: [] };
    }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    await model.refresh();
    assert.equal(connection.historyReads, 1);
    const firstHistory = model.getSnapshot().history;
    const firstSnapshot = model.getSnapshot();
    await model.refresh();
    assert.equal(connection.historyReads, 1, "polling does not download an unchanged transcript");
    assert.equal(model.getSnapshot().history, firstHistory);
    assert.equal(model.getSnapshot(), firstSnapshot, "an unchanged poll does not publish a render snapshot");
    assert.ok(connection.runReads >= 2, "live Run status continues to refresh");
    connection.revision = "v2";
    await model.refresh();
    assert.equal(connection.historyReads, 2, "a new transcript revision is downloaded");
    assert.equal(model.getSnapshot().history.historyRevision, "v2");
  } finally { model.close(); }
});
test("Session selection starts history beside the list request and reuses an exact cached revision", async () => {
  let releaseList;
  class Connection extends SnapshotStore {
    sessions = [
      { sessionId: "a", status: "active", historyRevision: "a1" },
      { sessionId: "b", status: "active", historyRevision: "b1" },
    ];
    listGate = null; historyReads = new Map(); paths = [];
    constructor() { super({ online: true, businessAvailable: true, instanceId: "one" }); }
    onInvalidation() { return () => {}; }
    stream() { return new Stream(); }
    async request(path) {
      this.paths.push(path);
      if (path === "/api/sessions") { if (this.listGate) await this.listGate; return { sessions: this.sessions }; }
      if (path.endsWith("/history")) {
        const id = path.split("/")[3], revision = this.sessions.find(item => item.sessionId === id).historyRevision;
        this.historyReads.set(id, (this.historyReads.get(id) ?? 0) + 1);
        return { history: { sessionId: id, historyRevision: revision, records: [] } };
      }
      return { runs: [] };
    }
  }
  const connection = new Connection(), model = new SessionClientModel(connection);
  try {
    await model.refresh();
    const cachedA = model.getSnapshot().history;
    connection.paths = [];
    connection.listGate = new Promise(resolve => { releaseList = resolve; });
    model.select("b");
    const loadingB = model.refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(connection.paths.includes("/api/sessions/b/history"), "history starts without waiting for the Session index");
    releaseList(); connection.listGate = null; await loadingB;
    assert.equal(model.getSnapshot().history.sessionId, "b");
    const readsA = connection.historyReads.get("a");
    model.select("a");
    assert.equal(model.getSnapshot().history, cachedA, "returning to an unchanged Session is synchronous");
    assert.equal(model.getSnapshot().loading, false);
    await model.refresh();
    assert.equal(connection.historyReads.get("a"), readsA, "an exact cached revision is not downloaded again");

    model.select("b"); await model.refresh();
    connection.sessions = connection.sessions.map(item => item.sessionId === "a" ? { ...item, historyRevision: "a2" } : item);
    await model.refresh();
    model.select("a");
    assert.equal(model.getSnapshot().history, null, "a changed revision never reuses stale history");
    assert.equal(model.getSnapshot().loading, true);
    await model.refresh();
    assert.equal(model.getSnapshot().history.historyRevision, "a2");
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
