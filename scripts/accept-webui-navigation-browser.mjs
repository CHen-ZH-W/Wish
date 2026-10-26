import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));

// Exercise production React views and client models with deterministic HTTP
// responses. This fixture does not start a Host or call a model Provider.
const entry = String.raw`
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionClientModel } from "./src/apps/webui/client/model/session.ts";
import { NewSessionClientModel } from "./src/apps/webui/client/model/new-session.ts";
import { ClientApiError } from "./src/apps/webui/client/connection.ts";
import { SnapshotStore } from "./src/apps/webui/client/model/store.ts";
import { UiSlots } from "./src/apps/webui/client/slots.ts";
import { Shell } from "./src/apps/webui/client/ui/shell.tsx";
import { Conversation } from "./src/apps/webui/client/ui/conversation.tsx";
import { ToolCalls } from "./src/apps/webui/client/ui/tool-calls.tsx";
import { SessionNavigation } from "./src/apps/webui/client/ui/sessions.tsx";
import { ComposerDrafts } from "./src/apps/webui/client/ui/drafts.ts";
import { SystemPromptHistoryClientUi } from "./src/system-prompt/consumers/webui/index.tsx";
import { WorkspaceFilesClientUi } from "./src/workspace-files/consumers/webui/index.tsx";

class FixtureConnection extends SnapshotStore {
  invalidations = new Set();
  constructor() { super({ online: true, businessAvailable: true, instanceId: "navigation-host", error: null }); }
  onInvalidation(listener) { this.invalidations.add(listener); return () => this.invalidations.delete(listener); }
  invalidate() { for (const listener of this.invalidations) listener(); }
  replaceHost() { this.publish({ ...this.getSnapshot(), instanceId: this.getSnapshot().instanceId + "-next" }); }
  async request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new ClientApiError(value.error?.code ?? "fixture_http_" + response.status, response.status);
    return value;
  }
  stream() { throw new Error("No fixture Run should open a stream"); }
}

const connection = new FixtureConnection(), slots = new UiSlots();
const sessions = new SessionClientModel(connection), settings = new SnapshotStore({ sections: [] });
const drafts = new ComposerDrafts(), flow = new NewSessionClientModel(sessions, drafts);
await sessions.refresh();

const ConversationView = () => <Conversation model={sessions} settings={settings} slots={slots} drafts={drafts} />;
slots.panel({ id: "conversation", label: "会话", area: "workspace", navigationGroup: "session", preserveState: true,
  onOpen: () => sessions.browse("active"), View: ConversationView });
slots.panel({ id: "tool-calls", label: "工具调用", area: "workspace", navigation: "hidden", navigationGroup: "session", preserveState: true,
  View: () => <ToolCalls model={sessions} slots={slots} /> });
slots.panel({ id: "preferences", label: "通用设置", area: "settings",
  View: () => <section className="settings-page"><h1>导航验收设置</h1><label>示例设置<input /></label></section> });
slots.panel({ id: "new-session", label: "新建会话", area: "workspace", navigation: "hidden", onOpen: flow.start,
  defaultForArea: () => sessions.getSnapshot().creating, View: () => <section><h1>导航验收新会话</h1></section> });
slots.navigation({ id: "sessions", View: () => <SessionNavigation model={sessions} slots={slots} drafts={drafts} /> });
slots.sessionSidebar({ id: "fixture-work", label: "验收工作窗口", icon: "book", View: ({ sessionId }) => {
  const [value, setValue] = useState("");
  return <label>工作窗口草稿<input aria-label="工作窗口草稿" data-session={sessionId} value={value} onChange={event => setValue(event.target.value)} /></label>;
} });
const ownerRemovers = [];
SystemPromptHistoryClientUi.apply({ wishConnection: connection, wishSession: sessions, wishUiSlots: slots,
  effect(action) { const remove = action(); if (typeof remove === "function") ownerRemovers.push(remove); } });
WorkspaceFilesClientUi.apply({ wishConnection: connection, wishUiSlots: slots,
  effect(action) { const remove = action(); if (typeof remove === "function") ownerRemovers.push(remove); } });

// An effect's cleanup also runs when Activity hides a view. DOM connectivity
// distinguishes paused hidden views from views released after owner removal.
const lifecycle = {};
const probeViews = new Map();
let removeProbe = () => {}, removeAlias = () => {};
function installProbe(generation, reuse = false) {
  const Probe = reuse && probeViews.has(generation) ? probeViews.get(generation) : () => {
    const [count, setCount] = useState(0);
    useEffect(() => {
      const state = lifecycle[generation] ??= { active: false, starts: 0, stops: 0, ticks: 0 };
      state.active = true; state.starts++;
      const timer = setInterval(() => { state.ticks++; }, 20);
      return () => { clearInterval(timer); state.active = false; state.stops++; };
    }, []);
    return <section data-probe={generation}><h1>界面生命周期 {generation}</h1><button onClick={() => setCount(value => value + 1)}>计数 {count}</button></section>;
  };
  probeViews.set(generation, Probe);
  removeProbe = slots.panel({ id: "probe", label: "生命周期", area: "workspace", navigation: "rail", preserveState: true, View: Probe });
  removeAlias = slots.panel({ id: "probe-alias", label: "相同界面入口", area: "workspace", navigation: "rail", preserveState: true, View: Probe });
}
installProbe("first");
slots.openPanel("conversation");
const root = createRoot(document.getElementById("root"));
root.render(<Shell slots={slots} connection={connection} />);
window.fixture = {
  lifecycle,
  async refreshSessions() { await sessions.refresh(); },
  refreshPrompts() { connection.invalidate(); },
  replaceHost() { connection.replaceHost(); },
  removeProbe() { removeProbe(); removeAlias(); },
  async replaceProbe(generation) { await slots.batch(async () => { removeProbe(); removeAlias(); installProbe(generation); }); },
  async reRegisterProbe(generation) { await slots.batch(async () => { removeProbe(); removeAlias(); installProbe(generation, true); }); },
};
window.addEventListener("pagehide", () => { root.unmount(); for (const remove of ownerRemovers.reverse()) remove(); flow.close(); sessions.close(); drafts.close(); }, { once: true });
`;

async function compileFixture() {
  const result = await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "navigation-browser-fixture.tsx", loader: "tsx" },
    absWorkingDir: repository, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  return result.outputFiles[0].contents;
}

function history(sessionId) {
  const records = Array.from({ length: 60 }, (_, index) => {
    const ordinal = index + 1;
    const base = { schemaVersion: 1, kind: "message", recordId: sessionId + "-record-" + ordinal, sequence: ordinal * 2 - 1,
      idempotencyKey: sessionId + "-message-" + ordinal, runId: sessionId + "-run-" + ordinal,
      userTurnId: sessionId + "-turn-" + ordinal, stepId: sessionId + "-step-" + ordinal, origin: "assistant",
      createdAt: new Date(Date.UTC(2026, 9, 20, 0, ordinal)).toISOString() };
    const callId = sessionId + "-call-" + ordinal;
    return [{ ...base, message: { role: "assistant", content: sessionId + " 第 " + ordinal + " 轮。" + "这一轮有足够长的内容，用来验证真实浏览器中的阅读位置。".repeat(8),
      toolCalls: [{ id: callId, name: "fixture_read", argumentsJson: JSON.stringify({ path: "src/item-" + ordinal + ".ts" }) }] } },
    { ...base, recordId: base.recordId + "-tool", sequence: ordinal * 2, idempotencyKey: base.idempotencyKey + "-tool", origin: "tool",
      message: { role: "tool", toolCallId: callId, content: "第 " + ordinal + " 次工具输出。" + "这段工具结果用于验证展开状态与工具调用页的阅读位置。".repeat(8) } }];
  }).flat();
  return { sessionId, historyRevision: sessionId + "-v1", records };
}

async function fixtureServer(bundle) {
  const css = await readFile(new URL("../src/apps/webui/public/app.css", import.meta.url));
  const reads = new Map();
  let directoryGate, releaseDirectories, promptGate, releasePrompts, failPrompt = false, emptyPrompt = false;
  const sessions = ["a", "b"].map(sessionId => ({ schemaVersion: 1, sessionId, agentId: "fixture", title: "会话 " + sessionId.toUpperCase(),
    scope: "/fixture/workspace", status: "active", historyRevision: sessionId + "-v1", createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" }));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>');
      return;
    }
    if (path === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return; }
    if (path === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return; }
    if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    reads.set(path, (reads.get(path) ?? 0) + 1);
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/sessions") { response.end(JSON.stringify({ sessions })); return; }
    if (/^\/api\/sessions\/[ab]\/queries\/workspace-files$/u.test(path)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const query = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(query.operation, "list");
      const entries = query.path === "." ? [{ name: "src", path: "src", kind: "directory" }]
        : query.path === "src" ? [{ name: "nested", path: "src/nested", kind: "directory" }]
          : [{ name: "retained.txt", path: "src/nested/retained.txt", kind: "file" }];
      if (directoryGate) await directoryGate;
      response.end(JSON.stringify({ value: { schemaVersion: 1, root: "/fixture/workspace", path: query.path, truncated: false,
        entries: entries.map(entry => ({ ...entry, size: 0, modifiedAt: "2026-10-20T00:00:00Z" })) } }));
      return;
    }
    const match = /^\/api\/sessions\/([ab])\/(history|runs|controls\/system-prompt-history)$/u.exec(path);
    if (!match) { response.writeHead(404); response.end(JSON.stringify({ error: "unknown_fixture_endpoint" })); return; }
    const [, sessionId, resource] = match;
    if (resource === "history") { response.end(JSON.stringify({ history: history(sessionId) })); return; }
    if (resource === "runs") { response.end(JSON.stringify({ runs: [] })); return; }
    if (promptGate) await promptGate;
    if (failPrompt) { failPrompt = false; response.writeHead(503); response.end(JSON.stringify({ error: { code: "internal_error" } })); return; }
    if (emptyPrompt) { emptyPrompt = false; response.end(JSON.stringify({ value: { schemaVersion: 1, sessionId, snapshots: [] } })); return; }
    response.end(JSON.stringify({ value: { schemaVersion: 1, sessionId, snapshots: [{ schemaVersion: 1, sessionId,
      runId: sessionId + "-run-1", userTurnId: sessionId + "-turn-1", stepId: sessionId + "-step-1", capturedAt: "2026-10-20T00:00:00Z",
      model: { provider: "fixture", model: "navigation" }, digest: (sessionId === "a" ? "a" : "b").repeat(64),
      sections: [{ channel: "instructions", role: "system", content: "会话 " + sessionId.toUpperCase() + " 的系统提示词" }] }] } }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port, reads,
    pauseDirectories() { directoryGate = new Promise(resolve => { releaseDirectories = resolve; }); },
    resumeDirectories() { releaseDirectories?.(); directoryGate = undefined; releaseDirectories = undefined; },
    pausePrompts() { promptGate = new Promise(resolve => { releasePrompts = resolve; }); },
    resumePrompts() { releasePrompts?.(); promptGate = undefined; releasePrompts = undefined; },
    failNextPrompt() { failPrompt = true; },
    emptyNextPrompt() { emptyPrompt = true; },
    close: () => new Promise((resolve, reject) => { releaseDirectories?.(); releasePrompts?.(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

const visibleConversation = page => page.locator(".conversation:visible");
const rail = page => page.getByRole("navigation", { name: "主要导航", exact: true });

async function settleLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function selectSession(page, title) {
  const sessions = page.getByRole("navigation", { name: "会话列表", exact: true });
  if (!await sessions.isVisible()) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await sessions.getByRole("button", { name: title, exact: true }).click();
  await visibleConversation(page).getByRole("heading", { name: title, exact: true }).waitFor();
  await page.waitForFunction(() => !!document.querySelector(".conversation:not([hidden]) .system-prompt-disclosure"));
}

async function checkNavigation(page, fixture, viewport) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.url);
  const conversation = visibleConversation(page);
  await conversation.locator(".system-prompt-disclosure").waitFor();
  assert.equal(await conversation.locator(".conversation-turn").count(), 24);
  await conversation.locator(".system-prompt-disclosure > summary").click();
  await conversation.getByText("会话 A 的系统提示词", { exact: true }).waitFor();
  await conversation.getByRole("button", { name: "加载更早轮次（还剩 36 轮）", exact: true }).click();
  await conversation.getByRole("button", { name: "加载更早轮次（还剩 12 轮）", exact: true }).waitFor();
  assert.equal(await conversation.locator(".conversation-turn").count(), 48);

  await conversation.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
  const sidebar = conversation.locator(".session-sidebar");
  await sidebar.getByRole("button", { name: "打开 验收工作窗口", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "工作窗口草稿", exact: true }).fill("切换页面后保留的工作窗口");
  await sidebar.getByRole("button", { name: "新标签页", exact: true }).click();
  await sidebar.getByRole("button", { name: "打开 文件", exact: true }).click();
  const tree = sidebar.locator(".workspace-files-tree");
  await tree.getByRole("button", { name: "src", exact: true }).click();
  await tree.getByRole("button", { name: "nested", exact: true }).click();
  await tree.getByRole("button", { name: "retained.txt", exact: true }).waitFor();
  // Retained directory rows must remain usable even while the resumed effect's
  // freshness requests have not finished.
  fixture.pauseDirectories();
  if (viewport.width < 1181) await sidebar.getByRole("button", { name: "收起会话侧栏", exact: true }).click();
  await settleLayout(page);
  const before = await conversation.locator(".ledger-scroll").evaluate(node => {
    node.scrollTop = Math.min(650, (node.scrollHeight - node.clientHeight) / 2);
    window.fixtureConversation = node.closest(".conversation");
    window.fixtureLedgerScroll = node;
    return node.scrollTop;
  });
  assert.ok(before > 100, "the fixture has a meaningful reading position");
  await settleLayout(page);
  const readsBefore = [fixture.reads.get("/api/sessions/a/history"), fixture.reads.get("/api/sessions/a/controls/system-prompt-history")];

  const assertPreserved = async () => {
    await conversation.locator(".system-prompt-disclosure[open]").waitFor({ state: "attached" });
    await settleLayout(page);
    assert.equal(await conversation.locator(".conversation-turn").count(), 48, "the expanded history window survives navigation");
    assert.equal(await conversation.locator(".ledger-scroll").evaluate(node => node === window.fixtureLedgerScroll), true, "navigation retains the actual reading surface");
    assert.ok(Math.abs(await conversation.locator(".ledger-scroll").evaluate(node => node.scrollTop) - before) <= 2, "returning does not jump to the latest turn");
    assert.equal(await sidebar.isVisible(), viewport.width >= 1181, "sidebar visibility survives navigation");
    assert.equal(await tree.getByRole("button", { name: "retained.txt", exact: true, includeHidden: true }).count(), 1, "expanded nested directories survive Activity resumption");
    assert.equal(await tree.getByRole("status", { includeHidden: true }).count(), 0, "cached directory rows do not flash a loading state");
  };

  await conversation.getByRole("button", { name: "工具调用", exact: true }).click();
  const tools = page.locator(".tool-calls-page:visible");
  await tools.waitFor();
  assert.equal(await page.evaluate(() => window.fixtureConversation.isConnected), true, "inactive preserved panels retain their DOM");
  assert.equal(await tools.locator(".tool-call-turn").count(), 24);
  await tools.getByRole("button", { name: "加载更早工具调用（还剩 36 轮）", exact: true }).click();
  await tools.getByRole("button", { name: "加载更早工具调用（还剩 12 轮）", exact: true }).waitFor();
  await tools.locator(".tool-call-details > summary").first().click();
  const toolsBefore = await tools.locator(".tool-calls-scroll").evaluate(node => {
    window.fixtureToolScroll = node;
    window.fixtureToolDetails = node.querySelector(".tool-call-details[open]");
    node.scrollTop = Math.min(550, (node.scrollHeight - node.clientHeight) / 2);
    return node.scrollTop;
  });
  assert.ok(toolsBefore > 100, "the Tool calls page has a meaningful reading position");
  await settleLayout(page);
  const assertToolsPreserved = async () => {
    await tools.waitFor();
    await settleLayout(page);
    assert.equal(await tools.locator(".tool-call-turn").count(), 48, "the Tool calls history window survives navigation");
    assert.equal(await tools.locator(".tool-calls-scroll").evaluate(node => node === window.fixtureToolScroll), true, "the Tool calls reading surface is retained");
    assert.equal(await page.evaluate(() => window.fixtureToolDetails.isConnected && window.fixtureToolDetails.open), true, "expanded Tool call details survive navigation");
    assert.ok(Math.abs(await tools.locator(".tool-calls-scroll").evaluate(node => node.scrollTop) - toolsBefore) <= 2, "the Tool calls reading position survives navigation");
  };
  await page.getByRole("button", { name: "主会话", exact: true }).click();
  await assertPreserved();
  await conversation.getByRole("button", { name: "工具调用", exact: true }).click();
  await assertToolsPreserved();
  await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
  await page.getByRole("heading", { name: "导航验收设置", exact: true }).waitFor();
  await rail(page).getByRole("button", { name: "会话", exact: true }).click();
  await assertPreserved();
  // Two resumed directory trees can occupy Chromium's six HTTP/1 connections.
  // Release freshness reads before issuing the separate Session refresh below.
  fixture.resumeDirectories();
  await conversation.getByRole("button", { name: "工具调用", exact: true }).click();
  await assertToolsPreserved();
  await tools.getByRole("button", { name: "主会话", exact: true }).click();
  await assertPreserved();

  // Force a normal model refresh too: the existing three-second list/Run poll
  // is allowed; an unchanged canonical transcript and prompt are not re-read.
  await page.evaluate(() => window.fixture.refreshSessions());
  assert.deepEqual([fixture.reads.get("/api/sessions/a/history"), fixture.reads.get("/api/sessions/a/controls/system-prompt-history")], readsBefore,
    "navigation does not fetch the unchanged transcript or system prompt again");
  if (viewport.width < 1181) await conversation.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
  assert.equal(await tree.getByRole("button", { name: "retained.txt", exact: true }).isVisible(), true);
  await sidebar.getByRole("tab", { name: "验收工作窗口", exact: true }).click();
  assert.equal(await sidebar.getByRole("textbox", { name: "工作窗口草稿", exact: true }).inputValue(), "切换页面后保留的工作窗口");
  assert.equal(await sidebar.getByRole("tab", { name: "验收工作窗口", exact: true }).count(), 1, "the working tab is retained");
  await sidebar.getByRole("button", { name: "收起会话侧栏", exact: true }).click();

  if (viewport.width >= 1181) {
    await conversation.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
    await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await rail(page).getByRole("button", { name: "会话", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".conversation .session-sidebar")?.hidden === true);
    assert.equal(await conversation.locator(".conversation-main").getAttribute("inert"), null, "resuming after a hidden resize does not leave the main view inert");
    await conversation.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
    assert.notEqual(await conversation.locator(".conversation-main").getAttribute("inert"), null, "the resumed sidebar follows the current narrow viewport");
    await sidebar.getByRole("button", { name: "收起会话侧栏", exact: true }).click();
    await page.setViewportSize(viewport);
    await settleLayout(page);
  }

  await selectSession(page, "会话 B");
  await conversation.getByRole("button", { name: "加载更早轮次（还剩 36 轮）", exact: true }).waitFor();
  assert.equal(await conversation.locator(".conversation-turn").count(), 24, "another Session gets its own history window");
  assert.equal(await conversation.locator(".system-prompt-disclosure").evaluate(node => node.open), false, "another Session does not inherit the expanded prompt");
  await conversation.locator(".system-prompt-disclosure > summary").click();
  await conversation.getByText("会话 B 的系统提示词", { exact: true }).waitFor();
  assert.equal(await conversation.getByText("会话 A 的系统提示词", { exact: true }).count(), 0);
  assert.deepEqual(errors, [], "navigation must not produce browser exceptions");
}

async function checkOwnerLifecycle(page, url) {
  await page.goto(url);
  await visibleConversation(page).waitFor();
  assert.equal(await page.locator("[data-probe]").count(), 0, "preservation does not eagerly mount unvisited panels");
  await rail(page).getByRole("button", { name: "生命周期", exact: true }).click();
  await page.getByRole("button", { name: "计数 0", exact: true }).click();
  await page.getByRole("button", { name: "计数 1", exact: true }).waitFor();
  await page.evaluate(() => { window.fixtureProbe = document.querySelector('[data-probe="first"]'); });
  await rail(page).getByRole("button", { name: "相同界面入口", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "计数 1", exact: true }).count(), 1, "aliases of the same View share one retained instance");
  assert.equal(await page.locator('[data-probe="first"]').count(), 1);

  await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
  await page.waitForFunction(() => window.fixture.lifecycle.first?.active === false);
  assert.equal(await page.evaluate(() => window.fixtureProbe.isConnected), true);
  const ticks = await page.evaluate(() => window.fixture.lifecycle.first.ticks);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.fixture.lifecycle.first.ticks), ticks, "hidden Activity pauses the view's effects");
  await rail(page).getByRole("button", { name: "生命周期", exact: true }).click();
  await page.waitForFunction(() => window.fixture.lifecycle.first?.active === true);
  assert.equal(await page.getByRole("button", { name: "计数 1", exact: true }).count(), 1);

  await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
  await page.evaluate(() => window.fixture.reRegisterProbe("first"));
  await page.waitForFunction(() => !window.fixtureProbe.isConnected);
  await rail(page).getByRole("button", { name: "生命周期", exact: true }).click();
  await page.getByRole("button", { name: "计数 0", exact: true }).waitFor();
  assert.equal(await page.locator('[data-probe="first"]').count(), 1, "re-registering the same function creates a fresh owner lifetime");
  await page.evaluate(() => { window.fixtureProbe = document.querySelector('[data-probe="first"]'); });
  await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
  await page.evaluate(() => window.fixture.removeProbe());
  await page.waitForFunction(() => !window.fixtureProbe.isConnected);
  assert.equal(await page.locator('[data-probe="first"]').count(), 0, "owner removal releases a hidden retained view");
  await page.evaluate(() => window.fixture.replaceProbe("second"));
  await rail(page).getByRole("button", { name: "生命周期", exact: true }).click();
  await page.getByRole("button", { name: "计数 0", exact: true }).click();
  await page.evaluate(() => { window.fixtureProbe = document.querySelector('[data-probe="second"]'); });
  await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
  await page.evaluate(() => window.fixture.replaceProbe("third"));
  await page.waitForFunction(() => !window.fixtureProbe.isConnected);
  assert.equal(await page.locator('[data-probe="second"]').count(), 0, "replacing a module releases its hidden old View");
  await rail(page).getByRole("button", { name: "生命周期", exact: true }).click();
  await page.getByRole("heading", { name: "界面生命周期 third", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "计数 0", exact: true }).count(), 1, "a replacement starts with fresh component state");
}

async function checkPromptRefreshNavigation(page, fixture) {
  await page.goto(fixture.url);
  const conversation = visibleConversation(page), prompt = conversation.locator(".system-prompt-disclosure");
  await prompt.waitFor();
  await prompt.locator("summary").click();
  await conversation.getByText("会话 A 的系统提示词", { exact: true }).waitFor();
  await prompt.evaluate(node => {
    window.fixturePrompt = node;
    window.fixturePromptRemoved = 0; window.fixturePromptClosed = 0;
    window.fixturePromptObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const removed of record.removedNodes) if (removed === node || removed.contains(node)) window.fixturePromptRemoved++;
        if (record.type === "attributes" && record.target === node && !node.open) window.fixturePromptClosed++;
      }
    });
    window.fixturePromptObserver.observe(document.getElementById("root"), { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  });
  const assertSamePrompt = async label => {
    await settleLayout(page);
    assert.equal(await prompt.evaluate(node => node === window.fixturePrompt && node.open), true, label + " keeps the same open prompt DOM node");
    assert.equal(await conversation.getByText("会话 A 的系统提示词", { exact: true }).isVisible(), true);
    assert.deepEqual(await page.evaluate(() => [window.fixturePromptRemoved, window.fixturePromptClosed]), [0, 0], label + " never briefly removes or closes the disclosure");
  };
  for (const mode of ["failure", "empty", "complete"]) {
    fixture.pausePrompts();
    if (mode === "failure") fixture.failNextPrompt();
    if (mode === "empty") fixture.emptyNextPrompt();
    const requested = page.waitForRequest(request => request.url().endsWith("/controls/system-prompt-history"));
    await page.evaluate(() => window.fixture.refreshPrompts()); await requested;
    await conversation.getByRole("button", { name: "工具调用", exact: true }).click();
    await page.getByRole("button", { name: "主会话", exact: true }).click();
    await assertSamePrompt(mode + " pending during Tool calls round trip");
    await rail(page).getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("heading", { name: "导航验收设置", exact: true }).waitFor();
    await rail(page).getByRole("button", { name: "会话", exact: true }).click();
    await assertSamePrompt(mode + " pending during Settings round trip");
    const response = page.waitForResponse(response => response.url().endsWith("/controls/system-prompt-history"));
    fixture.resumePrompts(); await response;
    await assertSamePrompt(mode + " response settled");
  }
  await page.evaluate(() => window.fixturePromptObserver.disconnect());

  fixture.pausePrompts();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByRole("heading", { name: "导航验收新会话", exact: true }).waitFor();
  await page.waitForFunction(() => !window.fixturePrompt.isConnected);
  await selectSession(page, "会话 A");
  assert.equal(await prompt.evaluate(node => node.open), true, "returning to the cached Session restores its disclosure before the blocked HTTP read");
  assert.equal(await conversation.getByText("会话 A 的系统提示词", { exact: true }).isVisible(), true);
  const restored = page.waitForResponse(response => response.url().endsWith("/controls/system-prompt-history"));
  fixture.resumePrompts(); await restored;
  await selectSession(page, "会话 B");
  assert.equal(await prompt.evaluate(node => node.open), false, "a different Session starts collapsed");
  await selectSession(page, "会话 A");
  assert.equal(await prompt.evaluate(node => node.open), true, "returning to the same historical snapshot restores its own expansion");

  fixture.pausePrompts();
  await page.evaluate(() => window.fixture.replaceHost());
  await page.waitForFunction(() => !document.querySelector(".system-prompt-disclosure"));
  const replaced = page.waitForResponse(response => response.url().endsWith("/controls/system-prompt-history"));
  fixture.resumePrompts(); await replaced;
  await prompt.waitFor();
  assert.equal(await prompt.evaluate(node => node.open), false, "a replacement Host cannot inherit the prior Host's disclosure state");
}

const bundle = await compileFixture();
if (process.argv.includes("--build-only")) {
  console.log("Navigation Browser fixture bundled successfully; no browser interactions were run.");
} else {
  test("Browser navigation preserves conversation presentation and releases removed UI owners", { timeout: 120_000 }, async t => {
    let fixture, browser;
    try {
      browser = await chromium.launch({ headless: true });
      fixture = await fixtureServer(bundle);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await t.test("conversation round trips at " + viewport.width + "px", async () => {
          const page = await browser.newPage({ viewport });
          page.setDefaultTimeout(10_000);
          try { await checkNavigation(page, fixture, viewport); }
          finally { fixture.resumeDirectories(); await page.close(); }
        });
      }
      await t.test("retained panels pause effects and follow UI owner lifetimes", async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.setDefaultTimeout(10_000);
        try { await checkOwnerLifecycle(page, fixture.url); }
        finally { await page.close(); }
      });
      await t.test("prompt refreshes preserve the exact disclosure through same-Session navigation", async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.setDefaultTimeout(10_000);
        try { await checkPromptRefreshNavigation(page, fixture); }
        finally { fixture.resumePrompts(); await page.close(); }
      });
    } finally { await browser?.close(); await fixture?.close(); }
  });
}
