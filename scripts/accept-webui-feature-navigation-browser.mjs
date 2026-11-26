import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));
// Real production views and mirrors; the fixture owns deterministic transport
// responses and never starts a Host or dispatches an actual feature action.
const entry = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { SnapshotStore } from "./src/apps/webui/client/model/store.ts";
import { ClientApiError } from "./src/apps/webui/client/connection.ts";
import { FeaturesClientModel } from "./src/apps/webui/client/model/features.ts";
import { UiSlots } from "./src/apps/webui/client/slots.ts";
import { Shell } from "./src/apps/webui/client/ui/shell.tsx";
import { Conversation } from "./src/apps/webui/client/ui/conversation.tsx";
import { ToolCalls } from "./src/apps/webui/client/ui/tool-calls.tsx";
import { ComposerDrafts } from "./src/apps/webui/client/ui/drafts.ts";
import { GoalClientUi } from "./src/goal/consumers/webui/index.tsx";
import { TodoClientUi } from "./src/todo/consumers/webui/index.tsx";
import { ApprovalClientUi } from "./src/approval/consumers/webui/index.tsx";
import { ReasoningClientModel } from "./src/models/consumers/webui/reasoning-model.ts";
import { ReasoningComposerItem } from "./src/models/consumers/webui/reasoning-view.tsx";
import { PermissionProfileClientModel } from "./src/permissions/consumers/webui/profile-model.ts";
import { PermissionProfileComposerItem } from "./src/permissions/consumers/webui/profile-view.tsx";

let mode = "normal";
let approvalGate, releaseApprovalGate;
const writes = [], reads = [];
const goal = { key: "goal", title: "Goal", text: "持续交付目标", token: { revision: 1 }, actions: [{ name: "pause", label: "暂停" }],
  data: { schemaVersion: 1, id: "goal-one", objective: "保留主会话任务卡", phase: "active", activation: "armed", revision: 1, roundsStarted: 1, maxGoalRounds: 10 } };
const todo = { key: "todo", title: "Todo", text: "待办事项", token: {}, actions: [],
  data: { schemaVersion: 1, sessionId: "one", runId: "run-one", items: [{ id: "item-one", content: "验证切页连续性", status: "in_progress" }] } };
const reasoningView = { model: { provider: "fixture", model: "fixture-model" }, selected: "low",
  control: { format: "deepseek-chat", efforts: ["low", "high"], defaultEffort: "high" } };
const permissionView = { availableProfiles: ["read-only", "workspace-write"], selected: "workspace-write", source: "session", shellBackend: "linux-native", workspaceIsolation: true };
const approval = { approvalId: "approval-one", scope: { runId: "run-one" }, call: { name: "fixture_read", input: { path: "fixture.txt" } },
  capabilities: { requirements: [] }, workspace: { cwd: "/fixture" } };
class Connection extends SnapshotStore {
  constructor() { super({ online: true, businessAvailable: true, instanceId: "feature-fixture", error: null }); }
  onInvalidation() { return () => {}; }
  async request(path, body) {
    if (body) { writes.push({ path, body }); throw Error("No feature write is expected in the navigation fixture"); }
    reads.push(path);
    if (mode === "failure") throw Error("temporary read failure");
    if (mode === "revoked") throw new ClientApiError("control_not_found", 404);
    if (path.endsWith("/features")) return { features: mode === "empty" ? [] : [goal, todo] };
    if (path.startsWith("/api/approvals")) { if (approvalGate) await approvalGate; return { approvals: mode === "empty" ? [] : [approval] }; }
    if (path.endsWith("/controls/model-reasoning")) return { value: reasoningView };
    if (path.endsWith("/controls/permission-profile")) return { value: permissionView };
    throw Error("Unexpected fixture path " + path);
  }
}
const connection = new Connection(), slots = new UiSlots(), drafts = new ComposerDrafts();
const sessions = new SnapshotStore({ selectedId: "one", sessions: [{ sessionId: "one", title: "组件导航验收", scope: "/fixture", status: "active" }],
  history: { sessionId: "one", records: [], historyRevision: "v1" }, runs: [{ runId: "run-one", status: "running" }],
  available: true, working: false, loading: false, error: null, filter: "active", creating: false });
sessions.run = new SnapshotStore({ runId: "run-one", events: [], deliveries: [], terminal: false, connected: true, error: null });
sessions.browse = () => {};
const features = new FeaturesClientModel(connection, sessions), reasoning = new ReasoningClientModel(connection, sessions), permissions = new PermissionProfileClientModel(connection, sessions);
const settings = new SnapshotStore({ sections: [] }), removers = [];
const ctx = { wishSession: sessions, wishConnection: connection, wishUiSlots: slots, wishFeatures: features,
  effect(action) { const remove = action(); if (typeof remove === "function") removers.push(remove); } };
GoalClientUi.apply(ctx); TodoClientUi.apply(ctx); ApprovalClientUi.apply(ctx);
slots.composer({ id: "reasoning", View: props => <ReasoningComposerItem model={reasoning} {...props} /> });
slots.composer({ id: "permissions", View: props => <PermissionProfileComposerItem model={permissions} {...props} /> });
slots.panel({ id: "conversation", label: "会话", area: "workspace", preserveState: true, View: () => <Conversation model={sessions} settings={settings} slots={slots} drafts={drafts} /> });
slots.panel({ id: "tool-calls", label: "工具调用", area: "workspace", navigation: "hidden", preserveState: true, View: () => <ToolCalls model={sessions} slots={slots} /> });
slots.panel({ id: "preferences", label: "通用设置", area: "settings", View: () => <section><h1>组件导航设置</h1></section> });
slots.openPanel("conversation");
const root = createRoot(document.getElementById("root")); root.render(<Shell slots={slots} connection={connection} />);
window.fixture = {
  writes, reads,
  async refresh(nextMode = mode) { mode = nextMode; sessions.publish({ ...sessions.getSnapshot() }); await Promise.all([features.refresh(), reasoning.refresh(), permissions.refresh()]); },
  beginMutation() { sessions.publish({ ...sessions.getSnapshot(), working: true }); },
  settleMutation() { approvalGate = new Promise(resolve => { releaseApprovalGate = resolve; }); sessions.publish({ ...sessions.getSnapshot(), working: false }); },
  releaseApprovals() { releaseApprovalGate?.(); approvalGate = undefined; releaseApprovalGate = undefined; },
  completeRun() { sessions.run.publish({ ...sessions.run.getSnapshot(), terminal: true }); sessions.publish({ ...sessions.getSnapshot(), runs: [{ runId: "run-one", status: "completed" }] }); },
  close() { root.unmount(); for (const remove of removers.reverse()) remove(); features.close(); reasoning.close(); permissions.close(); drafts.close(); },
};
`;

const result = await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "feature-navigation-fixture.tsx", loader: "tsx" },
  absWorkingDir: repository, bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
const bundle = result.outputFiles[0].text;
if (process.argv.includes("--build-only")) {
  console.log("Feature navigation Browser fixture bundled; no Browser interactions were run.");
} else for (const width of [1440, 390]) test(`Goal, Todo, approvals and composer selectors retain UI across navigation at ${width}px and fail closed on stale reads`, { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(10_000);
  try {
    const css = await readFile(new URL("../src/apps/webui/public/app.css", import.meta.url), "utf8");
    await page.setContent('<!doctype html><html lang="zh-CN"><style>' + css + '</style><div id="root"></div></html>');
    await page.addScriptTag({ content: bundle });
    const conversation = page.locator(".conversation:visible"), rail = page.getByRole("navigation", { name: "主要导航", exact: true });
    await conversation.locator(".goal-card").waitFor();
    await conversation.locator(".todo-card").waitFor();
    await conversation.getByRole("region", { name: "工具审批 fixture_read", exact: true }).waitFor();
    await conversation.getByRole("textbox", { name: "消息", exact: true }).fill("跨页面保留的输入草稿");
    await conversation.locator(".goal-card-actions").getByRole("button", { name: "暂停", exact: true }).click();
    await conversation.locator(".approval-technical > summary").click();
    await conversation.locator(".approval-request select").selectOption("workspace");
    await page.evaluate(() => {
      const selectors = [".goal-card", ".goal-card-confirm", ".todo-card", ".approval-request", "#wish-reasoning-effort", "#wish-permission-profile", "#wish-composer"];
      window.retained = selectors.map(selector => ({ selector, node: document.querySelector(selector) }));
      window.removed = [];
      window.observer = new MutationObserver(records => {
        for (const record of records) for (const removed of record.removedNodes) for (const entry of window.retained) {
          if (removed === entry.node || removed.contains(entry.node)) window.removed.push(entry.selector);
        }
      });
      window.observer.observe(document.getElementById("root"), { childList: true, subtree: true });
    });
    const assertRetained = async () => {
      await conversation.locator(".goal-card-confirm").waitFor();
      assert.equal(await conversation.locator(".approval-request select").inputValue(), "workspace");
      assert.equal(await conversation.locator(".approval-technical").evaluate(node => node.open), true);
      assert.equal(await conversation.locator("#wish-reasoning-effort").inputValue(), "low");
      assert.equal(await conversation.locator("#wish-permission-profile").inputValue(), "workspace-write");
      assert.equal(await conversation.locator("#wish-composer").inputValue(), "跨页面保留的输入草稿");
      assert.deepEqual(await page.evaluate(() => window.retained.filter(entry => document.querySelector(entry.selector) !== entry.node).map(entry => entry.selector)), []);
      assert.deepEqual(await page.evaluate(() => window.removed), [], "none of the lower conversation components were briefly removed");
    };
    for (const area of ["tools", "settings"]) {
      if (area === "tools") {
        await conversation.getByRole("button", { name: "工具调用", exact: true }).click();
        await page.getByRole("button", { name: "主会话", exact: true }).click();
      } else {
        await rail.getByRole("button", { name: "设置与插件", exact: true }).click();
        await page.getByRole("heading", { name: "组件导航设置", exact: true }).waitFor();
        await rail.getByRole("button", { name: "会话", exact: true }).click();
      }
      await assertRetained();
    }
    await page.evaluate(() => window.fixture.beginMutation());
    await assertRetained();
    assert.equal(await conversation.locator(".approval-request .primary").isDisabled(), true, "Session mutation disables approval submission without replacing its controls");
    await page.evaluate(() => window.fixture.settleMutation());
    await assertRetained();
    assert.equal(await conversation.locator(".approval-request .primary").isDisabled(), true, "settling keeps approval disabled until the blocked authority read completes");
    await page.evaluate(() => window.fixture.releaseApprovals());
    await page.waitForFunction(() => document.querySelector(".approval-request .primary")?.disabled === false);
    await assertRetained();
    await rail.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.evaluate(() => window.fixture.refresh("failure"));
    await rail.getByRole("button", { name: "会话", exact: true }).click();
    await assertRetained();
    assert.equal(await conversation.locator(".goal-card-confirm").getByRole("button", { name: "确认", exact: true }).isDisabled(), true);
    await page.waitForFunction(() => document.querySelector(".approval-request .primary")?.disabled);
    assert.equal(await conversation.locator("#wish-reasoning-effort").isDisabled(), true);
    assert.equal(await conversation.locator("#wish-permission-profile").isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.writes), [], "retaining a display never restores old write admission");
    await page.evaluate(() => { window.observer.disconnect(); return window.fixture.refresh("revoked"); });
    await conversation.locator(".goal-card").waitFor({ state: "detached" });
    await conversation.locator(".todo-card").waitFor({ state: "detached" });
    await conversation.locator(".approval-request").waitFor({ state: "detached" });
    assert.equal(await conversation.locator("#wish-reasoning-effort").count(), 0, "a revoked selector removes its old model and choices");
    assert.equal(await conversation.locator("#wish-permission-profile").inputValue(), "", "revocation clears the previous access selection");
    assert.equal(await conversation.locator("#wish-permission-profile").isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.writes), [], "revoked presentation never regains action admission");
    await page.evaluate(() => window.fixture.refresh("normal"));
    await conversation.locator(".goal-card").waitFor();
    await page.evaluate(() => window.fixture.refresh("empty"));
    await conversation.locator(".goal-card").waitFor({ state: "detached" });
    await conversation.locator(".todo-card").waitFor({ state: "detached" });
    await conversation.locator(".approval-request").waitFor({ state: "detached" });
    await page.evaluate(() => window.fixture.refresh("normal"));
    await conversation.locator(".todo-card").waitFor();
    await rail.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.evaluate(() => window.fixture.completeRun());
    await rail.getByRole("button", { name: "会话", exact: true }).click();
    await conversation.locator(".todo-card").waitFor({ state: "detached" });
    await conversation.locator(".approval-request").waitFor({ state: "detached" });
  } finally { await page.evaluate(() => window.fixture?.close()).catch(() => {}); await browser.close(); }
});
