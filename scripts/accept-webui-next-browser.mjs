import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

async function capture(page, name, resetScroll = true) {
  if (!process.env.WISH_WEBUI_CAPTURE_DIR) return;
  const directory = process.env.WISH_WEBUI_CAPTURE_DIR;
  await mkdir(directory, { recursive: true });
  if (resetScroll) await page.evaluate(() => { window.scrollTo(0, 0); for (const node of document.querySelectorAll(".workspace-main,.workspace-content,.ledger-scroll")) node.scrollTop = 0; });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
  const metrics = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth,
    elements: [...document.querySelectorAll(".wish-shell,.session-index,.ledger-header,.ledger-scroll,.composer,.message-text,.settings-page,.notice,button.primary,textarea")].filter(node => node.getBoundingClientRect().height > 0).map(node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return { selector: node.className || node.tagName, x: box.x, y: box.y, width: box.width, height: box.height, font: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, color: style.color, background: style.backgroundColor, padding: style.padding, focusOutline: style.outlineStyle };
    }) }));
  assert.equal(metrics.overflow, false, `${name}: horizontal viewport overflow`);
  await writeFile(join(directory, `${name}.json`), JSON.stringify(metrics, null, 2));
}

async function createDefaultSession(page, booted, directory) {
  // Other browser scenarios need a settled Session, not an unconfigured model Run.
  await booted.surfaceContext.get("sessions").manager.create({ sessionId: randomUUID(), agentId: booted.surfaceContext.get("agents").agentId, scope: directory });
  await page.reload();
  await page.locator("#wish-composer").waitFor();
}

function modelConfiguration(port) {
  return { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
    providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, auth: { type: "none" }, developerRoleMode: "native", models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
}

test("new Session chooses a Host Workspace before creation and stays outside the execution ledger", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "a-wish-workspace-choice-browser-"));
  let booted, browser;
  try {
    const other = join(directory, "other-project");
    await mkdir(other);
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const manager = booted.surfaceContext.get("sessions").manager;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    assert.equal(await page.locator(".empty-state").count(), 0, "an empty workspace lands directly on the centered composer");
    assert.equal((await manager.list()).length, 0, "opening the center composer creates no Host Session");
    assert.equal(await page.locator("#new-session-message").count(), 0, "the message field waits for an explicit workspace choice");
    assert.equal(await page.locator(".new-session-workspace-call").isVisible(), true, "the center card requests a workspace");
    const reasoning = page.getByRole("combobox", { name: "首个运行的思考强度" });
    await reasoning.waitFor();
    await page.waitForFunction(() => !document.querySelector("#wish-new-session-reasoning-effort")?.disabled);
    assert.equal(await reasoning.inputValue(), "high");
    assert.equal(await reasoning.locator('option[value="default"]').count(), 0);
    const card = await page.locator(".new-session-composer").boundingBox(), effortBox = await reasoning.boundingBox(), sendBox = await page.locator(".new-session-send").boundingBox();
    assert.ok(card && effortBox && sendBox && effortBox.x >= card.x && effortBox.y >= card.y &&
      sendBox.x + sendBox.width <= card.x + card.width && sendBox.y + sendBox.height <= card.y + card.height,
    "reasoning and send belong to the same centered composer card");
    await reasoning.selectOption("low");
    assert.equal((await manager.list()).length, 0, "changing first-run effort does not create a Session");
    const center = await page.locator(".new-session-center").boundingBox(), main = await page.locator(".workspace-content").boundingBox();
    assert.ok(center && main && Math.abs(center.x + center.width / 2 - (main.x + main.width / 2)) < 2, "composer is centered in the content area");
    assert.equal(await page.locator("#wish-composer").count(), 0, "the create view is not an execution ledger");
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    assert.equal((await manager.list()).length, 0, "leaving the center composer creates no Host Session");
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    assert.equal(await page.locator(".new-session-workspace-list").count(), 0, "no configured root is offered as a default choice");
    await page.locator(".new-session-workspace-call").click();
    const chooser = page.getByRole("dialog", { name: "选择工作区目录" });
    await chooser.waitFor();
    assert.equal(await chooser.locator(".directory-breadcrumbs button").last().textContent(), basename(homedir()), "browse starts from Host home, not a selected workspace");
    assert.equal(await chooser.getByRole("textbox").count(), 0, "folder picking does not require manually typing a Host path");
    assert.equal((await manager.list()).length, 0, "browsing Host folders creates no Session");
    await chooser.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await manager.list()).length, 0, "cancelling folder picking creates no Session");
    await page.locator(".new-session-workspace-call").click();
    await chooser.locator(".directory-breadcrumbs button").first().click();
    await chooser.locator(".directory-column").first().getByRole("button", { name: "tmp", exact: true }).click();
    await chooser.locator(".directory-column").nth(1).getByRole("button", { name: basename(directory), exact: true }).click();
    await chooser.locator(".directory-column").nth(1).getByRole("button", { name: "other-project", exact: true }).click();
    await chooser.getByRole("button", { name: "选择此目录", exact: true }).click();
    assert.equal(await page.locator(".new-session-workspace-trigger").getAttribute("title"), other);
    await page.waitForFunction(() => document.activeElement?.id === "new-session-message");
    await page.locator("#new-session-message").fill("开始执行检查");
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    assert.equal((await send.textContent())?.trim(), "", "send stays icon-only");
    await send.click();
    await page.locator("#wish-composer").waitFor();
    assert.equal((await manager.list())[0].scope, other);
    const createdId = (await manager.list())[0].sessionId;
    const firstSelection = await page.evaluate(async id => (await (await fetch(`/api/sessions/${encodeURIComponent(id)}/model-reasoning`)).json()).selection, createdId);
    assert.equal(firstSelection.selected, "low", "the first Run and later Runs share the Session's selected effort");
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "可用视图" }).getByRole("button", { name: "新建会话" }).count(), 0);
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.locator("#wish-composer").waitFor();
    assert.equal((await manager.list()).length, 1, "leaving a new intent keeps only the original Session");
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("compact Session menu renames inline, separates archives and confirms deletion", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-compact-sessions-browser-"));
  let booted, browser;
  try {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`); });
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("navigation", { name: "主要导航", exact: true }).getByRole("button", { name: "归档", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "主要导航", exact: true }).getByRole("button", { name: "归档", exact: true }).count(), 1);
    assert.equal(await page.locator(".session-index").getByRole("button", { name: "归档", exact: true }).count(), 0);
    await createDefaultSession(page, booted, directory);
    await page.locator("#wish-composer").fill("保留这份草稿");
    const navigation = page.getByRole("navigation", { name: "会话列表", exact: true });
    await navigation.locator(".session-link").dblclick();
    const name = page.getByRole("textbox", { name: "会话名称", exact: true });
    await name.fill("项目检查"); await name.press("Enter");
    await navigation.getByRole("button", { name: "项目检查", exact: true }).waitFor();
    assert.equal(await page.locator("#wish-composer").inputValue(), "保留这份草稿");
    await navigation.getByRole("button", { name: "项目检查", exact: true }).press("F2");
    await name.fill("不要保存"); await name.press("Escape");
    assert.equal(await navigation.getByRole("button", { name: "项目检查", exact: true }).count(), 1);
    const more = () => navigation.getByRole("button", { name: "更多操作：项目检查", exact: true });
    await more().evaluate(node => {
      document.getElementById(node.getAttribute("aria-controls")).showPopover();
      node.focus(); node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator("#wish-sidebar").isVisible(), true, "Escape before native toggle focus must not collapse the sidebar");
    assert.equal(await page.getByRole("menu").count(), 0);
    await more().click(); await page.getByRole("menuitem", { name: "归档会话", exact: true }).waitFor();
    await capture(page, "desktop-session-menu");
    await page.keyboard.press("Escape"); assert.equal(await more().evaluate(node => node === document.activeElement), true);
    await more().click();
    page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
    assert.equal(await navigation.locator(".session-link").count(), 1);
    await more().click(); await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
    await navigation.locator(".session-link").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "归档", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "归档", exact: true }).getAttribute("aria-current"), "page");
    assert.equal(await page.getByRole("button", { name: "执行工作区", exact: true }).getAttribute("aria-current"), null);
    const archives = page.getByRole("navigation", { name: "归档会话列表", exact: true });
    await archives.locator(".session-link").waitFor();
    await capture(page, "desktop-archives");
    await archives.locator(".session-link").click();
    await page.getByText("已归档，聊天记录只读。", { exact: true }).waitFor();
    assert.equal(await page.locator("#wish-composer").count(), 0);
    await page.getByRole("button", { name: "取消归档", exact: true }).click();
    await page.getByRole("heading", { name: "还没有归档会话", exact: true }).waitFor();
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.locator("#wish-composer").waitFor();
    assert.equal(await page.locator("#wish-composer").inputValue(), "保留这份草稿");
    await page.reload(); await more().waitFor();
    await more().click(); page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
    await navigation.locator(".session-link").waitFor({ state: "detached" });
    await page.reload(); await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    assert.equal((await booted.surfaceContext.get("sessions").manager.list()).length, 0);

    // Touch menu must remain open inside the navigation drawer; no double-click required.
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobile.on("pageerror", error => errors.push(error.message));
    await mobile.goto(booted.context.get("webManagementHost").url);
    await createDefaultSession(mobile, booted, directory);
    await mobile.getByRole("button", { name: "展开侧栏", exact: true }).tap();
    await mobile.getByRole("button", { name: "更多操作：新会话", exact: true }).tap();
    await mobile.getByRole("menuitem", { name: "归档会话", exact: true }).waitFor();
    const box = await mobile.getByRole("menu").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    await capture(mobile, "mobile-session-menu");
    await mobile.getByRole("menuitem", { name: /重命名/ }).tap();
    await mobile.getByRole("textbox", { name: "会话名称", exact: true }).fill("手机会话");
    await mobile.getByRole("textbox", { name: "会话名称", exact: true }).press("Enter");
    await mobile.getByRole("button", { name: "更多操作：手机会话", exact: true }).tap();
    await mobile.getByRole("menuitem", { name: "归档会话", exact: true }).tap();
    await mobile.getByRole("button", { name: "归档", exact: true }).tap();
    await mobile.locator(".archived-hint").waitFor();
    await mobile.getByRole("button", { name: "展开侧栏", exact: true }).tap();
    await mobile.getByRole("navigation", { name: "归档会话列表", exact: true }).locator(".session-link").waitFor();
    await capture(mobile, "mobile-archives");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("global Archive navigation and active/archived workspace grouping work on desktop and touch", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-workspace-groups-"));
  let booted, browser;
  try {
    const wish = join(directory, "wish"), docs = join(directory, "docs");
    await Promise.all([mkdir(wish), mkdir(docs)]);
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const manager = booted.surfaceContext.get("sessions").manager, agentId = booted.surfaceContext.get("agents").agentId;
    for (const [sessionId, scope, title, archived] of [["a", wish, "整理界面", false], ["b", docs, "检查文档", false], ["c", wish, "验证会话", false], ["old-a", wish, "旧版界面", true], ["old-b", docs, "发布记录", true]]) {
      await manager.create({ sessionId, agentId, scope, title });
      await manager.appendMessages({ sessionId, messages: [{ idempotencyKey: `${sessionId}/input`, runId: `${sessionId}-run`, userTurnId: `${sessionId}-turn`, stepId: `${sessionId}-step`, origin: "user_input", message: { role: "user", content: `${title}的独立历史记录` } }] });
      if (archived) await manager.archive({ sessionId });
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.get("webManagementHost").url);
    const active = page.getByRole("navigation", { name: "会话列表", exact: true });
    await active.getByRole("button", { name: "验证会话", exact: true }).waitFor();
    assert.deepEqual(await active.locator(".workspace-session-group").evaluateAll(nodes => nodes.map(node => ({ scope: node.dataset.workspace, count: node.querySelectorAll(".session-link").length }))), [{ scope: wish, count: 2 }, { scope: docs, count: 1 }]);
    const firstGroup = active.locator(".workspace-session-group").first();
    await firstGroup.locator("summary").press("Enter");
    assert.equal(await firstGroup.getAttribute("open"), null);
    await page.waitForResponse(response => response.url().endsWith("/api/sessions") && response.request().method() === "GET");
    assert.equal(await firstGroup.getAttribute("open"), null, "polling must not reset the collapsed group");
    await firstGroup.locator("summary").press("Enter");
    await active.getByRole("button", { name: "检查文档", exact: true }).click();
    await page.locator("#wish-composer").fill("普通会话草稿");
    assert.equal(await page.locator(".app-header").count(), 0);
    assert.equal(await page.locator(".sidebar-header").getByText("Wish", { exact: true }).isVisible(), true);
    await capture(page, "desktop-workspace-groups");
    const rail = page.getByRole("navigation", { name: "主要导航", exact: true });
    await rail.getByRole("button", { name: "归档", exact: true }).click();
    const archived = page.getByRole("navigation", { name: "归档会话列表", exact: true });
    await archived.getByRole("button", { name: /^旧版界面/ }).waitFor();
    assert.equal(await active.count(), 0, "archive owns the sidebar; the active list is unmounted");
    assert.equal(await page.locator(".panel-navigation").count(), 0, "active business navigation must not remain in Archive");
    await page.locator(".ledger-header h1").filter({ hasText: "旧版界面" }).waitFor();
    await page.locator(".message-text").filter({ hasText: "旧版界面的独立历史记录" }).waitFor();
    assert.equal(await page.locator(".message-text").filter({ hasText: "检查文档" }).count(), 0);
    assert.equal(await page.locator("#wish-composer").count(), 0);
    assert.deepEqual(await archived.locator(".workspace-session-group").evaluateAll(nodes => nodes.map(node => ({ scope: node.dataset.workspace, count: node.querySelectorAll(".session-link").length }))), [{ scope: wish, count: 1 }, { scope: docs, count: 1 }]);
    assert.equal(await page.locator(".panel-navigation").getByRole("button", { name: "归档", exact: true }).count(), 0);
    await capture(page, "desktop-archive-groups");
    await archived.getByRole("button", { name: "发布记录", exact: true }).click();
    await rail.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.locator(".ledger-header h1").filter({ hasText: "检查文档" }).waitFor();
    assert.equal(await page.locator("#wish-composer").inputValue(), "普通会话草稿");
    await rail.getByRole("button", { name: "归档", exact: true }).click();
    await page.locator(".ledger-header h1").filter({ hasText: "发布记录" }).waitFor();
    await archived.getByRole("button", { name: "更多操作：旧版界面", exact: true }).click();
    await page.getByRole("menuitem", { name: "取消归档", exact: true }).click();
    await archived.getByRole("button", { name: "旧版界面", exact: true }).waitFor({ state: "detached" });
    assert.equal(await archived.locator(".workspace-session-group").count(), 1);
    assert.equal((await manager.get({ sessionId: "old-a" })).scope, wish);
    await rail.getByRole("button", { name: "设置与插件", exact: true }).click();
    await rail.getByRole("button", { name: "归档", exact: true }).click();
    await archived.getByRole("button", { name: /^发布记录/ }).waitFor();

    // Collapse only the Session sidebar; the rail stays in the exact same place.
    const railBox = await rail.boundingBox(), mainBox = await page.locator(".workspace-main").boundingBox();
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.locator(".session-index").waitFor({ state: "hidden" });
    assert.deepEqual(await rail.boundingBox(), railBox);
    assert.equal((await page.locator(".workspace-main").boundingBox()).width, mainBox.width + 208);
    assert.equal((await page.locator(".workspace-main").boundingBox()).y, 0);
    const expand = page.getByRole("button", { name: "展开侧栏", exact: true });
    await page.mouse.move(800, 400); await expand.evaluate(node => node.blur());
    assert.equal(await expand.locator(".wordmark").isVisible(), true);
    await expand.hover(); assert.equal(await expand.locator(".brand-expand-icon").isVisible(), true);
    assert.equal(await expand.locator(".wordmark").isVisible(), false);
    await capture(page, "desktop-sidebar-collapsed");
    await page.mouse.move(800, 400); await page.locator(".skip-link").focus(); await page.keyboard.press("Tab");
    assert.equal(await expand.evaluate(node => node === document.activeElement), true);
    assert.equal(await expand.locator(".brand-expand-icon").isVisible(), true);
    await expand.press("Enter");
    await archived.getByRole("button", { name: "发布记录", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "收起侧栏", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Escape"); await expand.waitFor();
    assert.equal(await expand.evaluate(node => node === document.activeElement), true);
    await rail.getByRole("button", { name: "设置与插件", exact: true }).click();
    assert.equal(await page.locator(".session-index").isVisible(), false, "switching panels preserves collapsed preference");
    await page.setViewportSize({ width: 390, height: 844 });
    await expand.click(); await page.locator(".session-index").waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".session-index").waitFor({ state: "hidden" });
    await expand.click();

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobile.on("pageerror", error => errors.push(error.message));
    await mobile.goto(booted.context.get("webManagementHost").url);
    const mobileRail = mobile.getByRole("navigation", { name: "主要导航", exact: true });
    await mobileRail.getByRole("button", { name: "归档", exact: true }).tap();
    await mobile.locator(".ledger-header h1").filter({ hasText: "发布记录" }).waitFor();
    await mobile.locator(".message-text").filter({ hasText: "发布记录的独立历史记录" }).waitFor();
    const mobileExpandBox = await mobile.getByRole("button", { name: "展开侧栏", exact: true }).boundingBox();
    assert.ok(mobileExpandBox.width >= 40 && mobileExpandBox.height >= 40);
    await capture(mobile, "mobile-archive-conversation");
    await mobile.getByRole("button", { name: "展开侧栏", exact: true }).tap();
    await mobile.getByRole("navigation", { name: "归档会话列表", exact: true }).getByRole("button", { name: /^发布记录/ }).waitFor();
    await capture(mobile, "mobile-archive-groups");
    await mobileRail.getByRole("button", { name: "执行工作区", exact: true }).tap();
    await mobile.getByRole("button", { name: "展开侧栏", exact: true }).tap();
    await mobile.getByRole("navigation", { name: "会话列表", exact: true }).getByRole("button", { name: "整理界面", exact: true }).waitFor();
    await capture(mobile, "mobile-workspace-groups");
    assert.equal((await mobile.locator(".session-index").boundingBox()).y, 0);
    assert.equal(await mobile.locator(".workspace-main").getAttribute("inert"), "");
    await mobile.getByRole("button", { name: "关闭侧栏遮罩", exact: true }).tap({ position: { x: 330, y: 600 } });
    await mobile.locator(".session-index").waitFor({ state: "hidden" });
    assert.equal(await mobile.locator(".workspace-main").getAttribute("inert"), null);
    await mobile.getByRole("button", { name: "展开侧栏", exact: true }).tap();
    await mobile.getByRole("navigation", { name: "会话列表", exact: true }).getByRole("button", { name: "检查文档", exact: true }).tap();
    await mobile.locator(".session-index").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("real browser mounts Cordis slots, disables actual Skills, restores UI, and persists settings", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-next-browser-"));
  let booted, browser;
  try {
    await mkdir(join(directory, ".wish", "skills", "sample"), { recursive: true });
    await writeFile(join(directory, ".wish", "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Local sample\n---\nRead the sample.\n");
    const options = { surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) };
    booted = await bootstrap(options);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    const settingsNavigation = page.getByRole("navigation", { name: "可用视图", exact: true });
    await settingsNavigation.getByRole("button", { name: "模型配置", exact: true }).waitFor({ timeout: 6000 });
    assert.deepEqual(await settingsNavigation.locator(".navigation-item").allTextContents(), ["通用设置", "插件管理", "模型配置"]);
    assert.equal(await settingsNavigation.getByRole("button", { name: "Skills", exact: true }).count(), 0);
    assert.equal(await settingsNavigation.getByRole("button", { name: "通用设置", exact: true }).getAttribute("aria-current"), "page");
    await page.getByRole("heading", { name: "通用设置", exact: true }).waitFor();
    assert.equal(await page.locator('a[href="/legacy"]').count(), 0);
    assert.equal(await page.locator('link[rel="stylesheet"]').getAttribute("href"), "/assets/app.css");
    const rail = page.getByRole("navigation", { name: "主要导航", exact: true });
    await rail.getByRole("button", { name: "Skills", exact: true }).waitFor({ timeout: 6000 }).catch(async error => {
      throw new Error(JSON.stringify({ errors, body: await page.locator("body").innerText(), entry: booted.pluginManagement.snapshot().inspection.entries.find(entry => entry.id === "include:skills-local") }), { cause: error });
    });
    const settingsIcons = async () => {
      const paths = [];
      for (const label of ["通用设置", "插件管理", "模型配置"]) {
        const icon = settingsNavigation.getByRole("button", { name: label, exact: true }).locator("svg");
        assert.equal(await icon.isVisible(), true);
        assert.equal(await icon.getAttribute("aria-hidden"), "true");
        assert.equal(await icon.getAttribute("width"), "20");
        assert.equal(await icon.getAttribute("stroke-width"), "1.7");
        const path = await icon.locator("path").getAttribute("d");
        assert.ok(path); paths.push(path);
      }
      assert.equal(new Set(paths).size, 3, "each settings entry owns a distinct icon");
      return paths;
    };
    const originalIcons = await settingsIcons();
    const originalSkillsIcon = await rail.getByRole("button", { name: "Skills", exact: true }).locator("path").getAttribute("d");
    assert.ok(originalSkillsIcon);
    assert.equal(originalIcons.includes(originalSkillsIcon), false, "Skills owns a distinct icon on the global rail");
    const areaIcon = await page.getByRole("button", { name: "设置与插件", exact: true }).locator("path").getAttribute("d");
    assert.notEqual(originalIcons[0], areaIcon, "General Settings owns an icon distinct from the settings-area icon");
    await capture(page, "desktop-settings-icons");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    assert.deepEqual(await settingsIcons(), originalIcons);
    await capture(page, "mobile-settings-icons");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "插件管理", exact: true }).click();
    assert.equal(await page.getByRole("columnheader", { name: "配置状态", exact: true }).count(), 1);
    assert.equal(await page.getByRole("columnheader", { name: "用户偏好", exact: true }).count(), 0);
    const enabledConfiguration = page.getByRole("button", { name: "停用 include:skills-local", exact: true });
    assert.equal(await enabledConfiguration.evaluate(node => getComputedStyle(node).color), "rgb(31, 107, 67)");
    const disabledWebFetch = page.getByRole("button", { name: "启用 include:web-fetch-http", exact: true });
    await disabledWebFetch.waitFor();
    assert.equal(await disabledWebFetch.isDisabled(), false);
    assert.equal(await disabledWebFetch.evaluate(node => getComputedStyle(node).color), "rgb(165, 38, 50)");
    assert.equal(await disabledWebFetch.textContent(), "已停用");
    const unmetConfiguration = page.getByRole("button", { name: "条件未满足 include:web-search-searxng", exact: true });
    await unmetConfiguration.waitFor();
    assert.equal(await unmetConfiguration.isDisabled(), true);
    assert.equal(await unmetConfiguration.evaluate(node => getComputedStyle(node).color), "rgb(82, 97, 122)");
    assert.equal(await unmetConfiguration.textContent(), "条件未满足");
    await disabledWebFetch.click();
    const enabledWebFetch = page.getByRole("button", { name: "停用 include:web-fetch-http", exact: true });
    await enabledWebFetch.waitFor();
    assert.ok(booted.surfaceContext.get("webFetch"));
    const disabledWebFetchTool = page.getByRole("button", { name: "启用 include:tool-web-fetch", exact: true });
    await disabledWebFetchTool.click();
    const enabledWebFetchTool = page.getByRole("button", { name: "停用 include:tool-web-fetch", exact: true });
    await enabledWebFetchTool.waitFor();
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_fetch"), true);
    await enabledWebFetch.click();
    await disabledWebFetch.waitFor();
    assert.equal(booted.surfaceContext.get("webFetch"), undefined);
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_fetch"), false);
    await disabledWebFetch.click();
    await enabledWebFetch.waitFor();
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_fetch"), true);
    await enabledWebFetchTool.click();
    await disabledWebFetchTool.waitFor();
    assert.ok(booted.surfaceContext.get("webFetch"));
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_fetch"), false);
    await page.getByRole("button", { name: "检查 include:skills-local", exact: true }).click();
    await page.locator('[data-entry-id="include:skills-local"] + .plugin-inspection-row').waitFor();
    assert.equal(await page.locator(".plugin-inspection-row").count(), 1);
    await page.getByRole("heading", { name: "停用影响", exact: true }).waitFor();
    await page.getByRole("table", { name: "运行中受影响的 Fiber", exact: true }).waitFor();
    const lifecycleTable = page.getByRole("table", { name: "生命周期报告", exact: true });
    const directMethods = lifecycleTable.getByText("direct", { exact: true });
    await directMethods.first().waitFor();
    assert.equal(await directMethods.evaluateAll(nodes => nodes.every(node => getComputedStyle(node.closest("td")).whiteSpace === "nowrap")), true);
    assert.equal(await page.getByRole("button", { name: "确认停用", exact: true }).count(), 0, "inspection is information-only");
    await capture(page, "desktop-plugin-inspection", false);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTable = await page.getByRole("table", { name: "生命周期报告", exact: true }).evaluate(node => ({ width: node.getBoundingClientRect().width, container: node.parentElement.getBoundingClientRect().width, overflow: node.parentElement.scrollWidth > node.parentElement.clientWidth }));
    assert.equal(mobileTable.overflow, true);
    assert.ok(mobileTable.width > mobileTable.container, "inspection table keeps its columns and scrolls inside its own boundary");
    await capture(page, "mobile-plugin-inspection", false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await enabledConfiguration.click();
    await rail.getByRole("button", { name: "Skills", exact: true }).waitFor({ state: "detached" });
    assert.equal(booted.surfaceContext.get("skills"), undefined);
    assert.equal(booted.surfaceContext.get("tools").registry.list().some(tool => tool.name === "read_skill"), false);
    await page.getByRole("searchbox").fill("skills");
    const disabledConfiguration = page.getByRole("button", { name: "启用 include:skills-local", exact: true });
    await disabledConfiguration.waitFor();
    await page.mouse.move(0, 0);
    assert.equal(await disabledConfiguration.evaluate(node => getComputedStyle(node).color), "rgb(165, 38, 50)");
    await capture(page, "desktop-plugins-skills-disabled");
    await page.getByRole("searchbox").fill("");
    await disabledConfiguration.click();
    await rail.getByRole("button", { name: "Skills", exact: true }).waitFor();
    assert.equal(await rail.getByRole("button", { name: "Skills", exact: true }).locator("path").getAttribute("d"), originalSkillsIcon, "Skills rail icon returns with its plugin after remount");
    assert.ok(booted.surfaceContext.get("skills"));
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await createDefaultSession(page, booted, directory);
    await rail.getByRole("button", { name: "Skills", exact: true }).click();
    const skillNavigation = page.getByRole("navigation", { name: "Skill 列表", exact: true });
    await skillNavigation.getByRole("button", { name: /sample/ }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "会话列表", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "刷新状态", exact: true }).count(), 0);
    await skillNavigation.getByRole("button", { name: /sample/ }).click();
    await page.locator(".skill-document").filter({ hasText: "Read the sample." }).waitFor();
    const { sessions: [session] } = await (await fetch(booted.context.get("webManagementHost").url + "/api/sessions")).json();
    const plan = booted.surfaceContext.get("plan");
    await plan.enter({ sessionId: session.sessionId }); await plan.update({ sessionId: session.sessionId, markdown: "# 浏览器验收计划\n先验证，再实施。" });
    await plan.review({ sessionId: session.sessionId, markdown: "# 浏览器验收计划\n先验证，再实施。", expectedPlanVersion: 1 });
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.getByLabel("补充说明或要求", { exact: true }).fill("补充失败恢复检查");
    await page.getByRole("button", { name: "继续规划", exact: true }).click();
    await page.getByRole("button", { name: "确认操作", exact: true }).click();
    await page.locator(".feature-document").filter({ hasText: "补充失败恢复检查" }).waitFor();
    assert.equal((await plan.get({ sessionId: session.sessionId })).active, true);
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "通用设置", exact: true }).click();
    await page.locator("select#webui-appearance-theme").selectOption("dark");
    await page.locator("html[data-theme=dark]").waitFor();
    await page.locator("select#webui-composer-busy-delivery").selectOption("steer");
    await page.locator(".setting-commit-status").filter({ hasText: "已应用" }).waitFor();
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await page.locator("select#models-default-model").selectOption("deepseek/deepseek-v4-pro");
    await page.locator(".setting-commit-status").filter({ hasText: "已应用于新运行" }).waitFor();
    const outputLimit = page.locator("#models-max-output");
    await outputLimit.fill("16K"); await outputLimit.press("Tab");
    await page.locator(".setting-commit-status").filter({ hasText: "下一次请求使用新上限" }).waitFor();
    assert.equal(JSON.parse(booted.context.get("settings").port.describe().sections.find(section => section.namespace === "models").value["max-output-token-overrides"])["deepseek/deepseek-v4-pro"], 16000);
    await page.locator("select#models-default-model").selectOption("deepseek/deepseek-flash");
    await page.waitForFunction(() => document.querySelector("#models-max-output")?.value === "");
    await page.locator("select#models-default-model").selectOption("deepseek/deepseek-v4-pro");
    await page.waitForFunction(() => document.querySelector("#models-max-output")?.value === "16K");
    await page.getByRole("button", { name: "通用设置", exact: true }).click();
    await page.locator("select#webui-appearance-font-size").selectOption("extra-large");
    await page.locator("html[data-font-size=extra-large]").waitFor();
    assert.ok(Math.abs(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)) - 18) < 0.1);
    await page.locator("select#webui-appearance-language").selectOption("en-US");
    await page.locator("html[lang=en-US]").waitFor();
    await page.getByRole("heading", { name: "General settings", exact: true }).waitFor();
    await page.getByLabel("Text size", { exact: true }).waitFor();
    await capture(page, "desktop-settings-saved");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "large English settings fit the mobile viewport");
    await capture(page, "mobile-settings-saved");
    const savedSettings = booted.context.get("settings").port.describe().sections;
    assert.equal(savedSettings.find(section => section.namespace === "webui-appearance").value.theme, "dark");
    assert.equal(savedSettings.find(section => section.namespace === "webui-appearance").value.language, "en-US");
    assert.equal(savedSettings.find(section => section.namespace === "webui-appearance").value["font-size"], "extra-large");
    assert.equal(savedSettings.find(section => section.namespace === "webui-composer").value["busy-delivery"], "steer");
    assert.equal(savedSettings.find(section => section.namespace === "models").value["default-model"], "deepseek/deepseek-v4-pro");
    assert.equal(JSON.parse(savedSettings.find(section => section.namespace === "models").value["max-output-token-overrides"])["deepseek/deepseek-v4-pro"], 16000);
    await page.close(); await booted.dispose(); booted = await bootstrap(options);
    const restoredSettings = booted.context.get("settings").port.describe().sections;
    assert.equal(restoredSettings.find(section => section.namespace === "webui-appearance").value.theme, "dark");
    assert.equal(restoredSettings.find(section => section.namespace === "webui-appearance").value.language, "en-US");
    assert.equal(restoredSettings.find(section => section.namespace === "webui-appearance").value["font-size"], "extra-large");
    assert.equal(restoredSettings.find(section => section.namespace === "webui-composer").value["busy-delivery"], "steer");
    assert.equal(restoredSettings.find(section => section.namespace === "models").value["default-model"], "deepseek/deepseek-v4-pro");
    assert.equal(JSON.parse(restoredSettings.find(section => section.namespace === "models").value["max-output-token-overrides"])["deepseek/deepseek-v4-pro"], 16000);
    assert.ok(booted.surfaceContext.get("webFetch"), "user-enabled default-off Provider survives restart");
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_fetch"), false, "independently disabled Tool survives restart");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("real child Agent renders inline with owned identity, snapshot, attachment and presentation-only filtering", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-inline-child-"));
  let booted, browser, releaseChild, childRequests = 0;
  const childGate = new Promise(resolve => { releaseChild = resolve; });
  const provider = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
    request.on("end", () => { void (async () => {
      const payload = JSON.parse(body), parent = payload.tools?.some(tool => tool.function?.name === "spawn_agent");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = (content, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
      if (!parent) {
        childRequests++; response.write(delta("透明子任务：正在检查模块边界。")); await childGate;
        response.end(delta("UI_CHILD_RESULT_OK：界面观察不接管子任务状态。", "stop") + "data: [DONE]\n\n"); return;
      }
      if (JSON.stringify(payload.messages).includes("UI_CHILD_RESULT_OK")) { response.end(delta("已收到子任务结果，父任务继续完成核对。", "stop") + "data: [DONE]\n\n"); return; }
      if (payload.messages.some(message => message.role === "tool")) { response.end(delta("子任务已启动；你可以展开执行证据，或继续补充要求。", "stop") + "data: [DONE]\n\n"); return; }
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "inline-child-call", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ task: "检查执行记录的父子关联，并报告结果。", role: "reviewer", permissionProfile: "read-only", availableTools: ["read"] }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    })(); });
  });
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MODELS_JSON: JSON.stringify(modelConfiguration(provider.address().port)), WISH_PERMISSION_PROFILE: "full-access", WISH_SHELL_PROVIDER: "host", WISH_SHELL_HOST_ENABLED: "1" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.get("webManagementHost").url);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await createDefaultSession(page, booted, directory);
    await page.locator("#wish-composer").fill("委派一次模块边界检查，让我查看透明执行过程。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.locator(".ledger-tool").getByText("spawn_agent", { exact: true }).waitFor();
    await page.locator(".ledger-tool > .event-body > details > summary").click();
    await page.locator(".child-evidence").waitFor({ timeout: 10000 });
    await page.locator(".child-evidence").getByRole("button", { name: "刷新快照", exact: true }).click();
    await page.locator(".terminal-output").filter({ hasText: "透明子任务" }).waitFor();
    await page.locator(".child-evidence").getByRole("button", { name: "复制 tmux 连接命令", exact: true }).click();
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("attach-session"));
    await page.locator("#wish-composer").fill("继续核对异常退出的记录");
    await page.getByRole("button", { name: "引导", exact: true }).waitFor();
    await capture(page, "desktop-inline-subagent");
    await page.setViewportSize({ width: 1586, height: 992 });
    await capture(page, "hero-repro");
    await page.getByRole("button", { name: "子 Agent", exact: true }).click();
    assert.equal(await page.locator(".ledger-user").count(), 0);
    assert.equal(await page.locator(".child-evidence").count(), 1);
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "mobile-inline-subagent");
    releaseChild();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor({ timeout: 10000 });
    await page.locator(".child-result").filter({ hasText: "UI_CHILD_RESULT_OK" }).waitFor({ timeout: 10000 });
    assert.equal(childRequests, 1); assert.deepEqual(errors, []);
  } finally {
    releaseChild(); await browser?.close();
    const tmux = booted?.surfaceContext.get("tmux");
    for (const item of await tmux?.list({ workspaceRoot: directory }).catch(() => []) ?? []) await tmux.stop({ target: item.target });
    await booted?.dispose(); await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test("new ledger sends through the selected model and HTTP Provider adapter, reloads canonical transcript and preserves IME draft", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-ledger-browser-"));
  let booted, browser, tmuxTarget, requests = 0, release; const selectedModels = [];
  const gate = new Promise(resolve => { release = resolve; });
  const provider = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; }); request.on("end", () => { void (async () => {
      selectedModels.push(JSON.parse(body).model);
      requests++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requests === 2) {
        response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "write-test", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "approved.txt", content: "本地工具验收正文" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`); return;
      }
      if (requests === 4) {
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "skills-history", type: "function", function: { name: "list_skills", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`); return;
      }
      response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "已收到请求。" }, finish_reason: null }] })}\n\n`);
      await gate;
      response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "这是一条本地验收回复。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    })(); });
  });
  try {
    await writeFile(join(directory, "note.txt"), "本地工具验收正文");
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const configuration = { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
      providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native", models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }, { id: "secondary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MODELS_JSON: JSON.stringify(configuration), WISH_PERMISSION_PROFILE: "approval-required" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
    const network = await page.context().newCDPSession(page), streamed = [];
    await network.send("Network.enable"); network.on("Network.eventSourceMessageReceived", event => { if (event.eventName === "model.stream") streamed.push(event.data); });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "模型配置", exact: true }).waitFor();
    await page.getByRole("button", { name: "模型配置", exact: true }).click();
    await page.locator("select#models-default-model").selectOption("fixture/secondary");
    await page.locator(".setting-commit-status").filter({ hasText: "已应用于新运行" }).waitFor();
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await createDefaultSession(page, booted, directory);
    const composer = page.getByLabel("消息", { exact: true });
    await composer.fill("检查新版执行记录");
    await composer.dispatchEvent("compositionstart");
    await composer.press("Enter"); assert.equal(requests, 0);
    await composer.dispatchEvent("compositionend");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.locator(".message-text").filter({ hasText: "已收到请求。" }).waitFor({ timeout: 6000 }).catch(async error => { throw new Error(JSON.stringify({ errors, requests, streamed, body: await page.locator("body").innerText() }), { cause: error }); });
    assert.equal(selectedModels[0], "secondary", "the next new Run samples the saved model setting");
    await page.locator("#wish-composer").fill("保留这段草稿");
    await page.getByRole("button", { name: "引导", exact: true }).waitFor();
    await capture(page, "desktop-busy-composer");
    release();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    assert.equal(await page.locator("#wish-composer").inputValue(), "保留这段草稿");
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    assert.equal(await page.locator("#wish-composer").inputValue(), "保留这段草稿");
    await page.reload();
    await page.locator(".message-text").filter({ hasText: "这是一条本地验收回复。" }).waitFor();
    assert.equal(await page.locator(".ledger-assistant").count(), 1); assert.equal(requests, 1); assert.deepEqual(errors, []);
    await page.locator("#wish-composer").fill("将验收正文写入 approved.txt");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByRole("region", { name: "工具审批 write", exact: true }).waitFor({ timeout: 6000 }).catch(async error => { throw new Error(JSON.stringify({ errors, requests, body: await page.locator("body").innerText() }), { cause: error }); });
    await capture(page, "desktop-approval");
    await page.getByRole("button", { name: "批准工具调用", exact: true }).click();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    await page.locator(".ledger-tool summary").click();
    await page.locator(".ledger-tool pre").filter({ hasText: "approved.txt" }).first().waitFor();
    assert.equal(await readFile(join(directory, "approved.txt"), "utf8"), "本地工具验收正文");
    assert.equal(requests, 3); assert.deepEqual(new Set(selectedModels), new Set(["secondary"])); assert.deepEqual(errors, []);
    assert.equal(await page.locator(".file-tool-details").count(), 1);
    await page.getByRole("button", { name: "Context", exact: true }).click();
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.locator(".feature-document").filter({ hasText: '"provider": "fixture"' }).waitFor();
    assert.equal((await page.locator(".feature-document").innerText()).includes("将验收正文写入"), false);
    await capture(page, "desktop-context");
    await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
    await page.locator(".trajectory-list summary").filter({ hasText: "tool.completed" }).waitFor();
    const tmux = booted.surfaceContext.get("tmux");
    const terminal = await tmux.start({ sessionId: "browser-fixture", windowName: "observe", command: { executable: "/bin/cat", cwd: directory }, metadata: { workspaceRoot: directory, label: "Browser acceptance only" } });
    tmuxTarget = terminal.target;
    await tmux.send({ target: tmuxTarget, text: "TMUX_BROWSER_VERIFIED", enter: true });
    await page.getByRole("button", { name: "tmux", exact: true }).click();
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.getByRole("button", { name: "刷新快照", exact: true }).click();
    await page.locator(".terminal-output").filter({ hasText: "TMUX_BROWSER_VERIFIED" }).waitFor();
    assert.ok((await page.locator(".terminal-attach").textContent()).includes("attach-session"));
    await capture(page, "desktop-tmux");
    await page.getByRole("button", { name: "执行记录", exact: true }).click();
    await page.locator(".ledger-tool summary").first().click();
    await page.locator("#wish-composer").fill("再检查一下失败恢复的处理");
    await capture(page, "desktop-ledger");
    await page.setViewportSize({ width: 1586, height: 992 });
    await capture(page, "comp-size-ledger");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator(".app-header").count(), 0);
    await capture(page, "mobile-ledger");
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await capture(page, "mobile-navigation");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.getByRole("button", { name: "展开侧栏", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.locator(".session-link").first().click();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator("#wish-composer").inputValue(), "再检查一下失败恢复的处理");
    await page.context().setOffline(true);
    await page.locator(".connection-state.offline").waitFor();
    assert.equal(await page.locator(".connection-state").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(165, 38, 50)");
    assert.equal(await page.locator(".brand-control .connection-state").count(), 1);
    const offlineComposer = await page.locator(".composer").boundingBox();
    assert.ok(offlineComposer && offlineComposer.y + offlineComposer.height <= page.viewportSize().height + 1, "offline notice must leave the entire composer anchored inside the viewport");
    const offlineSend = await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox();
    assert.ok(offlineSend && offlineSend.y + offlineSend.height <= page.viewportSize().height, "offline send control remains visible even while disabled");
    await capture(page, "mobile-offline");
    assert.equal(await page.locator("#wish-composer").inputValue(), "再检查一下失败恢复的处理");
    await page.context().setOffline(false);
    await page.locator(".connection-state.online").waitFor();
    assert.equal(await page.locator(".connection-state").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(22, 93, 204)");
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.getByRole("button", { name: "tmux", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(requests, 3, "reconnect must not replay a model or Tool request");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#wish-composer").fill("查看 Skill 目录用于历史能力验收");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    await page.locator(".ledger-tool strong").filter({ hasText: "list_skills" }).waitFor();
    // A visible Tool call is not a Run-completion barrier. Stop only after idle.
    await page.waitForFunction(() => document.querySelector(".run-state")?.textContent === "等待请求");
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "插件管理", exact: true }).click();
    const disableResponse = page.waitForResponse(response => response.url().endsWith("/api/management/plugins/change") && response.request().method() === "POST");
    await page.getByRole("button", { name: "停用 include:skills-local", exact: true }).click();
    const disableReceipt = await (await disableResponse).json();
    assert.equal(disableReceipt.status, "succeeded", JSON.stringify(disableReceipt));
    await page.getByRole("button", { name: "Skills", exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.getByRole("button", { name: "工具", exact: true }).click();
    assert.equal(await page.locator(".ledger-user").count(), 0);
    await page.locator(".historical-capability").filter({ hasText: "Host 工具入口当前不可用" }).waitFor();
    await capture(page, "desktop-historical-capability");
    await page.locator(".historical-capability").getByRole("button", { name: "查看插件管理", exact: true }).click();
    await page.getByRole("heading", { name: "插件管理", exact: true }).waitFor();
  } finally { release(); await browser?.close(); if (tmuxTarget) await booted?.surfaceContext.get("tmux")?.stop({ target: tmuxTarget }); await booted?.dispose(); await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); }
});
