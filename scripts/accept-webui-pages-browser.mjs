import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

// Real Host, UI modules, settings and Skills files. No model request is sent.
for (const width of [1440, 390]) test(`all visited pages and sidebars retain their state at ${width}px`, { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-pages-browser-"));
  let booted, browser, page;
  try {
    for (let index = 0; index < 24; index++) {
      const name = `guide-${String(index).padStart(2, "0")}`, root = join(directory, ".wish", "skills", name);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: 页面保留验收\n---\n# 阅读说明\n\n` + "保留已经阅读的位置。\n\n".repeat(100));
    }
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory,
        WISH_MODELS_JSON: JSON.stringify({ schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
          providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", auth: { type: "none" },
            models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096,
              input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] }) },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const manager = booted.surfaceContext.get("sessions").manager;
    await manager.create({ sessionId: "active", agentId: booted.surfaceContext.get("agents").agentId, scope: directory, title: "保留验收会话" });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width, height: 600 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(12_000);
    const errors = [], reads = new Map();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      assert.equal(path.endsWith("/v1/chat/completions"), false);
      reads.set(path, (reads.get(path) ?? 0) + 1);
    });
    const rail = () => page.locator(".utility-rail");
    const openSidebar = async () => {
      const button = page.getByRole("button", { name: "展开侧栏", exact: true });
      if (await button.isVisible()) await button.click();
    };
    const closeDrawer = async () => {
      if (width === 390 && await page.locator("#wish-sidebar").isVisible()) await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    };
    const settings = async label => {
      await rail().getByRole("button", { name: "设置与插件", exact: true }).click();
      await openSidebar();
      if (label !== "通用设置") await page.getByRole("button", { name: label, exact: true }).click();
      await closeDrawer();
      await page.getByRole("heading", { name: label, exact: true }).waitFor();
    };
    const position = async locator => locator.evaluate(node => {
      const scroller = node.closest(".view-loading-content");
      scroller.scrollTop = 220;
      return scroller.scrollTop;
    });
    const assertPosition = async (locator, expected) => {
      const actual = await locator.evaluate(node => node.closest(".view-loading-content").scrollTop);
      assert.ok(Math.abs(actual - expected) <= 2, `retained scroll position: expected ${expected}, got ${actual}`);
    };
    const noSpinner = async () => assert.equal(await page.locator(".workspace-content .view-loading-status:visible").count(), 0);
    const sameNode = async (original, locator) => assert.equal(await original.evaluate((node, current) => node === current, await locator.elementHandle()), true);
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    await page.locator(".new-session-workspace-trigger").click();
    await page.locator(".new-session-workspace-list button").first().click();
    await page.locator("#new-session-message").fill("新会话未发送的草稿");
    const firstMessage = await page.locator("#new-session-message").elementHandle();

    await rail().getByRole("button", { name: "Skills", exact: true }).click();
    await openSidebar();
    const search = page.locator(".skill-search");
    await search.fill("guide-");
    await page.locator("#wish-sidebar").getByRole("button", { name: /^guide-00/u }).click();
    await page.getByRole("heading", { name: "guide-00", exact: true }).waitFor();
    await page.locator(".skill-source > summary").click();
    await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
    const skill = page.locator(".skills-page"), originalSkill = await skill.elementHandle();
    const source = await page.locator(".skill-source").elementHandle(), originalSearch = await search.elementHandle();
    const skillScroll = await position(skill);
    assert.ok(skillScroll > 0);
    await openSidebar();
    const skillSidebarScroll = await position(search);
    assert.ok(skillSidebarScroll > 0);
    await closeDrawer();
    const skillReads = reads.get("/api/queries/skills/default");

    await settings("通用设置");
    const general = page.locator(".settings-page:visible"), originalGeneral = await general.elementHandle();
    await page.locator("#webui-composer-busy-delivery").selectOption("steer");
    await general.getByRole("status").filter({ hasText: "已应用" }).waitFor();
    const generalScroll = await position(general);
    await settings("模型配置");
    const models = page.locator(".models-settings-page"), originalModels = await models.elementHandle();
    const capacity = page.locator("#models-context-window");
    await capacity.fill("保留未完成的输入");
    await capacity.press("Enter");
    await models.getByRole("alert").waitFor();
    const modelsScroll = await position(models), originalCapacity = await capacity.elementHandle();

    await settings("插件管理");
    const filter = page.getByRole("searchbox", { name: "筛选插件", exact: true });
    await filter.fill("skills");
    await page.getByRole("button", { name: "检查 include:skills-local", exact: true }).click();
    await page.getByRole("heading", { name: "停用影响", exact: true }).waitFor();
    const inspection = await page.locator(".plugin-inspection").elementHandle(), originalFilter = await filter.elementHandle();
    const pluginsScroll = await position(filter), previewReads = reads.get("/api/management/plugins/preview");

    await settings("通用设置");
    await sameNode(originalGeneral, page.locator(".settings-page:visible"));
    await general.getByRole("status").filter({ hasText: "已应用" }).waitFor();
    await assertPosition(general, generalScroll);
    await settings("模型配置");
    await sameNode(originalModels, models); await sameNode(originalCapacity, capacity);
    assert.equal(await capacity.inputValue(), "保留未完成的输入");
    assert.equal(await models.getByRole("alert").isVisible(), true);
    await assertPosition(models, modelsScroll); await noSpinner();
    await settings("插件管理");
    await sameNode(originalFilter, filter);
    assert.equal(await filter.inputValue(), "skills");
    assert.equal(await inspection.evaluate(node => node.isConnected && node.checkVisibility()), true);
    await assertPosition(filter, pluginsScroll);
    assert.equal(reads.get("/api/management/plugins/preview"), previewReads);

    await rail().getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("heading", { name: "guide-00", exact: true }).waitFor();
    await sameNode(originalSkill, skill); await assertPosition(skill, skillScroll);
    assert.equal(await source.evaluate(node => node.isConnected && node.open), true);
    assert.equal(await page.locator(".skill-import").isVisible(), true);
    await openSidebar(); await sameNode(originalSearch, search);
    assert.equal(await search.inputValue(), "guide-");
    await assertPosition(search, skillSidebarScroll);
    assert.equal(reads.get("/api/queries/skills/default"), skillReads);
    await closeDrawer(); await noSpinner();
    await rail().getByRole("button", { name: "会话", exact: true }).click();
    await page.locator("#new-session-message").waitFor();
    await sameNode(firstMessage, page.locator("#new-session-message"));
    assert.equal(await page.locator("#new-session-message").inputValue(), "新会话未发送的草稿");
    await openSidebar();
    await page.getByRole("navigation", { name: "会话列表", exact: true }).getByRole("button", { name: "保留验收会话", exact: true }).click();
    await page.locator(".conversation:visible").getByRole("heading", { name: "保留验收会话", exact: true }).waitFor();
    await settings("通用设置");
    await rail().getByRole("button", { name: "会话", exact: true }).click();
    await page.locator(".conversation:visible").getByRole("heading", { name: "保留验收会话", exact: true }).waitFor();
    await openSidebar();
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
    await sameNode(firstMessage, page.locator("#new-session-message"));
    assert.equal(await page.locator("#new-session-message").inputValue(), "新会话未发送的草稿");
    assert.equal((await manager.list()).length, 1, "navigation never submits the retained first-message draft");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    if (process.env.WISH_WEBUI_CAPTURE_DIR) {
      await mkdir(process.env.WISH_WEBUI_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.WISH_WEBUI_CAPTURE_DIR, `pages-retained-${width}.png`) });
    }
  } finally {
    await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
