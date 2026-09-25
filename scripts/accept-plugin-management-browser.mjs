import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("browser shows real owner coverage and cancels a queued plugin change before cleanup", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-control-browser-"));
  let booted, browser, step;
  try {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.webManagementHost.url);
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "插件管理", exact: true }).click();
    const kernelToggle = page.locator('[data-entry-id="include:timer"]').getByRole("button", { name: "内核只读 include:timer", exact: true });
    await kernelToggle.waitFor();
    assert.equal(await kernelToggle.isDisabled(), true);
    assert.match(await kernelToggle.getAttribute("class"), /configuration-readonly/u);
    assert.equal(await kernelToggle.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(240, 242, 245)");
    const row = page.locator('[data-entry-id="include:tool-read"]');
    await row.getByText("已接入热更新，执行时检查依赖", { exact: true }).waitFor();
    const modelsRow = page.locator('[data-entry-id="include:models"]');
    await modelsRow.getByText("已接入热更新，执行时检查依赖", { exact: true }).waitFor();
    const modelsToggle = modelsRow.getByRole("button", { name: "停用 include:models", exact: true });
    assert.equal(await modelsToggle.isDisabled(), false);
    const owner = booted.context.loader.resolve("include:tool-read").fiber;
    // Hold the actual Runtime admission boundary. Model/Tool execution across this
    // boundary is separately covered by accept-managed-code-reload's real Run.
    const execution = booted.surfaceContext.get("runEngine").execution;
    step = await execution.source(() => ({ pipeline: {}, release() {} })).acquire({ signal: new AbortController().signal });
    await row.getByRole("button", { name: "停用 include:tool-read", exact: true }).click();
    await page.getByText("等待当前 Step 完成，随后应用变更", { exact: true }).waitFor();
    await page.getByRole("button", { name: "取消等待", exact: true }).click();
    await page.getByText("已取消等待，插件未修改。", { exact: true }).first().waitFor();
    assert.equal(booted.context.loader.resolve("include:tool-read").fiber, owner);
    assert.equal(booted.pluginManagement.snapshot().pending, null);
    assert.equal(execution.snapshot().phase, "ready");
    step.release(); step = undefined;
    await row.getByRole("button", { name: "停用 include:tool-read", exact: true }).click();
    await row.getByRole("button", { name: "启用 include:tool-read", exact: true }).waitFor();
    assert.equal(booted.surfaceContext.get("tools").registry.has("read"), false);
    await row.getByRole("button", { name: "启用 include:tool-read", exact: true }).click();
    await row.getByRole("button", { name: "停用 include:tool-read", exact: true }).waitFor();
    assert.equal(booted.surfaceContext.get("tools").registry.has("read"), true);
    assert.notEqual(booted.context.loader.resolve("include:tool-read").fiber, owner);
    assert.deepEqual(errors, []);
  } finally { step?.release(); await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
