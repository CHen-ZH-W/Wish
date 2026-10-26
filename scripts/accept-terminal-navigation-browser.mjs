import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));
const entry = String.raw`
import React, { Activity, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { UserTerminalClientUi } from "./src/terminal/consumers/webui/index.tsx";
window.audit = { opens: 0, disposals: 0, sentInputs: 0 };
const originalOpen = Terminal.prototype.open, originalDispose = Terminal.prototype.dispose;
Terminal.prototype.open = function(...args) { window.audit.opens++; window.fixtureTerminal = this; return originalOpen.apply(this, args); };
Terminal.prototype.dispose = function(...args) { window.audit.disposals++; return originalDispose.apply(this, args); };
const cleanup = [], seats = [];
const connection = {
  async request(path, body) {
    if (body?.action === "write") window.audit.sentInputs++;
    const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("terminal_fixture_http_" + response.status);
    return response.json();
  },
  stream(path) { return new EventSource(path); },
};
UserTerminalClientUi.apply({ wishConnection: connection, wishUiSlots: { sessionSidebar(seat) { seats.push(seat); return () => {}; } },
  effect(action) { const remove = action(); if (typeof remove === "function") cleanup.push(remove); } });
const View = seats[0].View;
const tab = { id: "terminal-tab", kind: "terminal", contentId: "terminal-fixture", title: "bash", visible: true, params: { terminalId: "terminal-1" } };
const actions = { update() {}, close() {}, openTab() {}, openResource() {} };
function App() {
  const [visible, setVisible] = useState(true), [installed, setInstalled] = useState(true);
  return <><nav><button onClick={() => setVisible(true)}>主会话</button><button onClick={() => setVisible(false)}>设置</button><button onClick={() => setInstalled(false)}>移除界面模块</button></nav>
    <Activity mode={visible ? "visible" : "hidden"}>{installed ? <div className="fixture-terminal"><View sessionId="session-1" tab={tab} actions={actions} /></div> : null}</Activity>
    {!visible ? <h1>设置页面</h1> : null}</>;
}
const root = createRoot(document.getElementById("root")); root.render(<App />);
window.addEventListener("pagehide", () => { root.unmount(); for (const remove of cleanup.reverse()) remove(); }, { once: true });
`;
const bundle = (await build({ stdin: { contents: entry, loader: "tsx", resolveDir: repository, sourcefile: "terminal-navigation-fixture.tsx" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" })).outputFiles[0].contents;

async function fixtureServer() {
  const css = await readFile(new URL("../src/apps/webui/public/app.css", import.meta.url));
  const xtermCss = await readFile(new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url));
  const streams = new Set();
  let rosterGate, releaseRoster, streamCount = 0, writes = 0;
  const terminal = { id: "terminal-1", label: "bash", createdAt: "2026-10-22T00:00:00Z", active: true,
    authority: "host-user", shell: "bash", columns: 80, rows: 24 };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"><style>body{height:100vh}nav{display:flex;gap:12px;padding:10px}.fixture-terminal{width:95vw;height:360px}.user-terminal-view,.user-terminal-console,.user-terminal-screen{height:100%}</style><div id="root"></div><script type="module" src="/fixture.js"></script>'); return;
    }
    if (path === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return; }
    if (path === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(Buffer.concat([css, xtermCss])); return; }
    if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (path.endsWith("/streams/user-terminal")) {
      streamCount++; streams.add(response);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      response.write('event: terminal.snapshot\ndata: ' + JSON.stringify({ type: "snapshot", sequence: 0, terminal, writable: true,
        screen: "\u001b[32mRETAINED_TERMINAL_OUTPUT\u001b[0m\r\nuser@wish$ " }) + '\n\n');
      request.on("close", () => streams.delete(response)); return;
    }
    if (path.endsWith("/controls/user-terminal")) {
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST") {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()); if (body.action === "write") writes++;
        response.end(JSON.stringify({ value: { accepted: true } })); return;
      }
      if (rosterGate) await rosterGate;
      response.end(JSON.stringify({ value: { schemaVersion: 2, sessionId: "session-1", authority: "host-user", terminals: [terminal] } })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port,
    pause() { rosterGate = new Promise(resolve => { releaseRoster = resolve; }); },
    resume() { releaseRoster?.(); rosterGate = undefined; releaseRoster = undefined; },
    get streams() { return streams.size; }, get streamCount() { return streamCount; }, get writes() { return writes; },
    close: () => new Promise((resolve, reject) => { releaseRoster?.(); for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

if (process.argv.includes("--build-only")) console.log("Terminal navigation fixture bundled; no browser interactions were run.");
else test("real terminal view retains xterm through navigation while its attachment pauses", { timeout: 60_000 }, async t => {
  const fixture = await fixtureServer(); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) await t.test(width + "px", async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(8_000);
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(fixture.url);
        await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("RETAINED_TERMINAL_OUTPUT"));
        await page.evaluate(() => { window.originalXterm = document.querySelector(".xterm"); window.originalRows = document.querySelector(".xterm-rows"); });
        assert.deepEqual(await page.evaluate(() => [window.audit.opens, window.audit.disposals]), [1, 0]);
        const streamsBefore = fixture.streamCount;
        fixture.pause();
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page.getByRole("heading", { name: "设置页面", exact: true }).waitFor();
        await page.waitForFunction(() => window.fixtureTerminal.options.disableStdin === true);
        assert.equal(await page.evaluate(() => window.originalXterm.isConnected), true);
        assert.equal(await page.evaluate(() => window.audit.disposals), 0, "Activity hides the retained renderer without disposing xterm");
        await page.getByRole("button", { name: "主会话", exact: true }).click();
        await page.locator(".user-terminal-screen:visible").waitFor();
        assert.equal(await page.locator(".xterm-rows").evaluate(node => node === window.originalRows && node.textContent.includes("RETAINED_TERMINAL_OUTPUT")), true,
          "the previous terminal screen remains visible while reconnection is deliberately blocked");
        assert.equal(await page.locator(".user-terminal-screen-loading").count(), 0);
        assert.equal(await page.evaluate(() => window.audit.opens), 1, "navigation must not reinitialize the emulator");
        const writesBefore = await page.evaluate(() => window.audit.sentInputs);
        await page.evaluate(async () => { window.fixtureTerminal.input("stale", true); await new Promise(resolve => setTimeout(resolve, 0)); });
        assert.equal(await page.evaluate(() => window.audit.sentInputs), writesBefore, "a paused attachment must never inherit input authority");
        fixture.resume();
        await page.waitForFunction(() => window.fixtureTerminal.options.disableStdin === false);
        assert.ok(fixture.streamCount > streamsBefore, "returning obtains a fresh attachment instead of replaying the old identity");
        assert.equal(await page.evaluate(() => document.querySelector(".xterm") === window.originalXterm), true);
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page.getByRole("button", { name: "移除界面模块", exact: true }).click();
        await page.waitForFunction(() => window.audit.disposals === 1);
        assert.equal(await page.evaluate(() => window.originalXterm.isConnected), false, "removing an already-hidden owner still releases xterm");
        assert.deepEqual(errors, []);
      } finally { fixture.resume(); await page.close(); }
    });
  } finally { await browser?.close(); await fixture.close(); }
});
