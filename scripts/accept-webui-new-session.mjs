import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewSessionClientModel } from "../dist/apps/webui/client/model/new-session.js";
import { SessionClientModel } from "../dist/apps/webui/client/model/session.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { NewSession } from "../dist/apps/webui/client/ui/new-session.js";
import { Conversation, RoundNavigation, tailLedgerTurns } from "../dist/apps/webui/client/ui/conversation.js";
import { ComposerDrafts } from "../dist/apps/webui/client/ui/drafts.js";
import { NewSessionReasoningComposerItem, ReasoningComposerItem } from "../dist/models/consumers/webui/reasoning-view.js";

function draftHandoff() {
  const bySession = new Map();
  return { bySession, forSession(id) {
    if (!bySession.has(id)) bySession.set(id, { value: "", set(text) { this.value = text; }, accepted(text) { if (this.value === text) this.value = ""; } });
    return bySession.get(id);
  } };
}

test("long conversations initially render only their latest turns", () => {
  const turns = Array.from({ length: 60 }, (_, index) => `turn-${index + 1}`);
  assert.deepEqual(tailLedgerTurns(turns, 24), turns.slice(36));
  assert.equal(tailLedgerTurns(turns, 80), turns);
});

test("round navigation lists the complete conversation and requests enough history for an older turn", () => {
  const records = Array.from({ length: 60 }, (_, index) => ({
    schemaVersion: 1, kind: "message", recordId: `record-${index + 1}`, sequence: index + 1,
    idempotencyKey: `message-${index + 1}`, runId: `run-${index + 1}`,
    userTurnId: `turn-${index + 1}`, stepId: `step-${index + 1}`, origin: "user",
    createdAt: `2026-10-15T00:00:${String(index).padStart(2, "0")}Z`,
    message: { role: "user", content: `question-${index + 1}` },
  }));
  const sessions = new SnapshotStore({ selectedId: "session-long", history: { sessionId: "session-long", historyRevision: "v60", records } });
  const slots = new UiSlots(), requests = [];
  const unsubscribe = slots.onOpenLedgerTurn(request => requests.push(request));
  try {
    const html = renderToStaticMarkup(createElement(RoundNavigation, { model: sessions, slots }));
    assert.equal((html.match(/<a /gu) ?? []).length, 60);
    assert.match(html, /href="#turn-run-1%2Fturn-1"/u);
    assert.match(html, /question-1/u);
    assert.match(html, /question-60/u);
    slots.openLedgerTurn({ sessionId: "session-long", turnId: "run-1/turn-1", requiredTurns: 60 });
    assert.deepEqual(requests, [{ sessionId: "session-long", turnId: "run-1/turn-1", requiredTurns: 60 }]);
  } finally { unsubscribe(); }
});

test("centered new-session intent creates nothing until the first message is submitted", async () => {
  const calls = [], drafts = draftHandoff();
  const sessions = { startCreate: () => calls.push("open"), create: async root => { calls.push(["create", root]); return "session-1"; },
    send: async (text, mode, expectedId) => { calls.push(["send", text, mode, expectedId]); } };
  const flow = new NewSessionClientModel(sessions, drafts);
  flow.start();
  flow.setDraft("  做一个检查  ");
  flow.start();
  assert.equal(flow.getSnapshot().draft, "  做一个检查  ", "reopening an unfinished intent preserves its draft");
  assert.deepEqual(calls, ["open", "open"]);
  await flow.submit();
  assert.equal(flow.getSnapshot().phase, "ready");
  assert.equal(flow.getSnapshot().error, "请先选择工作区");
  flow.chooseWorkspace("/work/project");
  await flow.submit();
  assert.deepEqual(calls, ["open", "open", ["create", "/work/project"], ["send", "做一个检查", "queue", "session-1"]]);
  assert.equal(flow.getSnapshot().phase, "done");
  assert.equal(drafts.bySession.get("session-1").value, "");
  flow.close();
});

class GatedFirstMessageConnection extends SnapshotStore {
  sessions = []; run = null; writes = []; streams = [];
  blocked = new Promise(resolve => { this.markBlocked = resolve; });
  gate = new Promise(resolve => { this.release = resolve; });
  holdList = false;
  constructor(blockAfter) { super({ online: true, businessAvailable: true, instanceId: "one" }); this.blockAfter = blockAfter; }
  onInvalidation() { return () => {}; }
  stream(path) {
    const listeners = new Map();
    const stream = { addEventListener(name, listener) { listeners.set(name, listener); }, close() {},
      emit(name, value) { listeners.get(name)?.({ data: JSON.stringify(value) }); } };
    this.streams.push({ path, stream });
    return stream;
  }
  async request(path, body) {
    if (body) {
      this.writes.push({ path, body });
      if (path === "/api/sessions") {
        const session = { sessionId: "created", scope: body.workspaceRoot, status: "active", historyRevision: "v1" };
        this.sessions = [session];
        this.holdList = this.blockAfter === "create";
        return { session };
      }
      if (path === "/api/sessions/created/runs") {
        this.run = { runId: "first-run", sessionId: "created", status: "running" };
        this.holdList ||= this.blockAfter === "send";
        return { run: this.run };
      }
      throw new Error(`Unexpected write: ${path}`);
    }
    if (path === "/api/sessions") {
      if (this.holdList) { this.markBlocked(); await this.gate; }
      return { sessions: this.sessions };
    }
    if (path.endsWith("/history")) return { history: { sessionId: "created", historyRevision: "v1", records: [] } };
    if (path.endsWith("/runs")) return { runs: this.run ? [this.run] : [] };
    throw new Error(`Unexpected read: ${path}`);
  }
}

test("successful creation sends its first message while the Session index refresh is blocked", async () => {
  const connection = new GatedFirstMessageConnection("create"), drafts = draftHandoff();
  const sessions = new SessionClientModel(connection), flow = new NewSessionClientModel(sessions, drafts);
  let submitting;
  try {
    await sessions.refresh();
    flow.start(); flow.chooseWorkspace("/work/project"); flow.setDraft("首条请求");
    submitting = flow.submit();
    await connection.blocked;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(connection.writes.map(write => write.path), ["/api/sessions", "/api/sessions/created/runs"],
      "the first Run is sent before a background Session index read resolves");
    assert.equal(sessions.run.getSnapshot().runId, "first-run");
    assert.equal(sessions.getSnapshot().working, false);
  } finally { connection.release(); await submitting; flow.close(); sessions.close(); }
});

test("an accepted first Run completes the intent and observes SSE while its index refresh is blocked", async () => {
  const connection = new GatedFirstMessageConnection("send"), drafts = draftHandoff();
  const sessions = new SessionClientModel(connection), flow = new NewSessionClientModel(sessions, drafts);
  let submitting;
  try {
    await sessions.refresh();
    flow.start(); flow.chooseWorkspace("/work/project"); flow.setDraft("首条请求");
    submitting = flow.submit();
    await connection.blocked;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(flow.getSnapshot().phase, "done", "the new-session view can leave sending before the background index resolves");
    assert.equal(drafts.bySession.get("created").value, "", "a successful send clears only its accepted draft");
    assert.equal(connection.streams.length, 1);
    assert.match(connection.streams[0].path, /\/api\/runs\/first-run\/events\?after=0$/u);
    connection.streams[0].stream.emit("stream.ready", {});
    assert.equal(sessions.run.getSnapshot().connected, true);
    await flow.submit();
    assert.equal(connection.writes.length, 2, "repeated submit after acceptance creates no Session or Run");
  } finally { connection.release(); await submitting; flow.close(); sessions.close(); }
});

test("a failed first send keeps the draft in its created Session and refuses duplicate creation", async () => {
  let creates = 0, sends = 0;
  const drafts = draftHandoff();
  const flow = new NewSessionClientModel({ startCreate() {}, async create() { creates++; return "session-2"; }, async send() { sends++; throw new Error("request_failed"); } }, drafts);
  flow.start(); flow.chooseWorkspace("/work/project"); flow.setDraft("保留这份请求");
  await flow.submit();
  assert.equal(flow.getSnapshot().phase, "review");
  assert.equal(flow.getSnapshot().createdSessionId, "session-2");
  assert.match(flow.getSnapshot().error, /需要核对/);
  assert.equal(drafts.bySession.get("session-2").value, "保留这份请求");
  await flow.submit();
  assert.equal(creates, 1);
  assert.equal(sends, 1);
  flow.close();
});

test("a failed creation leaves the center draft editable without dispatching a message", async () => {
  let sends = 0;
  const flow = new NewSessionClientModel({ startCreate() {}, async create() { throw new Error("invalid_workspace"); }, async send() { sends++; } }, draftHandoff());
  flow.start(); flow.chooseWorkspace("/missing"); flow.setDraft("修复错误");
  await flow.submit();
  assert.equal(flow.getSnapshot().phase, "ready");
  assert.equal(flow.getSnapshot().draft, "修复错误");
  assert.equal(flow.getSnapshot().error, "invalid_workspace");
  assert.equal(sends, 0);
  flow.close();
});

test("an optional capability is applied after Session creation and before the first Run", async () => {
  const calls = [];
  const flow = new NewSessionClientModel({ startCreate() {}, async create(root) { calls.push(["create", root]); return "session-3"; },
    async send(text) { calls.push(["send", text]); } }, draftHandoff());
  const dispose = flow.registerFirstMessageSetup("reasoning", () => {
    calls.push(["capture", "low"]);
    return async sessionId => { calls.push(["select", sessionId, "low"]); };
  });
  flow.start(); flow.chooseWorkspace("/work/project"); flow.setDraft("首条消息");
  assert.deepEqual(calls, [], "opening and choosing a workspace do not create a Host Session");
  await flow.submit();
  assert.deepEqual(calls, [["capture", "low"], ["create", "/work/project"], ["select", "session-3", "low"], ["send", "首条消息"]]);
  dispose(); flow.close();
});

test("a failed capability setup never sends the first message under an unintended default", async () => {
  const calls = [];
  const flow = new NewSessionClientModel({ startCreate() {}, async create() { calls.push("create"); return "session-4"; },
    async send() { calls.push("send"); } }, draftHandoff());
  flow.registerFirstMessageSetup("reasoning", () => async () => { throw new Error("model_selection_changed"); });
  flow.start(); flow.chooseWorkspace("/work/project"); flow.setDraft("需要保留的草稿");
  await flow.submit();
  assert.deepEqual(calls, ["create"]);
  assert.equal(flow.getSnapshot().phase, "review");
  assert.equal(flow.getSnapshot().draft, "需要保留的草稿");
  assert.match(flow.getSnapshot().error, /尚未发送/u);
  flow.close();
});

test("the new-session composer renders the optional effort selector and send button inside one toolbar", () => {
  const sessions = new SnapshotStore({ sessions: [], available: true, error: null });
  const flow = new NewSessionClientModel({ startCreate() {}, async create() { return "new"; }, async send() {} }, draftHandoff());
  const reasoning = new SnapshotStore({ view: { model: { provider: "deepseek", model: "deepseek-flash" },
    control: { format: "deepseek-chat", efforts: ["none", "low", "high", "max"], defaultEffort: "high" } }, selected: "low", loading: false, error: null });
  const slots = new UiSlots();
  const remove = slots.newSessionComposer({ id: "model-reasoning", View: ({ disabled }) => createElement(NewSessionReasoningComposerItem, { model: reasoning, disabled }) });
  const browser = new SnapshotStore({ open: false }); browser.dismiss = () => {};
  flow.chooseWorkspace("/work/project");
  const html = renderToStaticMarkup(createElement(NewSession, { sessions, flow, slots, browser }));
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>") + 7);
  const footer = form.slice(form.indexOf("<footer"), form.indexOf("</footer>") + 9);
  assert.match(form, /id="new-session-message"/u);
  assert.match(footer, /class="new-session-composer-tools"/u);
  assert.match(footer, /aria-label="首个运行的思考强度"/u);
  assert.match(footer, /value="low" selected=""/u);
  assert.doesNotMatch(footer, /value="default"|默认（/u);
  assert.match(footer, /class="new-session-send"/u);
  remove(); flow.close();
});

test("an existing Session uses the same card with compact effective effort and send inside", () => {
  const sessions = new SnapshotStore({ selectedId: "session-1", filter: "active", sessions: [
    { sessionId: "session-1", title: "检查实现", scope: "/work/project", status: "active" },
  ], runs: [], history: null, loading: false, available: true, working: false, error: null });
  sessions.run = new SnapshotStore({ events: [], gap: false, error: null, deliveries: [], connected: false });
  const settings = new SnapshotStore({ sections: [] }), slots = new UiSlots(), drafts = new ComposerDrafts();
  const reasoning = new SnapshotStore({ sessionId: "session-1", view: { model: { provider: "deepseek", model: "deepseek-flash" },
    control: { format: "deepseek-chat", efforts: ["none", "low", "high", "max"], defaultEffort: "high" } }, loading: false, pending: false, error: null, status: null });
  slots.composer({ id: "model-reasoning", View: ({ sessionId, busy }) => createElement(ReasoningComposerItem, { model: reasoning, sessionId, busy }) });
  const html = renderToStaticMarkup(createElement(Conversation, { model: sessions, settings, slots, drafts }));
  const card = html.slice(html.indexOf('class="message-composer-card composer-card"'), html.indexOf("</footer>"));
  assert.ok(card.indexOf('id="wish-composer"') < card.indexOf('class="composer-actions"'));
  assert.match(card, /aria-label="下次运行的思考强度"/u);
  assert.match(card, /value="high" selected=""/u);
  assert.doesNotMatch(card, /value="default"|默认（/u);
  assert.match(card, /class="composer-send"/u);
  drafts.close();
});

test("a long Conversation renders the latest page and exposes earlier turns on demand", () => {
  const records = Array.from({ length: 60 }, (_, index) => ({
    schemaVersion: 1, kind: "message", recordId: `record-${index + 1}`, sequence: index + 1,
    idempotencyKey: `message-${index + 1}`, runId: `run-${index + 1}`,
    userTurnId: `turn-${index + 1}`, stepId: `step-${index + 1}`, origin: "assistant",
    createdAt: `2026-10-15T00:00:${String(index).padStart(2, "0")}Z`,
    message: { role: "assistant", content: `answer-${index + 1}` },
  }));
  const sessions = new SnapshotStore({ selectedId: "session-long", filter: "active", sessions: [
    { sessionId: "session-long", title: "长会话", scope: "/work/project", status: "active", historyRevision: "v60" },
  ], runs: [], history: { sessionId: "session-long", historyRevision: "v60", records }, loading: false, available: true, working: false, error: null });
  sessions.run = new SnapshotStore({ events: [], gap: false, error: null, deliveries: [], connected: false });
  const drafts = new ComposerDrafts();
  try {
    const html = renderToStaticMarkup(createElement(Conversation, { model: sessions, settings: new SnapshotStore({ sections: [] }), slots: new UiSlots(), drafts }));
    assert.match(html, /加载更早轮次（还剩 36 轮）/u);
    assert.doesNotMatch(html, /answer-36(?:<|\b)/u);
    assert.match(html, /answer-37(?:<|\b)/u);
    assert.match(html, /answer-60(?:<|\b)/u);
    assert.doesNotMatch(html, /等待请求/u);
  } finally { drafts.close(); }
});

test("Conversation never paints a ledger contribution before canonical history is ready", () => {
  const source = new SnapshotStore([{ id: "prompt", turnId: "run/turn", stepId: "step", time: "2026-10-15T00:00:00Z", kind: "system", title: "系统提示词抢先出现", text: "", viewId: "prompt" }]);
  const slots = new UiSlots(), remove = slots.ledger({ id: "prompt", source, View: ({ block }) => createElement("p", null, block.title) });
  const snapshot = { selectedId: "session-loading", filter: "active", sessions: [
    { sessionId: "session-loading", title: "载入中的会话", scope: "/work/project", status: "active", historyRevision: "v1" },
  ], runs: [], history: null, loading: true, available: true, working: false, error: null };
  const render = history => {
    const sessions = new SnapshotStore({ ...snapshot, history, loading: history === null });
    sessions.run = new SnapshotStore({ events: [], gap: false, error: null, deliveries: [], connected: false });
    const drafts = new ComposerDrafts();
    try { return renderToStaticMarkup(createElement(Conversation, { model: sessions, settings: new SnapshotStore({ sections: [] }), slots, drafts })); }
    finally { drafts.close(); }
  };
  try {
    const loading = render(null);
    assert.match(loading, /正在加载会话/u);
    assert.doesNotMatch(loading, /系统提示词抢先出现/u);
    assert.match(render({ sessionId: "session-loading", historyRevision: "v1", records: [] }), /系统提示词抢先出现/u);
  } finally { remove(); }
});
