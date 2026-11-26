import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

// Use the production Host, module loader, models and React tree. Each held read
// makes a loading phase observable without relying on machine-specific latency.
for (const width of [1440, 390]) test(`all WebUI surfaces settle coherently at ${width}px`, { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-page-loading-"));
  let booted, browser;
  const holds = new Set(), errors = [];
  try {
    await writeFile(join(directory, "loading.txt"), "A complete document after its read settles.\n");
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const manager = booted.surfaceContext.get("sessions").manager;
    const agentId = booted.surfaceContext.get("agents").agentId, sessionId = randomUUID(), archivedId = randomUUID();
    await manager.create({ sessionId, agentId, scope: directory, title: "加载验收会话" });
    await manager.create({ sessionId: archivedId, agentId, scope: directory, title: "加载验收归档" });
    await manager.archive({ sessionId: archivedId });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => errors.push(error.message));
    let historyReads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === `/api/sessions/${sessionId}/history`) historyReads++; });
    const hold = match => {
      const entered = deferred(), released = deferred();
      const item = { match, entered: entered.promise, release() { holds.delete(item); released.resolve(); }, wait: released.promise, mark: entered.resolve };
      holds.add(item); return item;
    };
    await page.route("**/*", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const item = [...holds].find(value => value.match(path, request));
      if (item) { item.mark(); await item.wait; }
      await route.continue();
    });
    const capture = async name => {
      if (!process.env.WISH_WEBUI_CAPTURE_DIR) return;
      await mkdir(process.env.WISH_WEBUI_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.WISH_WEBUI_CAPTURE_DIR, `loading-${width}-${name}.png`) });
    };
    const pending = scope => scope.locator('.view-loading-status:visible').first().waitFor();
    const assertNoOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const settings = () => page.getByRole("button", { name: "设置与插件", exact: true });
    const openSidebar = async () => {
      const expand = page.getByRole("button", { name: "展开侧栏", exact: true });
      if (await expand.isVisible()) await expand.click();
    };
    const script = hold(path => /\/modules\/SkillsClientUi-[^/]+\.js$/u.test(path));
    const permission = hold(path => path === "/api/controls/permission-profile/default");
    const library = hold(path => path === "/api/controls/skills/default");
    const credentials = hold(path => path === "/api/management/credentials/describe");
    await page.goto(booted.context.get("webManagementHost").url);
    await script.entered; await permission.entered;
    assert.equal(await page.locator(".wish-boot").isVisible(), true);
    assert.equal(await page.locator(".wish-shell").count(), 0, "the application waits for the complete module roster");
    await capture("boot"); script.release();
    await pending(page.locator(".workspace-content"));
    assert.equal(await page.getByRole("heading", { name: "许个愿吧", exact: true }).isVisible(), false, "the first page waits for its composer dependencies");
    permission.release();
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    await capture("new-session");

    await library.entered;
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await pending(page.locator(".workspace-content"));
    assert.equal(await page.locator(".workspace-content").getByRole("heading", { name: "Skills", exact: true }).isVisible(), false);
    library.release(); await page.locator(".workspace-content").getByRole("heading", { name: "Skills", exact: true }).waitFor();
    await capture("skills"); await assertNoOverflow();

    await settings().click(); await openSidebar();
    await page.getByRole("heading", { name: "通用设置", exact: true }).waitFor();
    await credentials.entered;
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await pending(page.locator(".workspace-content"));
    assert.equal(await page.getByRole("heading", { name: "模型配置", exact: true }).isVisible(), false);
    credentials.release(); await page.getByRole("heading", { name: "模型配置", exact: true }).waitFor();
    await capture("models"); await assertNoOverflow();
    await openSidebar(); await page.getByRole("button", { name: "插件管理", exact: true }).click();
    await page.getByRole("heading", { name: "插件管理", exact: true }).waitFor();
    await assertNoOverflow();

    const history = hold(path => path === `/api/sessions/${sessionId}/history`);
    const features = hold(path => path === `/api/sessions/${sessionId}/features`);
    const prompts = hold(path => path === `/api/sessions/${sessionId}/controls/system-prompt-history`);
    await page.getByRole("button", { name: "会话", exact: true }).first().click(); await openSidebar();
    await page.getByRole("button", { name: "加载验收会话", exact: true }).click();
    await history.entered; await features.entered; await prompts.entered;
    await pending(page.locator(".workspace-content")); history.release();
    assert.equal(await page.locator("#wish-composer").isVisible(), false, "history alone cannot reveal a partial conversation");
    features.release();
    assert.equal(await page.locator("#wish-composer").isVisible(), false, "late prompt data shares the conversation's loading phase");
    prompts.release(); await page.locator("#wish-composer").waitFor();
    await page.locator("#wish-composer").fill("往返页面后保留这份草稿");
    await capture("conversation"); await assertNoOverflow();
    await page.getByRole("button", { name: "工具调用", exact: true }).click();
    await page.getByRole("heading", { name: "这个会话还没有工具调用", exact: true }).waitFor();
    await page.getByRole("button", { name: "会话", exact: true }).last().click();
    await page.locator("#wish-composer").waitFor();
    assert.equal(await page.locator("#wish-composer").inputValue(), "往返页面后保留这份草稿");

    await page.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
    const sidebar = page.locator("#session-sidebar");
    const list = hold((path, request) => path === `/api/sessions/${sessionId}/queries/workspace-files` && request.postDataJSON()?.operation === "list");
    await sidebar.getByRole("button", { name: "打开 文件", exact: true }).click(); await list.entered;
    await pending(sidebar); list.release(); await sidebar.getByRole("button", { name: "loading.txt", exact: true }).waitFor();
    const document = hold((path, request) => path === `/api/sessions/${sessionId}/queries/workspace-files` && request.postDataJSON()?.operation === "read");
    await sidebar.getByRole("button", { name: "loading.txt", exact: true }).click(); await document.entered;
    await pending(sidebar); document.release();
    await sidebar.getByText("A complete document after its read settles.", { exact: true }).waitFor();
    await capture("document");
    await sidebar.getByRole("button", { name: "收起会话侧栏", exact: true }).click();
    const activeComposer = await page.locator("#wish-composer").elementHandle(), beforeArchiveReads = historyReads;
    await page.getByRole("button", { name: "归档", exact: true }).click(); await openSidebar();
    await page.getByRole("button", { name: "加载验收归档", exact: true }).click();
    await page.getByRole("heading", { name: "加载验收归档", exact: true }).waitFor();
    assert.equal(await activeComposer.evaluate(node => node.isConnected), true);
    await page.locator(".utility-rail").getByRole("button", { name: "会话", exact: true }).click();
    await page.getByRole("heading", { name: "加载验收会话", exact: true }).waitFor();
    assert.equal(await page.locator("#wish-composer").inputValue(), "往返页面后保留这份草稿");
    assert.equal(await page.locator(".workspace-content .view-loading-status:visible").count(), 0);
    assert.equal(historyReads, beforeArchiveReads, "the actual Host transcript is reused after Archive navigation");
    await assertNoOverflow(); assert.deepEqual(errors, []);
  } finally {
    for (const hold of holds) hold.release();
    await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test("failed initial modules and reads release startup and recover without losing management navigation", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loading-recovery-"));
  let booted, browser;
  try {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(12_000);
    const broken = /\/assets\/modules\/SkillsClientUi-[^/]+\.js$/u;
    await page.route(broken, route => route.abort("failed"));
    await page.route("**/api/controls/permission-profile/default", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "fixture_temporarily_unavailable" } }) }));
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    await page.getByRole("button", { name: "重新检查", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Skills", exact: true }).count(), 0);
    assert.equal(await page.locator("#wish-new-session-permission-profile").isDisabled(), true);
    assert.equal(await page.locator(".workspace-content .view-loading-status:visible").count(), 0, "failed data ends the initial wait");
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("heading", { name: "通用设置", exact: true }).waitFor();
    await page.getByRole("button", { name: "插件管理", exact: true }).click();
    await page.getByRole("heading", { name: "插件管理", exact: true }).waitFor();
    await page.unroute(broken);
    await page.getByRole("button", { name: "重新检查", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).waitFor();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.locator(".workspace-content").getByRole("heading", { name: "Skills", exact: true }).waitFor();
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
