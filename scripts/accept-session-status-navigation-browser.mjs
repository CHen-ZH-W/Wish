import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));

// Production views, models, Shell, and Activity boundaries with deterministic
// HTTP responses; this does not start a Host or call a model Provider.
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
import { ContextOccupancyClientModel } from "./src/context/consumers/webui/model.ts";
import { ContextOccupancyStatus } from "./src/context/consumers/webui/view.tsx";
import { ModelUsageClientModel } from "./src/models/pricing/consumers/webui/model.ts";
import { ModelUsageStatus } from "./src/models/pricing/consumers/webui/view.tsx";
import { ModelCostStatus } from "./src/models/pricing/consumers/webui/cost-view.tsx";

class FixtureConnection extends SnapshotStore {
  invalidations = new Set();
  constructor() { super({ online: true, businessAvailable: true, instanceId: "status-host", error: null }); }
  onInvalidation(listener) { this.invalidations.add(listener); return () => this.invalidations.delete(listener); }
  async request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new ClientApiError(value.error?.code ?? "fixture_http_" + response.status, response.status);
    return value;
  }
  stream() { throw new Error("The status fixture does not start a Run"); }
}
const connection = new FixtureConnection(), slots = new UiSlots();
const sessions = new SessionClientModel(connection), settings = new SnapshotStore({ sections: [] }), drafts = new ComposerDrafts();
await sessions.refresh();
const context = new ContextOccupancyClientModel(connection, sessions), usage = new ModelUsageClientModel(connection, sessions);
const removers = [
  slots.sessionStatus({ id: "context-occupancy", View: ({ sessionId }) => <ContextOccupancyStatus model={context} sessionId={sessionId} /> }),
  slots.sessionStatus({ id: "model-usage", View: ({ sessionId }) => <ModelUsageStatus model={usage} sessionId={sessionId} /> }),
  slots.sessionStatus({ id: "model-cost", View: ({ sessionId }) => <ModelCostStatus model={usage} sessionId={sessionId} /> }),
];
slots.panel({ id: "conversation", label: "会话", area: "workspace", navigationGroup: "session", preserveState: true,
  View: () => <Conversation model={sessions} settings={settings} slots={slots} drafts={drafts} /> });
slots.panel({ id: "tool-calls", label: "工具调用", area: "workspace", navigation: "hidden", navigationGroup: "session", preserveState: true,
  View: () => <ToolCalls model={sessions} slots={slots} /> });
slots.panel({ id: "preferences", label: "通用设置", area: "settings", View: () => <section><h1>状态导航验收设置</h1></section> });
const root = createRoot(document.getElementById("root"));
root.render(<Shell slots={slots} connection={connection} />);
window.fixture = {
  refresh() { return Promise.all([context.refresh(), usage.refresh()]); },
  snapshots() { return { context: context.getSnapshot(), usage: usage.getSnapshot() }; },
  open(id) { slots.openPanel(id); },
  select(id) { sessions.select(id); },
  connection(patch) { connection.publish({ ...connection.getSnapshot(), ...patch }); },
  removeOwner() { for (const remove of removers) remove(); context.close(); usage.close(); },
};
window.addEventListener("pagehide", () => { root.unmount(); context.close(); usage.close(); sessions.close(); drafts.close(); }, { once: true });
`;

async function compileFixture() {
  const result = await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "session-status-fixture.tsx", loader: "tsx" },
    absWorkingDir: repository, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  return result.outputFiles[0].contents;
}

function contextView(sessionId, lower) {
  return { schemaVersion: 1, sessionId, status: "estimated", source: "estimated", usedTokens: lower ? 16_000 : 32_000,
    contextWindow: 128_000, model: { provider: "fixture", model: lower ? "reconciled" : "status-model" },
    capturedAt: "2026-10-22T00:00:00Z", breakdown: { systemTokens: 1_000, toolsTokens: 3_000, messageTokens: lower ? 12_000 : 28_000 } };
}
function usageView(sessionId, lower) {
  return { schemaVersion: 1, scope: "session", sessionId, coverage: "complete", cacheHitRatio: lower ? 0.25 : 0.5,
    attempts: { completed: 2, usageReported: 2, cacheReadReported: 2, cacheWriteReported: 0 },
    tokens: { input: lower ? 500 : 1_000, output: 100, total: lower ? 600 : 1_100, cachedInput: lower ? 125 : 500 },
    cost: { coverage: "complete", settledAttempts: 2, pricedAttempts: 2, unavailableAttempts: 0, runningAttempts: 0,
      currencies: [{ currency: "CNY", totalCost: lower ? 0.001 : 0.0123, uncachedInputCost: 0.0001,
        cachedInputCost: 0, cacheWriteInputCost: 0, outputCost: lower ? 0.0009 : 0.0122, estimated: false, attempts: 2,
        periods: [{ period: "flat", totalCost: lower ? 0.001 : 0.0123, attempts: 2, estimated: false }] }] } };
}

async function serveFixture(bundle) {
  const css = await readFile(new URL("../src/apps/webui/public/app.css", import.meta.url));
  const reads = new Map();
  let mode = "normal", gate, release;
  const sessions = ["a", "b"].map(sessionId => ({ schemaVersion: 1, sessionId, agentId: "fixture", title: "会话 " + sessionId.toUpperCase(),
    scope: "/fixture", status: "active", historyRevision: sessionId + "-v1", createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" }));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>'); return;
    }
    if (path === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return; }
    if (path === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return; }
    if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    reads.set(path, (reads.get(path) ?? 0) + 1);
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/sessions") { response.end(JSON.stringify({ sessions })); return; }
    const match = /^\/api\/sessions\/([ab])\/(history|runs|controls\/context-occupancy|controls\/model-usage)$/u.exec(path);
    if (!match) { response.writeHead(404); response.end(JSON.stringify({ error: { code: "unknown_fixture_endpoint" } })); return; }
    const [, sessionId, resource] = match;
    if (resource === "history") { response.end(JSON.stringify({ history: { sessionId, historyRevision: sessionId + "-v1", records: [] } })); return; }
    if (resource === "runs") { response.end(JSON.stringify({ runs: [] })); return; }
    // Capture the response before delaying it to test late results at boundaries.
    const capturedMode = mode;
    if (gate) await gate;
    if (["failure", "revoked", "forbidden"].includes(capturedMode)) {
      response.writeHead(capturedMode === "failure" ? 503 : capturedMode === "forbidden" ? 403 : 404);
      response.end(JSON.stringify({ error: { code: capturedMode === "failure" ? "status_unavailable" : capturedMode === "forbidden" ? "forbidden" : "control_not_found" } })); return;
    }
    let value = resource === "controls/context-occupancy" ? contextView(sessionId, capturedMode === "lower") : usageView(sessionId, capturedMode === "lower");
    if (capturedMode === "empty") value = null;
    if (capturedMode === "mismatch") value.sessionId = "other-session";
    if (capturedMode === "unknown" && resource === "controls/context-occupancy") value = { schemaVersion: 1, sessionId, status: "unknown", source: "unknown" };
    response.end(JSON.stringify({ value }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port, reads,
    mode(value) { mode = value; },
    pause() { gate = new Promise(resolve => { release = resolve; }); },
    resume() { release?.(); gate = undefined; release = undefined; },
    async close() { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const metrics = ["context-occupancy", "model-usage", "model-cost"];
async function waitForMetrics(page) { for (const name of metrics) await page.locator(`.${name}-trigger`).waitFor(); }
async function checkNavigation(page, fixture) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  fixture.mode("normal");
  await page.goto(fixture.url);
  await waitForMetrics(page);
  await page.locator("#wish-composer").fill("页面往返后保留的草稿");
  await page.evaluate(() => {
    window.originalMetrics = [...document.querySelectorAll(".session-status-dock > *")];
    window.removedMetrics = 0;
    window.metricObserver = new MutationObserver(records => { for (const record of records) for (const removed of record.removedNodes) {
      if (window.originalMetrics.some(node => removed === node || removed.contains(node))) window.removedMetrics++;
    } });
    window.metricObserver.observe(document.getElementById("root"), { childList: true, subtree: true });
  });
  const assertRetained = async label => {
    await waitForMetrics(page);
    assert.equal(await page.evaluate(() => window.originalMetrics.every(node => node.isConnected)), true, label);
    assert.equal(await page.evaluate(() => window.removedMetrics), 0, label + " does not briefly remove a statistic");
    assert.equal(await page.locator("#wish-composer").inputValue(), "页面往返后保留的草稿");
  };
  const initialReads = metrics.map(name => fixture.reads.get(`/api/sessions/a/controls/${name === "model-cost" ? "model-usage" : name}`));
  for (const destination of ["tool-calls", "preferences"]) {
    await page.evaluate(id => window.fixture.open(id), destination);
    await page.locator(destination === "tool-calls" ? ".tool-calls-page:visible" : "h1:visible").waitFor();
    await page.evaluate(() => window.fixture.open("conversation"));
    await assertRetained(destination + " round trip");
  }
  assert.deepEqual(metrics.map(name => fixture.reads.get(`/api/sessions/a/controls/${name === "model-cost" ? "model-usage" : name}`)), initialReads,
    "page navigation alone does not issue status requests");

  // A suspended React effect must not erase an open native popover. Navigating
  // programmatically isolates Activity from native outside-click dismissal.
  for (const name of metrics) {
    await page.locator(`.${name}-trigger`).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.matches(":popover-open"), `.${name}-popover`);
    await page.evaluate(() => window.fixture.open("preferences"));
    await page.getByRole("heading", { name: "状态导航验收设置", exact: true }).waitFor();
    assert.equal(await page.locator("[popover]:popover-open").count(), 0, "a hidden panel never leaves a floating popover");
    await page.evaluate(() => window.fixture.open("conversation"));
    await page.waitForFunction(selector => document.querySelector(selector)?.matches(":popover-open"), `.${name}-popover`);
    assert.equal(await page.locator(`.${name}-trigger`).getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(selector => !document.querySelector(selector)?.matches(":popover-open"), `.${name}-popover`);
  }

  for (const mode of ["failure", "empty", "mismatch", "normal"]) {
    fixture.mode(mode); fixture.pause();
    const requested = page.waitForRequest(request => request.url().endsWith("/controls/context-occupancy"));
    await page.evaluate(() => { window.statusRefresh = window.fixture.refresh(); });
    await requested;
    for (const destination of ["tool-calls", "preferences"]) {
      await page.evaluate(id => window.fixture.open(id), destination);
      await page.locator(destination === "tool-calls" ? ".tool-calls-page:visible" : "h1:visible").waitFor();
      await page.evaluate(() => window.fixture.open("conversation"));
      await assertRetained(mode + " pending through " + destination);
    }
    fixture.resume();
    await page.evaluate(() => window.statusRefresh);
    await assertRetained(mode + " response");
    const snapshots = await page.evaluate(() => window.fixture.snapshots());
    assert.equal(!!snapshots.context.error, mode !== "normal");
    assert.equal(!!snapshots.usage.error, mode !== "normal");
  }
  await page.evaluate(() => window.metricObserver.disconnect());

  fixture.mode("lower");
  await page.locator(".context-occupancy-trigger").click();
  await page.evaluate(() => window.fixture.refresh());
  assert.match(await page.locator(".context-occupancy-trigger").textContent(), /~13%/u);
  assert.match(await page.locator(".model-usage-trigger").textContent(), /25%/u);
  assert.match(await page.locator(".model-cost-trigger").textContent(), /0\.001/u);
  assert.equal(await page.locator(".context-occupancy-popover").evaluate(node => node.matches(":popover-open")), true,
    "updating the current model and count does not reset the open details");
  await page.keyboard.press("Escape");
  fixture.mode("unknown"); await page.evaluate(() => window.fixture.refresh());
  assert.equal(await page.locator(".context-occupancy-trigger").count(), 0, "a valid newer unknown estimate replaces the old reading");

  for (const mode of ["revoked", "forbidden"]) {
    fixture.mode("normal"); await page.evaluate(() => window.fixture.refresh()); await waitForMetrics(page);
    fixture.mode(mode); await page.evaluate(() => window.fixture.refresh());
    assert.equal(await page.locator(".session-status-dock button").count(), 0, "an explicitly revoked adapter cannot retain the last reading");
  }
  fixture.mode("normal"); await page.evaluate(() => window.fixture.refresh()); await waitForMetrics(page);

  for (const boundary of ["session", "instance", "offline", "business"]) {
    fixture.pause();
    const requested = page.waitForRequest(request => request.url().endsWith("/controls/context-occupancy"));
    await page.evaluate(() => { window.statusRefresh = window.fixture.refresh(); }); await requested;
    await page.evaluate(name => {
      if (name === "session") window.fixture.select("b");
      if (name === "instance") window.fixture.connection({ instanceId: "status-host-next" });
      if (name === "offline") window.fixture.connection({ online: false });
      if (name === "business") window.fixture.connection({ businessAvailable: false });
    }, boundary);
    await settle(page);
    const pending = await page.evaluate(() => window.fixture.snapshots());
    assert.equal(pending.context.view, null, boundary + " clears the old estimate immediately");
    assert.equal(pending.usage.view, null, boundary + " clears the old cost immediately");
    fixture.resume(); await page.evaluate(() => window.statusRefresh);
    if (boundary === "offline" || boundary === "business") {
      const finished = await page.evaluate(() => window.fixture.snapshots());
      assert.equal(finished.context.view, null, "a late response cannot refill an unavailable connection");
      assert.equal(finished.usage.view, null);
      await page.evaluate(() => window.fixture.connection({ online: true, businessAvailable: true }));
    }
    await waitForMetrics(page);
    const restored = await page.evaluate(() => window.fixture.snapshots());
    assert.equal(restored.context.view.sessionId, "b"); assert.equal(restored.usage.view.sessionId, "b");
  }
  await page.evaluate(() => window.fixture.removeOwner());
  assert.equal(await page.locator(".session-status-dock").count(), 0, "owner removal retracts the entire statistics contribution");
  assert.deepEqual(errors, []);
}

const bundle = await compileFixture();
if (process.argv.includes("--build-only")) {
  console.log("Session status Browser fixture bundled successfully; no browser interactions were run.");
} else {
  test("session statistics remain stable through navigation and transient HTTP failure", { timeout: 120_000 }, async t => {
    let browser, fixture;
    try {
      browser = await chromium.launch({ headless: true }); fixture = await serveFixture(bundle);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await t.test("statistics navigation at " + viewport.width + "px", async () => {
          const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10_000);
          try { await checkNavigation(page, fixture); }
          finally { fixture.resume(); await page.close(); }
        });
      }
    } finally { await browser?.close(); await fixture?.close(); }
  });
}
