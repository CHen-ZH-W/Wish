import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));
const entry = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { SnapshotStore } from "./src/apps/webui/client/model/store.ts";
import { UiSlots } from "./src/apps/webui/client/slots.ts";
import { Shell } from "./src/apps/webui/client/ui/shell.tsx";
import { IsolatedView } from "./src/apps/webui/client/ui/isolated-view.tsx";
import { useSnapshot } from "./src/apps/webui/client/ui/primitives.tsx";
import { DocumentPreviewClientUi } from "./src/document-preview/consumers/webui/index.tsx";

const urls = { created: [], revoked: [] };
const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = createUrl(blob); urls.created.push(url); return url; };
URL.revokeObjectURL = url => { urls.revoked.push(url); revokeUrl(url); };
const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "preview-host", error: null });
connection.request = async (path, body) => {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("fixture file read failed");
  return response.json();
};
const slots = new UiSlots(), selection = new SnapshotStore({ sessionId: "a", path: "note.txt" });
let removers = [];
function installOwner() {
  DocumentPreviewClientUi.apply({ wishConnection: connection, wishUiSlots: slots,
    effect(action) { const remove = action(); if (typeof remove === "function") removers.push(remove); } });
}
function Preview() {
  const state = useSnapshot(selection), contributions = useSnapshot(slots);
  const item = contributions.sessionSidebarItems.find(item => item.id === "document-preview");
  return item ? <IsolatedView View={item.View} sessionId={state.sessionId}
    tab={{ id: "preview-tab", kind: "document", contentId: "preview", title: state.path, params: { path: state.path }, visible: true }}
    actions={{ openTab() {}, openResource() {}, update() {}, close() {} }} /> : <p>预览模块已移除</p>;
}
installOwner();
slots.panel({ id: "preview", label: "文档预览", area: "workspace", preserveState: true, View: Preview });
slots.panel({ id: "preferences", label: "设置", area: "settings", View: () => <h1>预览验收设置</h1> });
slots.openPanel("preview");
const root = createRoot(document.getElementById("root"));
root.render(<Shell slots={slots} connection={connection} />);
window.fixture = { urls,
  select(sessionId, path) { selection.publish({ sessionId, path }); },
  removeOwner() { for (const remove of removers.splice(0)) remove(); },
  restoreOwner() { installOwner(); },
};
window.addEventListener("pagehide", () => { root.unmount(); for (const remove of removers.splice(0)) remove(); }, { once: true });
`;

async function compileFixture() {
  const result = await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "document-preview-navigation.tsx", loader: "tsx" },
    absWorkingDir: repository, write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  return result.outputFiles[0].contents;
}

async function fixtureServer(bundle) {
  const css = await readFile(new URL("../src/apps/webui/public/app.css", import.meta.url));
  const reads = new Map(), gates = new Map(), versions = new Map(), failures = new Set();
  const key = (sessionId, path) => sessionId + ":" + path;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>'); return; }
    if (path === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return; }
    if (path === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return; }
    if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const match = /^\/api\/sessions\/([ab])\/queries\/workspace-files$/u.exec(path);
    if (!match) { response.writeHead(404); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const query = JSON.parse(Buffer.concat(chunks).toString("utf8")), sessionId = match[1], identity = key(sessionId, query.path);
    reads.set(identity, (reads.get(identity) ?? 0) + 1);
    const version = versions.get(identity) ?? 1;
    if (gates.has(identity)) await gates.get(identity).promise;
    response.setHeader("Content-Type", "application/json");
    if (failures.delete(identity)) { response.writeHead(500); response.end(JSON.stringify({ error: "fixture read failure" })); return; }
    const base = { schemaVersion: 1, path: query.path, size: 100, modifiedAt: "2026-10-22T00:00:00Z", truncated: false };
    if (query.operation === "read") {
      const content = query.path.endsWith(".md") ? "# Local Markdown\n\n![Local image](picture.png)" : identity + " revision " + version + "\n" + "内容用于验证返回文档后的阅读状态。\n".repeat(20);
      response.end(JSON.stringify({ value: { ...base, content } })); return;
    }
    const contentBase64 = query.path.endsWith(".pdf") ? Buffer.from("%PDF-1.4\n% document preview fixture\n%%EOF").toString("base64")
      : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    response.end(JSON.stringify({ value: { ...base, contentBase64 } }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port,
    count(sessionId, path) { return reads.get(key(sessionId, path)) ?? 0; },
    hold(sessionId, path) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key(sessionId, path), { promise, release }); },
    release(sessionId, path) { gates.get(key(sessionId, path))?.release(); gates.delete(key(sessionId, path)); },
    version(sessionId, path, version) { versions.set(key(sessionId, path), version); },
    fail(sessionId, path) { failures.add(key(sessionId, path)); },
    reset() { for (const gate of gates.values()) gate.release(); gates.clear(); reads.clear(); versions.clear(); failures.clear(); },
    close() { for (const gate of gates.values()) gate.release(); server.closeAllConnections(); return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function settings(page) { await page.getByRole("button", { name: "设置与插件", exact: true }).click(); await page.getByRole("heading", { name: "预览验收设置", exact: true }).waitFor(); }
async function preview(page) { await page.getByRole("navigation", { name: "主要导航", exact: true }).getByRole("button", { name: "会话", exact: true }).click(); await page.locator(".document-preview:visible").waitFor(); await settle(page); }
async function select(page, sessionId, path) { await page.evaluate(({ sessionId, path }) => window.fixture.select(sessionId, path), { sessionId, path }); }
async function waitForReads(page, fixture, sessionId, path, count) {
  for (let attempt = 0; attempt < 100 && fixture.count(sessionId, path) < count; attempt++) await page.waitForTimeout(10);
  assert.equal(fixture.count(sessionId, path), count, "the expected file read starts");
}
async function usableUrl(page, url) { return page.evaluate(async url => { try { return (await fetch(url)).ok; } catch { return false; } }, url); }

async function checkPreview(page, fixture) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.url);
  const body = page.locator(".document-plain"), loading = page.locator(".document-preview-loading");
  await body.filter({ hasText: "a:note.txt revision 1" }).waitFor();
  const first = await body.elementHandle();
  await settings(page); await preview(page);
  assert.equal(await first.evaluate(node => node.isConnected && node === document.querySelector(".document-plain")), true, "returning keeps the loaded text node");
  assert.equal(fixture.count("a", "note.txt"), 1, "returning to a loaded document does not read it again");
  assert.equal(await loading.count(), 0);
  fixture.version("a", "note.txt", 2);
  await page.getByRole("button", { name: "重新加载文件", exact: true }).click();
  await body.filter({ hasText: "a:note.txt revision 2" }).waitFor();
  assert.equal(fixture.count("a", "note.txt"), 2, "explicit reload obtains a fresh document");

  fixture.hold("a", "pending.txt");
  await select(page, "a", "pending.txt");
  await waitForReads(page, fixture, "a", "pending.txt", 1);
  await loading.waitFor();
  await settings(page); await preview(page);
  assert.equal(fixture.count("a", "pending.txt"), 1, "an in-flight read is reused after Activity resumes");
  fixture.release("a", "pending.txt");
  await body.filter({ hasText: "a:pending.txt revision 1" }).waitFor();

  fixture.hold("a", "late.txt");
  await select(page, "a", "late.txt");
  await waitForReads(page, fixture, "a", "late.txt", 1);
  await select(page, "a", "other.txt");
  await body.filter({ hasText: "a:other.txt revision 1" }).waitFor();
  const lateResponse = page.waitForResponse(response => response.request().postDataJSON()?.path === "late.txt");
  fixture.release("a", "late.txt");
  await (await lateResponse).finished(); await settle(page);
  assert.match(await body.textContent(), /a:other\.txt/u, "an older path response cannot replace the selected file");

  fixture.hold("b", "other.txt");
  await select(page, "b", "other.txt");
  await loading.waitFor();
  assert.equal(await body.count(), 0, "a new Session cannot paint another Session's loaded file");
  fixture.release("b", "other.txt");
  await body.filter({ hasText: "b:other.txt revision 1" }).waitFor();
  fixture.fail("b", "failed.txt");
  await select(page, "b", "failed.txt");
  await page.getByRole("alert").filter({ hasText: "fixture file read failed" }).waitFor();
  await settings(page); await preview(page);
  assert.equal(fixture.count("b", "failed.txt"), 1, "navigation preserves a failed result until an explicit retry");
  await page.getByRole("button", { name: "重新加载文件", exact: true }).click();
  await body.filter({ hasText: "b:failed.txt revision 1" }).waitFor();
  assert.equal(fixture.count("b", "failed.txt"), 2, "a failed read can recover through explicit reload");

  await select(page, "a", "picture.png");
  const image = page.locator(".document-image-viewport img");
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector(".document-image-viewport img")?.naturalWidth > 0);
  const originalImageUrl = await image.getAttribute("src");
  await page.getByRole("button", { name: "重新加载文件", exact: true }).click();
  await page.waitForFunction(previous => { const node = document.querySelector(".document-image-viewport img"); return node?.src.startsWith("blob:") && node.src !== previous && node.naturalWidth > 0; }, originalImageUrl);
  assert.equal(fixture.count("a", "picture.png"), 2, "explicit media reload re-reads the bytes");
  assert.equal(await usableUrl(page, originalImageUrl), false, "explicit reload releases the old media URL");
  await select(page, "a", "note.txt");
  await body.filter({ hasText: "a:note.txt revision 2" }).waitFor();

  for (const path of ["picture.png", "manual.pdf", "article.md"]) {
    const initialReads = fixture.count("a", path), initialImages = fixture.count("a", "picture.png");
    await select(page, "a", path);
    const target = path.endsWith(".pdf") ? page.locator(".document-pdf") : path.endsWith(".md") ? page.locator(".document-markdown img") : page.locator(".document-image-viewport img");
    await target.waitFor();
    await page.waitForFunction(() => { const node = document.querySelector(".document-pdf,.document-preview img"); return node && (node.tagName === "OBJECT" ? node.data.startsWith("blob:") : node.src.startsWith("blob:") && node.complete && node.naturalWidth > 0); });
    const node = await target.elementHandle(), url = await target.getAttribute(path.endsWith(".pdf") ? "data" : "src");
    assert.equal(await usableUrl(page, url), true);
    await settings(page); await preview(page);
    assert.equal(await node.evaluate(node => node.isConnected), true, "the media DOM survives navigation");
    assert.equal(await target.getAttribute(path.endsWith(".pdf") ? "data" : "src"), url, "Activity reuses the still-valid Blob URL");
    assert.equal(await usableUrl(page, url), true, "hidden effects did not revoke the displayed Blob URL");
    assert.equal(fixture.count("a", path), initialReads + 1);
    if (path.endsWith(".md")) assert.equal(fixture.count("a", "picture.png"), initialImages + 1, "Markdown images reuse their loaded bytes after Activity resumes");
    await settings(page);
    await page.evaluate(() => window.fixture.removeOwner());
    await page.waitForFunction(url => window.fixture.urls.revoked.includes(url), url);
    assert.equal(await node.evaluate(node => node.isConnected), false, "hidden owner removal releases the retained media DOM");
    assert.equal(await usableUrl(page, url), false, "actual owner removal revokes its Blob URL");
    await page.evaluate(() => window.fixture.restoreOwner());
    await preview(page);
  }

  fixture.hold("a", "retired.png");
  await select(page, "a", "retired.png");
  await waitForReads(page, fixture, "a", "retired.png", 1);
  await settings(page);
  await page.evaluate(() => window.fixture.removeOwner());
  const created = await page.evaluate(() => window.fixture.urls.created.length);
  const retiredResponse = page.waitForResponse(response => response.request().postDataJSON()?.path === "retired.png");
  fixture.release("a", "retired.png");
  await (await retiredResponse).finished(); await settle(page);
  assert.equal(await page.evaluate(() => window.fixture.urls.created.length), created, "a late result from a removed owner allocates no Blob URL");
  await page.waitForFunction(() => window.fixture.urls.created.every(url => window.fixture.urls.revoked.includes(url)));
  assert.equal(await page.locator(".document-preview").count(), 0);
  assert.deepEqual(errors, [], "the document lifecycle produces no browser exceptions");
}

const bundle = await compileFixture();
if (process.argv.includes("--build-only")) {
  console.log("Document preview Browser fixture bundled; no browser interactions were run.");
} else {
  test("document preview retains reads and Blob resources across navigation and releases removed owners", { timeout: 90_000 }, async t => {
    let fixture, browser;
    try {
      browser = await chromium.launch({ headless: true });
      fixture = await fixtureServer(bundle);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await t.test("document lifecycle at " + viewport.width + "px", async () => {
          fixture.reset();
          const page = await browser.newPage({ viewport });
          page.setDefaultTimeout(8_000);
          try { await checkPreview(page, fixture); }
          finally { fixture.reset(); await page.close(); }
        });
      }
    } finally { await browser?.close(); await fixture?.close(); }
  });
}
