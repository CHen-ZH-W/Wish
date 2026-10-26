import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));
// Actual conversation card, model, and Shell/Activity with deterministic HTTP.
// It exercises presentation and Session mutation boundaries, without a Host.
const entry = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { ClientApiError } from "./src/apps/webui/client/connection.ts";
import { SnapshotStore } from "./src/apps/webui/client/model/store.ts";
import { SessionClientModel } from "./src/apps/webui/client/model/session.ts";
import { UiSlots } from "./src/apps/webui/client/slots.ts";
import { Shell } from "./src/apps/webui/client/ui/shell.tsx";
import { Conversation } from "./src/apps/webui/client/ui/conversation.tsx";
import { ToolCalls } from "./src/apps/webui/client/ui/tool-calls.tsx";
import { ComposerDrafts } from "./src/apps/webui/client/ui/drafts.ts";
import { DevelopmentClientModel } from "./src/development/consumers/webui/model.ts";
import { DevelopmentConversationCard } from "./src/development/consumers/webui/view.tsx";
class FixtureConnection extends SnapshotStore {
  constructor() { super({ online: true, businessAvailable: true, instanceId: "development-navigation-host", error: null }); }
  onInvalidation() { return () => {}; }
  async request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new ClientApiError(value.error?.code ?? "fixture_http_" + response.status, response.status);
    return value;
  }
  stream() { throw new Error("This fixture does not run a model"); }
}
const connection = new FixtureConnection(), slots = new UiSlots(), sessions = new SessionClientModel(connection);
const settings = new SnapshotStore({ sections: [] }), drafts = new ComposerDrafts();
await sessions.refresh();
const model = new DevelopmentClientModel(connection, sessions);
const removeCard = slots.conversationCard({ id: "wish-development", View: ({ sessionId }) => <DevelopmentConversationCard model={model} sessionId={sessionId} /> });
slots.panel({ id: "conversation", label: "会话", area: "workspace", navigationGroup: "session", preserveState: true,
  View: () => <Conversation model={sessions} settings={settings} slots={slots} drafts={drafts} /> });
slots.panel({ id: "tool-calls", label: "工具调用", area: "workspace", navigation: "hidden", navigationGroup: "session", preserveState: true,
  View: () => <ToolCalls model={sessions} slots={slots} /> });
slots.panel({ id: "preferences", label: "通用设置", area: "settings", View: () => <section><h1>开发卡导航验收设置</h1></section> });
const root = createRoot(document.getElementById("root")); root.render(<Shell slots={slots} connection={connection} />);
window.fixture = {
  open(id) { slots.openPanel(id); },
  refresh() { return model.refresh(); },
  working(value) { sessions.publish({ ...sessions.getSnapshot(), working: value }); },
  select(id) { if (id) sessions.select(id); else sessions.startCreate(); },
  canAct() { return model.canAct(model.getSnapshot().projects[0]); },
  snapshot() { return model.getSnapshot(); },
  remove() { removeCard(); model.close(); },
};
window.addEventListener("pagehide", () => { root.unmount(); model.close(); sessions.close(); drafts.close(); }, { once: true });
`;

function project(changeId = "change") {
  const time = "2026-10-22T00:00:00Z";
  return { schemaVersion: 1, id: "project", workspaceRoot: "/fixture", title: "开发卡导航验收", sessionIds: ["a"], revision: 1,
    activeChangeId: changeId, createdAt: time, updatedAt: time,
    changes: [{ id: changeId, sessionId: "a", rawWish: "保留方案确认与需求调整状态", wishUpdates: [],
      specs: [{ version: 1, digest: "fixture-spec", objective: "开发卡在页面切换中保持稳定", createdAt: time,
        scope: ["保留阅读与确认状态"], outOfScope: ["外部模型与公开部署"], constraints: [], questions: [], assumptions: [], decisions: [],
        criteria: [{ id: "stable", text: "往返设置后保留当前确认方案", kind: "technical" }], planMarkdown: "核对会话与方案身份后继续操作。",
        assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "本地导航行为验收" } }],
      phase: "exploring", gate: "confirmation", executionEpoch: 1, confirmations: [], starts: [], verifications: [], reports: [], createdAt: time, updatedAt: time }] };
}

async function serveFixture(bundle) {
  const css = await readFile(new URL("../src/apps/webui/public/app.css", import.meta.url));
  let currentProject = project();
  const reads = [];
  const sessions = ["a", "b"].map(sessionId => ({ schemaVersion: 1, sessionId, agentId: "fixture", title: "会话 " + sessionId.toUpperCase(),
    scope: "/fixture", status: "active", historyRevision: sessionId + "-v1", createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" }));
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>'); return;
    }
    if (path === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return; }
    if (path === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return; }
    if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/sessions") { response.end(JSON.stringify({ sessions })); return; }
    if (path === "/api/controls/wish-development/default") {
      reads.push(path); response.end(JSON.stringify({ value: { projects: [currentProject] } })); return;
    }
    const match = /^\/api\/sessions\/([ab])\/(history|runs|controls\/wish-development)$/u.exec(path);
    if (!match) { response.writeHead(404); response.end(JSON.stringify({ error: { code: "unknown_fixture_endpoint" } })); return; }
    const [, sessionId, resource] = match;
    if (resource === "history") { response.end(JSON.stringify({ history: { sessionId, historyRevision: sessionId + "-v1", records: [] } })); return; }
    if (resource === "runs") { response.end(JSON.stringify({ runs: [] })); return; }
    reads.push(path);
    if (request.method === "POST") { response.writeHead(409); response.end(JSON.stringify({ error: { code: "development_revision_conflict" } })); return; }
    response.end(JSON.stringify({ value: { project: sessionId === "a" ? currentProject : null } }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port, reads,
    reset() { currentProject = project(); },
    change() { currentProject = project("next-change"); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function checkNavigation(page, fixture) {
  const errors = []; page.on("pageerror", error => errors.push(error.message)); fixture.reset();
  await page.goto(fixture.url);
  const card = page.locator(".development-conversation-card:visible"); await card.waitFor();
  await card.locator(".development-details > summary").click();
  await card.getByRole("button", { name: "查看方案并确认", exact: true }).click();
  await card.locator(".development-confirm").waitFor();
  await card.evaluate(node => { window.originalCard = node; window.originalConfirmation = node.querySelector(".development-confirm"); });
  const roundTrip = async destination => {
    await page.evaluate(id => window.fixture.open(id), destination);
    await page.locator(destination === "tool-calls" ? ".tool-calls-page:visible" : "h1:visible").waitFor();
    await page.evaluate(() => window.fixture.open("conversation")); await card.waitFor();
    assert.equal(await card.evaluate(node => node === window.originalCard), true);
    assert.equal(await card.locator(".development-details").getAttribute("open"), "");
  };
  for (const destination of ["tool-calls", "preferences"]) {
    await roundTrip(destination);
    assert.equal(await card.locator(".development-confirm").evaluate(node => node === window.originalConfirmation), true,
      "Activity restoration preserves the exact confirmation being reviewed");
  }
  await page.evaluate(() => window.fixture.working(true));
  const readsBefore = fixture.reads.length;
  await page.evaluate(() => window.fixture.refresh());
  assert.equal(fixture.reads.length, readsBefore, "a working Session keeps its prior project without null-Session reads");
  assert.equal(await page.evaluate(() => window.fixture.canAct()), false);
  assert.equal(await card.getByRole("button", { name: "确认并开始", exact: true }).isDisabled(), true);
  assert.equal(await card.evaluate(node => node === window.originalCard), true);
  await roundTrip("preferences");
  await page.evaluate(() => window.fixture.working(false));
  await page.evaluate(() => window.fixture.refresh());
  assert.equal(await card.getByRole("button", { name: "确认并开始", exact: true }).isEnabled(), true);
  await card.getByRole("button", { name: "确认并开始", exact: true }).click();
  await card.locator("[role=alert]").waitFor();
  const error = await card.locator("[role=alert]").textContent();
  await roundTrip("tool-calls");
  assert.equal(await card.locator("[role=alert]").textContent(), error, "a failed action remains explained after navigation");
  assert.equal(await card.locator(".development-confirm").count(), 1);
  await card.getByRole("button", { name: "取消", exact: true }).click();
  await card.getByRole("button", { name: "调整需求", exact: true }).click();
  const hint = card.getByText("直接在下方消息中说明想改什么，Wish 会更新目标与方案，再请你确认。", { exact: true });
  await hint.waitFor(); await roundTrip("preferences"); await hint.waitFor();
  fixture.change(); await page.evaluate(() => window.fixture.refresh());
  await hint.waitFor({ state: "detached" });
  assert.equal(await card.locator(".development-confirm").count(), 0, "a real change identity discards the old confirmation");
  await page.evaluate(() => window.fixture.select("b"));
  await page.waitForFunction(() => document.querySelector(".development-conversation-card h2")?.textContent === "项目交付记录");
  assert.equal(await page.evaluate(() => window.originalCard.isConnected), false, "changing Session releases the previous card state");
  await page.evaluate(() => window.fixture.select(null));
  await page.waitForFunction(() => !document.querySelector(".development-conversation-card"));
  assert.equal(await page.evaluate(() => window.fixture.snapshot().sessionProjectId), null);
  await page.evaluate(() => window.fixture.remove()); assert.deepEqual(errors, []);
}

const result = await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "development-navigation-fixture.tsx", loader: "tsx" },
  absWorkingDir: repository, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
if (process.argv.includes("--build-only")) {
  console.log("Development navigation Browser fixture bundled successfully; no browser interactions were run.");
} else {
  test("development cards preserve reviewed state during navigation and same-Session work", { timeout: 60_000 }, async t => {
    let browser, fixture;
    try {
      browser = await chromium.launch({ headless: true }); fixture = await serveFixture(result.outputFiles[0].contents);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await t.test("development navigation at " + viewport.width + "px", async () => {
          const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10_000);
          try { await checkNavigation(page, fixture); } finally { await page.close(); }
        });
      }
    } finally { await browser?.close(); await fixture?.close(); }
  });
}
