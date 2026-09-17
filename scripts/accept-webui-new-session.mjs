import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewSessionClientModel } from "../dist/apps/webui/client/model/new-session.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { NewSession } from "../dist/apps/webui/client/ui/new-session.js";
import { Conversation } from "../dist/apps/webui/client/ui/conversation.js";
import { ComposerDrafts } from "../dist/apps/webui/client/ui/drafts.js";
import { NewSessionReasoningComposerItem, ReasoningComposerItem } from "../dist/models/consumers/webui/reasoning-view.js";

function draftHandoff() {
  const bySession = new Map();
  return { bySession, forSession(id) {
    if (!bySession.has(id)) bySession.set(id, { value: "", set(text) { this.value = text; }, accepted(text) { if (this.value === text) this.value = ""; } });
    return bySession.get(id);
  } };
}

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
