import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const entryId = "include:context-occupancy-webui-control";
const knownId = "occupancy-known", unknownId = "occupancy-unknown", delayedId = "occupancy-delayed";
const titles = { [knownId]: "上下文占用验收", [unknownId]: "用量未知会话", [delayedId]: "延迟用量会话" };
const capturedAt = "2026-10-20T00:00:00.000Z";
const estimate = sessionId => ({
  schemaVersion: 1, sessionId, status: "estimated", source: "estimated",
  usedTokens: 32_000, contextWindow: 128_000,
  breakdown: { systemTokens: 4_000, toolsTokens: 8_000, messageTokens: 20_000 },
  model: { provider: "browser-fixture", model: "context-window-128k" }, capturedAt,
});
const unknown = sessionId => ({ schemaVersion: 1, sessionId, status: "unknown", source: "unknown" });

// This is a real Host / Browser integration test. Only occupancy values are
// replaced by browser network fixtures, so the numeric screenshots are UI
// evidence, not a provider-backed end-to-end measurement. No Run is started.
test("context meter supports native disclosure, themes, mobile and real Host module gates", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-context-occupancy-browser-"));
  const artifacts = resolve(process.env.WISH_BROWSER_ARTIFACT_DIR ?? ".impeccable/review");
  let booted, browser, releaseDelayed;
  try {
    await mkdir(artifacts, { recursive: true });
    booted = await bootstrap({
      surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, CORDIS_HMR: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    const sessions = booted.surfaceContext.get("sessions").manager;
    const agentId = booted.surfaceContext.get("agents").agentId;
    for (const sessionId of Object.keys(titles)) {
      await sessions.create({ sessionId, agentId, scope: directory, title: titles[sessionId] });
    }
    const hostUrl = booted.context.get("webManagementHost").url;
    const controlUrl = `${hostUrl}/api/sessions/${knownId}/controls/context-occupancy`;
    const liveResponse = await fetch(controlUrl);
    assert.equal(liveResponse.status, 200, "the actual Host contributes the occupancy control before browser fixtures apply");
    const live = await liveResponse.json();
    assert.equal(live.value.sessionId, knownId);
    assert.equal(live.value.schemaVersion, 1);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const errors = [], consoleErrors = [], unexpectedRequests = [], requestedSessions = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(hostUrl).origin) return route.continue();
      unexpectedRequests.push(url.href);
      return route.abort();
    });
    let delayedRequested, delayedFulfilled;
    const waitingForDelayed = new Promise(resolve => { delayedRequested = resolve; });
    const waitingForDelayedFulfilled = new Promise(resolve => { delayedFulfilled = resolve; });
    const delayedResponse = new Promise(resolve => { releaseDelayed = resolve; });
    await page.route("**/api/sessions/*/controls/context-occupancy", async route => {
      const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]);
      requestedSessions.push(sessionId);
      if (sessionId === delayedId) {
        delayedRequested();
        await delayedResponse;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value: sessionId === unknownId ? unknown(sessionId) : estimate(sessionId) }) });
      if (sessionId === delayedId) delayedFulfilled();
    });

    const trigger = page.locator(".context-occupancy-trigger"), popover = page.locator(".context-occupancy-popover");
    async function selectSession(sessionId) {
      if (!await page.locator("#wish-sidebar").isVisible()) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
      await page.locator(".session-link").filter({ hasText: titles[sessionId] }).click();
      await page.locator("#wish-composer").waitFor();
    }
    async function waitForKnown() {
      await trigger.waitFor();
      assert.match(await trigger.textContent(), /~25%/u);
      assert.match(await trigger.getAttribute("aria-label"), /25%/u);
      assert.equal(await trigger.getAttribute("aria-haspopup"), "dialog");
    }
    async function openPopover(keyboard = false) {
      if (keyboard) { await trigger.focus(); await page.keyboard.press("Enter"); }
      else await trigger.click();
      await page.waitForFunction(() => document.querySelector(".context-occupancy-popover")?.matches(":popover-open"));
      await page.waitForFunction(() => document.querySelector(".context-occupancy-trigger")?.getAttribute("aria-expanded") === "true");
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      assert.equal(await popover.getAttribute("popover"), "auto");
      assert.equal(await popover.getAttribute("role"), "dialog");
    }
    async function closePopover() {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".context-occupancy-popover")?.matches(":popover-open"));
      await page.waitForFunction(() => document.querySelector(".context-occupancy-trigger")?.getAttribute("aria-expanded") === "false");
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    }
    await page.goto(hostUrl);
    assert.equal(await trigger.count(), 0, "the new-session page has no existing context usage");
    await selectSession(knownId);
    await waitForKnown();
    const card = await page.locator(".composer-card").boundingBox(), meter = await trigger.boundingBox();
    assert.ok(card && meter && meter.y >= card.y + card.height - 1, "context usage sits beneath the input card");
    await page.locator("#wish-composer").fill("切换上下文详情时保留的草稿");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".context-occupancy-popover")?.matches(":popover-open"));
    for (const label of ["系统提示词", "工具定义", "对话消息"]) assert.ok((await popover.textContent()).includes(label));
    assert.match(await popover.locator(".context-occupancy-total").textContent(), /~/u);
    assert.match(await popover.locator(".context-occupancy-total").getAttribute("title"), /32,000\s*\/\s*128,000/u);
    await closePopover();
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true, "Escape restores the trigger's keyboard focus");
    await openPopover();
    await page.locator("#wish-composer").click();
    await page.waitForFunction(() => !document.querySelector(".context-occupancy-popover")?.matches(":popover-open"));
    assert.equal(await page.locator("#wish-composer").inputValue(), "切换上下文详情时保留的草稿");

    const captures = [];
    for (const [device, viewport] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      for (const theme of ["light", "dark"]) {
        // Apply a visual theme fixture. Settings persistence has separate coverage.
        await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
        await openPopover(true);
        const geometry = await page.evaluate(() => {
          const box = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
          const node = document.querySelector(".context-occupancy-popover"), style = getComputedStyle(node);
          const trigger = document.querySelector(".context-occupancy-trigger"), triggerStyle = getComputedStyle(trigger);
          return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
            trigger: box(".context-occupancy-trigger"), popover: box(".context-occupancy-popover"), composer: box(".composer-card"),
            focusVisible: trigger.matches(":focus-visible"), focusExtent: parseFloat(triggerStyle.outlineWidth) + Math.max(0, parseFloat(triggerStyle.outlineOffset)),
            color: style.color, background: style.backgroundColor, boxShadow: style.boxShadow,
            popoverScrollWidth: node.scrollWidth, popoverClientWidth: node.clientWidth };
        });
        const { popover: bounds } = geometry;
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${device}/${theme} detail must fit the viewport`);
        assert.ok(geometry.documentWidth <= viewport.width + 1, `${device}/${theme} must not overflow horizontally`);
        assert.ok(geometry.popoverScrollWidth <= geometry.popoverClientWidth + 1, `${device}/${theme} detail text must wrap`);
        assert.ok(geometry.trigger.y + geometry.trigger.height <= viewport.height + 1, `${device}/${theme} meter remains visible`);
        assert.equal(geometry.focusVisible, true, `${device}/${theme} keyboard interaction must show the focus indicator`);
        const { trigger: focus, focusExtent } = geometry;
        assert.ok(focus.x - focusExtent >= 0 && focus.y - focusExtent >= 0 &&
          focus.x + focus.width + focusExtent <= viewport.width && focus.y + focus.height + focusExtent <= viewport.height,
        `${device}/${theme} must keep the complete keyboard focus outline inside the viewport`);
        assert.equal(geometry.boxShadow, "none", "context detail follows the flat workbench surface");
        const filename = theme === "light" ? `${device}.png` : `${device}-dark.png`;
        await page.screenshot({ path: join(artifacts, filename), fullPage: true });
        captures.push({ device, theme, filename, ...geometry });
        await closePopover();
      }
    }
    assert.notEqual(captures[0].background, captures[1].background, "the native popover follows explicit light and dark themes");

    const unknownResponse = page.waitForResponse(response => response.url().includes(`/${unknownId}/controls/context-occupancy`));
    await selectSession(unknownId);
    await unknownResponse;
    assert.equal(await trigger.count(), 0, "unknown usage is hidden instead of appearing as zero or the previous session");
    await selectSession(delayedId);
    await waitingForDelayed;
    assert.equal(await trigger.count(), 0, "a newly selected session cannot display the previous session's estimate while loading");
    await selectSession(unknownId);
    releaseDelayed(); releaseDelayed = undefined;
    await waitingForDelayedFulfilled;
    await page.waitForFunction(() => !document.querySelector(".context-occupancy-trigger"));
    await selectSession(knownId);
    await waitForKnown();
    assert.equal(await page.locator("#wish-composer").inputValue(), "切换上下文详情时保留的草稿");

    // Exercise the actual Host lifecycle gate, keeping the numeric fixture in
    // place to prove that a response alone cannot keep a removed UI seat alive.
    await page.setViewportSize({ width: 1280, height: 800 });
    async function openPluginManagement() {
      await page.getByRole("button", { name: "设置与插件", exact: true }).click();
      await page.getByRole("button", { name: "插件管理", exact: true }).click();
    }
    await openPluginManagement();
    let row = page.locator(`[data-entry-id="${entryId}"]`);
    await row.getByRole("button", { name: `停用 ${entryId}`, exact: true }).click();
    await row.getByRole("button", { name: `启用 ${entryId}`, exact: true }).waitFor();
    assert.equal((await fetch(controlUrl)).status, 404, "disabling the owner removes the real Host control");
    await page.getByRole("button", { name: "会话", exact: true }).click();
    await selectSession(knownId);
    assert.equal(await trigger.count(), 0, "disabled owner retracts the Browser seat even with an estimated fixture response");
    await openPluginManagement();
    row = page.locator(`[data-entry-id="${entryId}"]`);
    await row.getByRole("button", { name: `启用 ${entryId}`, exact: true }).click();
    await row.getByRole("button", { name: `停用 ${entryId}`, exact: true }).waitFor();
    assert.equal((await fetch(controlUrl)).status, 200, "enabling the owner restores the real Host control");
    await page.getByRole("button", { name: "会话", exact: true }).click();
    await selectSession(knownId);
    await waitForKnown();
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(unexpectedRequests, [], "this acceptance must not contact an external provider or network origin");
    await writeFile(join(artifacts, "context-occupancy-browser.json"), `${JSON.stringify({
      scope: "real isolated Host + Chromium; occupancy numbers are browser fixtures; no provider Run", hostControl: { status: liveResponse.status, value: live.value },
      browser: browser.version(), captures, requestedSessions, errors, consoleErrors, unexpectedRequests,
      checks: ["native-popover", "keyboard-enter-escape-focus", "complete-focus-outline", "outside-dismiss", "draft-preserved", "unknown-hidden", "session-isolation", "real-owner-disable-enable", "no-horizontal-overflow"],
    }, null, 2)}\n`);
  } finally {
    releaseDelayed?.();
    await browser?.close();
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
