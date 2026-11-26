import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";

async function boot(directory) {
  return bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
    environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
    management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
}
for (const width of [1440, 390]) test(`WebUI configures and stops DeepSeek search without launch flags at ${width}px`, { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-search-browser-"));
  let booted, browser;
  try {
    if (width === 390) {
      const store = await ManagedPluginStore.open(join(directory, "management", "plugins.json"));
      try {
        await store.commit(store.snapshot().revision, { preferences: {
          "include:web-search": { name: "cordis:web-search", preference: "enabled" },
          "include:tool-web-search": { name: "cordis:web-search-tool", preference: "enabled" },
        }, pending: null, receipts: [] });
      } finally { await store.close(); }
    }
    booted = await boot(directory); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
    page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.get("webManagementHost").url);
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    const open = page.getByRole("button", { name: "展开侧栏", exact: true });
    if (await open.isVisible()) await open.click();
    await page.getByRole("button", { name: "网页搜索", exact: true }).click();
    if (width === 390 && await page.locator("#wish-sidebar").isVisible()) await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.getByRole("heading", { name: "网页搜索", exact: true }).waitFor();
    if (width === 390) await page.getByText("DeepSeek · 待配置", { exact: true }).waitFor();
    const key = page.getByLabel("DeepSeek 搜索 API 密钥", { exact: true });
    await key.fill("browser-search-test-key"); await key.press("Tab");
    await page.getByPlaceholder("已配置；输入新值可替换", { exact: true }).waitFor();
    if (width === 1440) await page.getByRole("button", { name: "启用搜索", exact: true }).click();
    await page.getByText("DeepSeek · 运行中", { exact: true }).waitFor();
    assert.equal(await key.inputValue(), "");
    await page.reload();
    // Navigation state starts at conversations after a full reload.
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    if (await open.isVisible()) await open.click();
    await page.getByRole("button", { name: "网页搜索", exact: true }).click();
    if (width === 390 && await page.locator("#wish-sidebar").isVisible()) await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.getByText("DeepSeek · 运行中", { exact: true }).waitFor();
    await page.getByRole("button", { name: "停用搜索", exact: true }).click();
    try { await page.getByText("未运行", { exact: true }).waitFor(); }
    catch (error) {
      console.error("Search page:", await page.locator(".settings-page:visible").innerText());
      console.error("Search entries:", booted.pluginManagement.snapshot().inspection.entries.filter(entry => entry.id.includes("web-search")));
      throw error;
    }
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_search"), false);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
