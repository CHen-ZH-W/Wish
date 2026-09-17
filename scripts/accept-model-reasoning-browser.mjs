import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("product Browser selects and restores Session reasoning without refreshing the conversation", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-reasoning-browser-"));
  let booted, browser;
  try {
    booted = await bootstrap({
      surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    const sessions = booted.surfaceContext.get("sessions").manager;
    const agentId = booted.surfaceContext.get("agents").agentId;
    await sessions.create({ sessionId: "reasoning-session", agentId, scope: directory });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.get("webManagementHost").url);
    const selector = page.getByRole("combobox", { name: "下次运行的思考强度" });
    await selector.waitFor();
    await page.waitForFunction(() => !document.querySelector("#wish-reasoning-effort")?.disabled);
    assert.equal(await selector.inputValue(), "high");
    assert.equal(await selector.locator('option[value="default"]').count(), 0);
    const card = await page.locator(".composer-card").boundingBox(), effortBox = await selector.boundingBox(), sendBox = await page.locator(".composer-send").boundingBox();
    assert.ok(card && effortBox && sendBox && effortBox.x >= card.x && effortBox.y >= card.y &&
      sendBox.x + sendBox.width <= card.x + card.width && sendBox.y + sendBox.height <= card.y + card.height,
    "existing Session keeps effort and send inside one composer card");
    const composerSurfaces = await page.evaluate(() => {
      const root = document.documentElement, original = root.getAttribute("data-theme");
      const read = () => {
        const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
        return {
          page: color(".workspace-main"), dock: color(".composer"), card: color(".composer-card"),
          input: color("#wish-composer"), actions: color(".composer-card .composer-actions"),
          effort: color("#wish-reasoning-effort"),
        };
      };
      root.setAttribute("data-theme", "light"); const light = read();
      root.setAttribute("data-theme", "dark"); const dark = read();
      if (original === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", original);
      return { light, dark };
    });
    for (const [theme, surface] of Object.entries(composerSurfaces)) {
      assert.equal(surface.dock, "rgba(0, 0, 0, 0)", `${theme} composer dock must expose the conversation background`);
      assert.equal(surface.input, "rgba(0, 0, 0, 0)", `${theme} text field must share the card surface`);
      assert.equal(surface.actions, "rgba(0, 0, 0, 0)", `${theme} action row must share the card surface`);
      assert.equal(surface.effort, "rgba(0, 0, 0, 0)", `${theme} reasoning selector must not introduce a second surface`);
      assert.notEqual(surface.card, "rgba(0, 0, 0, 0)", `${theme} composer card owns the only surface`);
    }
    assert.equal(composerSurfaces.light.card, composerSurfaces.light.page, "light card separates from the page by elevation");
    assert.notEqual(composerSurfaces.dark.card, composerSurfaces.dark.page, "dark card uses an elevated surface");
    await page.locator("#wish-composer").fill("草稿不会因为切换思考强度而消失");
    await selector.selectOption("low");
    await page.waitForFunction(() => document.querySelector("#wish-reasoning-effort")?.value === "low" && !document.querySelector("#wish-reasoning-effort")?.disabled);
    assert.equal(await page.locator("#wish-composer").inputValue(), "草稿不会因为切换思考强度而消失");
    const selected = await page.evaluate(async () => (await (await fetch("/api/sessions/reasoning-session/model-reasoning")).json()).selection);
    assert.equal(selected.selected, "low");
    await selector.selectOption("high");
    await page.waitForFunction(async () => (await (await fetch("/api/sessions/reasoning-session/model-reasoning")).json()).selection.selected === undefined);
    assert.equal(await selector.inputValue(), "high", "returning to the model default removes the override without an extra option");
    await selector.selectOption("low");
    await page.waitForFunction(async () => (await (await fetch("/api/sessions/reasoning-session/model-reasoning")).json()).selection.selected === "low");
    await page.reload();
    await selector.waitFor();
    await page.waitForFunction(() => document.querySelector("#wish-reasoning-effort")?.value === "low");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
