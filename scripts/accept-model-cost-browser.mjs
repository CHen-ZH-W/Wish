import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { createDefaultModelPricingResolver } from "../dist/models/pricing.js";
import { calculateModelCost } from "../dist/models/usage.js";

const model = { provider: "deepseek", model: "deepseek-flash" };
const titles = { known: "峰谷费用验收", unknown: "费用未知", partial: "费用覆盖不完整", tiny: "微小费用", multi: "多币种费用", zero: "已知零费用" };

// Costs travel through the real ledger, HTTP control and Browser. Only the
// adjacent context meter uses fixed numbers. No external Provider is called.
test("Session fees use durable peak/off-peak costs beside context with native disclosure", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-cost-browser-"));
  const artifacts = resolve(process.env.WISH_BROWSER_ARTIFACT_DIR ?? ".impeccable/cost-review");
  let booted, browser;
  try {
    await mkdir(artifacts, { recursive: true });
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, CORDIS_HMR: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    const ctx = booted.surfaceContext, sessions = ctx.get("sessions").manager;
    for (const [sessionId, title] of Object.entries(titles)) {
      await sessions.create({ sessionId, title, agentId: ctx.get("agents").agentId, scope: directory });
    }
    const ledger = ctx.get("modelAttemptLedger"), pricing = createDefaultModelPricingResolver();
    let ordinal = 0;
    async function record(sessionId, currency = "CNY", at = "2026-10-19T02:00:00.000Z", inputTokens = 2_000_000, outputTokens = 1_000_000, cachedInputTokens = 1_000_000) {
      const attemptId = `cost-${++ordinal}`;
      const scope = { sessionId, runId: `${sessionId}-run`, userTurnId: `${sessionId}-turn`, stepId: `${sessionId}-step-${ordinal}` };
      await ledger.start({ ...scope, attemptId, requestedAt: at, requestedModel: model });
      const quote = pricing.resolve({ requestedModel: model, currency, requestedAt: Date.parse(at) });
      assert.ok(quote, "the reviewed pricing calendar must resolve this test instant");
      const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens, cacheWriteInputTokens: 0, source: "provider" };
      const cost = calculateModelCost({ model, usage, price: quote });
      assert.equal(cost.status, "available");
      await ledger.finish({ attemptId, status: "completed", endedAt: new Date(Date.parse(at) + 1000).toISOString(), billedModel: model, quote, usage, cost });
    }
    async function missing(sessionId) {
      const attemptId = `cost-${++ordinal}`;
      await ledger.start({ attemptId, sessionId, runId: `${sessionId}-run`, userTurnId: `${sessionId}-turn`, stepId: `${sessionId}-step-${ordinal}`,
        requestedAt: "2026-10-19T03:00:00.000Z", requestedModel: model });
      await ledger.finish({ attemptId, status: "completed", endedAt: "2026-10-19T03:00:01.000Z" });
    }
    await record("known");
    await record("known", "CNY", "2026-10-19T05:00:00.000Z");
    await missing("unknown");
    await record("partial"); await missing("partial");
    await record("tiny", "CNY", undefined, 1, 0, 0);
    await record("multi"); await record("multi", "USD");
    await record("zero", "CNY", undefined, 0, 0, 0);
    const url = booted.context.get("webManagementHost").url;
    const live = await (await fetch(`${url}/api/sessions/known/controls/model-usage`)).json();
    const fees = live.value.cost;
    assert.equal(fees.coverage, "complete");
    assert.ok(Math.abs(fees.currencies[0].totalCost - 15.06) < 1e-9);
    assert.deepEqual(fees.currencies[0].periods.map(period => period.period).sort(), ["off_peak", "peak"]);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const errors = [], consoleErrors = [], unexpectedRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
      unexpectedRequests.push(route.request().url()); return route.abort();
    });
    await page.route("**/api/sessions/*/controls/context-occupancy", route => {
      const sessionId = new URL(route.request().url()).pathname.split("/")[3];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value: {
        schemaVersion: 1, sessionId, status: "estimated", source: "estimated", usedTokens: 32_000, contextWindow: 128_000,
        breakdown: { systemTokens: 4_000, toolsTokens: 8_000, messageTokens: 20_000 },
      } }) });
    });
    const trigger = page.locator(".model-cost-trigger"), panel = page.locator(".model-cost-popover");
    async function select(sessionId) {
      if (!await page.locator("#wish-sidebar").isVisible()) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
      await page.locator(".session-link").filter({ hasText: titles[sessionId] }).click();
      await page.locator("#wish-composer").waitFor(); await trigger.waitFor();
    }
    async function open() {
      await trigger.focus(); await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector(".model-cost-popover")?.matches(":popover-open"));
      await page.waitForFunction(() => document.querySelector(".model-cost-trigger")?.getAttribute("aria-expanded") === "true");
    }
    async function close() {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".model-cost-popover")?.matches(":popover-open"));
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    }
    await page.goto(url); await select("known");
    assert.match(await trigger.textContent(), /15\.06/u);
    await page.locator(".context-occupancy-trigger").waitFor();
    assert.equal(await page.locator(".model-usage-trigger").count(), 1, "the existing cache reading remains available");
    const context = await page.locator(".context-occupancy-trigger").boundingBox(), fee = await trigger.boundingBox();
    assert.ok(context && fee && Math.abs(context.y - fee.y) < 12 &&
      Math.min(Math.abs(context.x - fee.x - fee.width), Math.abs(fee.x - context.x - context.width)) <= 12,
    "fees sit beside context usage");
    await page.locator("#wish-composer").fill("费用详情不清空草稿");
    await open();
    assert.match(await panel.textContent(), /峰|Peak/u); assert.match(await panel.textContent(), /谷|Off.peak/u);
    assert.match(await panel.textContent(), /10\.04/u); assert.match(await panel.textContent(), /5\.02/u);
    await close(); await trigger.click(); await page.mouse.click(1, 1);
    await page.waitForFunction(() => !document.querySelector(".model-cost-popover")?.matches(":popover-open"));
    assert.equal(await page.locator("#wish-composer").inputValue(), "费用详情不清空草稿");

    const captures = [];
    for (const [device, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
        await open();
        const geometry = await page.evaluate(() => {
          const node = document.querySelector(".model-cost-popover"), trigger = document.querySelector(".model-cost-trigger");
          const rect = node.getBoundingClientRect(), focus = trigger.getBoundingClientRect(), style = getComputedStyle(trigger);
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, documentWidth: document.documentElement.scrollWidth,
            scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, focusBottom: focus.bottom + parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset)),
            focusVisible: trigger.matches(":focus-visible"), background: getComputedStyle(node).backgroundColor };
        });
        assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= viewport.width + 1 && geometry.y + geometry.height <= viewport.height + 1);
        assert.ok(geometry.documentWidth <= viewport.width + 1 && geometry.scrollWidth <= geometry.clientWidth + 1);
        assert.equal(geometry.focusVisible, true); assert.ok(geometry.focusBottom <= viewport.height);
        const filename = `${device}${theme === "dark" ? "-dark" : ""}.png`;
        await page.screenshot({ path: join(artifacts, filename), fullPage: true }); captures.push({ device, theme, filename, ...geometry });
        await close();
      }
    }
    await select("unknown"); assert.match(await trigger.textContent(), /—/u); assert.doesNotMatch(await trigger.textContent(), /0[.,]0/u);
    await select("partial"); assert.match(await trigger.textContent(), /部分|Partial/u);
    await select("tiny"); assert.doesNotMatch(await trigger.textContent(), /[¥$]\s*0(?:\.0+)?(?:\s|$)/u);
    await select("multi"); await open(); assert.match(await panel.textContent(), /CNY/u); assert.match(await panel.textContent(), /USD/u); await close();
    await select("zero"); assert.match(await trigger.textContent(), /0/u); assert.doesNotMatch(await trigger.textContent(), /—/u);
    await page.reload(); await select("known"); assert.match(await trigger.textContent(), /15\.06/u);
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(unexpectedRequests, []);
    await writeFile(join(artifacts, "model-cost-browser.json"), JSON.stringify({ scope: "real ledger, period policy, Host control and Browser; only context uses fixed values; no Provider calls", live: fees, captures, errors, consoleErrors, unexpectedRequests }, null, 2) + "\n");
  } finally {
    await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
