import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { models } from "./fixtures/candidates.mjs";

test("real Host shows evidence-driven candidate development on desktop and mobile without effectiveness scores", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-browser-")), captures = process.env.WISH_EVOLUTION_CAPTURE_DIR ?? "/tmp/wish-evolution-browser";
  let host, browser, page, calls = 0;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* deterministic generation fixture */ }
    calls++;
    const result = JSON.stringify({ content: "Before reporting completion, state which behavior was checked and retain any unverified limitations.", rationale: "浏览器验收样例：让验证说明更明确。效果仍待独立验证。" });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: result }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await mkdir(captures, { recursive: true });
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    const configuration = models(`http://127.0.0.1:${provider.address().port}/v1`);
    host = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_EVOLUTION_ENABLED: "1", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MODELS_JSON: JSON.stringify(configuration), WISH_PERMISSION_PROFILE: "workspace-write" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    const application = await host.surfaceContext.get("application").open();
    await application.createSession({ sessionId: "evolution-browser", workspaceRoot: directory, title: "自进化浏览器验收" });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(host.context.get("webManagementHost").url);
    await page.getByRole("button", { name: "自进化浏览器验收", exact: true }).click();
    const open = page.getByRole("button", { name: /展开会话侧栏|打开会话侧栏|Open session sidebar/ });
    if (await open.count()) await open.click();
    await page.getByRole("button", { name: "打开 自进化", exact: true }).click();
    await page.getByLabel("希望改进什么", { exact: true }).fill("补充完成任务前的验证说明");
    await page.getByRole("button", { name: "发起改进", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".evolution-record")].some(record => record.textContent.includes("候选已准备") || record.querySelector('[role="alert"]')), null, { timeout: 120000 });
    assert.equal(await page.getByText("候选已准备", { exact: true }).isVisible(), true, await page.locator(".evolution-view").innerText());
    assert.equal(calls, 1);
    const evolution = host.surfaceContext.get("evolution"), campaign = (await evolution.list())[0];
    assert.equal(campaign.state, "awaiting-external-validation"); assert.equal(campaign.attempts[0].verdict, undefined);
    assert.equal((await host.surfaceContext.get("candidates").history()).evaluations.length, 0);
    assert.equal((await host.surfaceContext.get("candidates").history()).promotions.length, 0);
    assert.equal(await page.locator(".evolution-view").getByText(/Pass@1|成功率|提升率/).count(), 0);
    await page.getByText("查看候选内容", { exact: true }).click();
    await page.getByText("index.ts", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("index.ts", { exact: true }).click();
    await page.locator(".evolution-record pre").filter({ hasText: "PluginWorkOwner" }).waitFor({ state: "visible" });
    await page.screenshot({ path: join(captures, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!(await page.locator(".evolution-view").isVisible())) await page.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
    await page.locator(".evolution-view").waitFor({ state: "visible" });
    await page.screenshot({ path: join(captures, "mobile.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByLabel("下一轮修改意见", { exact: true }).fill("检查相同候选是否会重复消耗验证资源");
    await page.getByRole("button", { name: "根据反馈继续", exact: true }).click();
    await page.getByText("候选内容与已有轮次相同，已停止重复验证。", { exact: true }).waitFor({ state: "visible", timeout: 30000 });
    await page.getByText("查看候选内容", { exact: true }).first().click();
    await page.getByText("与上一轮比较", { exact: true }).waitFor({ state: "visible" });
    await page.getByText("与上一轮比较", { exact: true }).click();
    await page.getByText("源码内容相同。", { exact: true }).waitFor({ state: "visible" });
    assert.equal(calls, 2); assert.equal((await evolution.list())[0].stopReason, "duplicate-candidate");
    assert.deepEqual(errors, []);
    await writeFile(join(captures, "evidence.json"), JSON.stringify({ campaignId: campaign.id, state: campaign.state, finalState: (await evolution.list())[0].state, modelCalls: calls, duplicateStopped: true, sourceQuery: "exact-digest", model: "deterministic-fixture", candidateValidation: "real-linux", evaluations: 0, publications: 0 }, null, 2));
  } catch (error) {
    if (page) { await page.screenshot({ path: join(captures, "failure.png"), fullPage: true }).catch(() => {}); await writeFile(join(captures, "failure.txt"), await page.locator("body").innerText().catch(() => "page unavailable")); }
    throw error;
  } finally {
    await browser?.close(); await host?.dispose();
    await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
