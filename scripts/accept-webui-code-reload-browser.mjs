import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const repository = dirname(dirname(fileURLToPath(import.meta.url))), execute = promisify(execFile);
async function capture(page, name) {
  const directory = process.env.WISH_WEBUI_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
    notice: [...document.querySelectorAll(".connection-notice")].map(node => ({ text: node.textContent, height: node.getBoundingClientRect().height })) }));
  assert.equal(metrics.overflow, false); await writeFile(join(directory, `${name}.json`), JSON.stringify(metrics, null, 2));
}

async function createDefaultSession(page) {
  await page.locator(".empty-state").getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByRole("heading", { name: "许个愿吧", exact: true }).waitFor();
  await page.locator('.workspace-choice input[type="radio"]').first().check();
  await page.getByRole("button", { name: "创建会话", exact: true }).click();
  await page.locator("#wish-composer").waitFor();
}

test("real module builds hot-replace Browser plugins without losing Session, draft or Host authority", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-browser-code-reload-"));
  let booted, browser;
  try {
    for (const path of ["src", "dist", "scripts/build-webui-client.mjs"]) await cp(join(repository, path), join(directory, path), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const build = () => execute(process.execPath, ["scripts/build-webui-client.mjs"], { cwd: directory, maxBuffer: 1024 * 1024 });
    const manifestFile = join(directory, "dist/apps/webui/public/ui-modules.json");
    const manifest = async () => JSON.parse(await readFile(manifestFile, "utf8"));
    // Establish the build in this relocated checkout (esbuild resolves shared
    // package paths through the fixture's node_modules symlink).
    await build();
    const before = await manifest();
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")).href);
    const { managedWebUi } = await import(pathToFileURL(join(directory, "dist/apps/webui/host/composition.js")).href);
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MEMORY_ENABLED: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const base = booted.context.get("webManagementHost").url;
    const capturedSkills = booted.context.loader.resolve("include:skills-local").fiber;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], documents = [], resources = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { resources.push(request.url()); if (request.isNavigationRequest()) documents.push(request.url()); });
    await page.goto(base);
    await createDefaultSession(page);
    await page.locator("#wish-composer").fill("代码更新后仍要保留的草稿");
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("heading", { name: "Skills", exact: true }).waitFor();
    await page.evaluate(() => { window.uiAcceptanceIdentity = crypto.randomUUID(); });
    const identity = await page.evaluate(() => window.uiAcceptanceIdentity);
    const sessions = await booted.surfaceContext.get("sessions").manager.list();
    assert.equal(sessions.length, 1);
    assert.equal(typeof sessions[0].sessionId, "string");
    assert.equal(resources.some(url => url.includes("/modules/MemoryClientUi-")), false, "disabled business UI code is not imported");

    const moduleFile = join(directory, "src/skills/consumers/webui/index.tsx"), original = await readFile(moduleFile, "utf8");
    const updated = original.replace('View: () => <SkillsPage model={model} />', 'View: () => <section><h1>Skills 界面已更新</h1></section>');
    assert.notEqual(updated, original); await writeFile(moduleFile, updated); await build();
    const next = await manifest();
    assert.equal(next.core, before.core, "a module-only edit must not change the shared/core runtime");
    assert.notEqual(next.modules.find(item => item.id === "SkillsClientUi").url, before.modules.find(item => item.id === "SkillsClientUi").url);
    assert.deepEqual(next.modules.filter(item => item.id !== "SkillsClientUi"), before.modules.filter(item => item.id !== "SkillsClientUi"));
    await page.getByRole("heading", { name: "Skills 界面已更新", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Skills", exact: true }).getAttribute("aria-current"), "page", "selected panel survives its seat replacement");
    assert.equal(booted.context.loader.resolve("include:skills-local").fiber, capturedSkills, "UI-only code changes do not replace Host capability");
    assert.equal(await page.evaluate(() => window.uiAcceptanceIdentity), identity);

    // Failed compilation does not publish a partly built release or destroy old assets.
    const validManifest = await readFile(manifestFile, "utf8");
    await writeFile(moduleFile, `${updated}\nconst invalid = ;`); await assert.rejects(build());
    assert.equal(await readFile(manifestFile, "utf8"), validManifest);
    assert.equal((await fetch(base + before.modules.find(item => item.id === "SkillsClientUi").url)).status, 200);

    await writeFile(moduleFile, `${updated}\nthrow new Error("fixture import failure");`); await build();
    await page.getByText(/SkillsClientUi 界面更新失败/).waitFor();
    await page.getByRole("heading", { name: "Skills 界面已更新", exact: true }).waitFor();
    await capture(page, "desktop-ui-module-failure");
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-ui-module-failure");
    await page.setViewportSize({ width: 1440, height: 900 });
    await writeFile(moduleFile, updated.replace("apply(ctx: Context) {", 'apply(ctx: Context) { throw new Error("fixture activation failure");'));
    await build();
    const failedActivation = (await manifest()).modules.find(item => item.id === "SkillsClientUi").url;
    await page.waitForFunction(url => performance.getEntriesByType("resource").some(entry => entry.name.endsWith(url)), failedActivation);
    await page.getByRole("heading", { name: "Skills 界面已更新", exact: true }).waitFor();

    // Host stop withdraws both the actual capability and its UI, even after update failure.
    const change = async preference => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const snapshot = booted.pluginManagement.snapshot();
        const result = await booted.pluginManagement.change({ requestId: crypto.randomUUID(), revision: snapshot.revision, preference,
          selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:skills-local"] } });
        if (result.status === "succeeded") return;
        // A live UI read can prevent stop. Explicitly retry after it finishes;
        // never bypass the admission fence or turn the request into a code update.
        assert.equal(result.code, "stop_lifecycle_blocked", JSON.stringify(result));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail("Host stop remained blocked after current observations finished");
    };
    await change("disabled"); await page.getByRole("button", { name: "Skills", exact: true }).waitFor({ state: "detached" });
    assert.equal(booted.surfaceContext.get("skills"), undefined);
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.locator("#wish-composer").waitFor(); assert.equal(await page.locator("#wish-composer").inputValue(), "代码更新后仍要保留的草稿");
    await writeFile(moduleFile, updated); await build(); await change("enabled");
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("heading", { name: "Skills 界面已更新", exact: true }).waitFor();
    await page.getByText(/SkillsClientUi 界面更新失败/).waitFor({ state: "detached" });

    const brokenView = updated.replace('View: () => <section><h1>Skills 界面已更新</h1></section>', 'View: () => { throw new Error("fixture render failure"); }');
    assert.notEqual(brokenView, updated); await writeFile(moduleFile, brokenView); await build();
    await page.getByRole("alert").filter({ hasText: "此视图暂时无法显示" }).waitFor();
    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("button", { name: "插件管理", exact: true }).click();
    await page.getByRole("heading", { name: "插件管理", exact: true }).waitFor();
    await writeFile(moduleFile, updated); await build();
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("heading", { name: "Skills 界面已更新", exact: true }).waitFor();
    await page.getByRole("alert").filter({ hasText: "此视图暂时无法显示" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "执行工作区", exact: true }).click();
    await page.locator("#wish-composer").waitFor(); assert.equal(await page.locator("#wish-composer").inputValue(), "代码更新后仍要保留的草稿");

    // A core edit is deliberately not an automatic page reload.
    const mainFile = join(directory, "src/apps/webui/client/main.tsx");
    await writeFile(mainFile, (await readFile(mainFile, "utf8")) + '\nconsole.info("fixture new core");'); await build();
    assert.notEqual((await manifest()).core, before.core);
    await page.getByText(/界面基础代码已更新/).waitFor();
    const coreAfterCodeEdit = (await manifest()).core, cssFile = join(directory, "src/apps/webui/public/app.css");
    await writeFile(cssFile, (await readFile(cssFile, "utf8")) + '\n/* shared stylesheet update fixture */'); await build();
    assert.notEqual((await manifest()).core, coreAfterCodeEdit, "shared CSS changes must also request a deliberate refresh");
    assert.equal(await page.evaluate(() => window.uiAcceptanceIdentity), identity);
    assert.equal(await page.locator("#wish-composer").inputValue(), "代码更新后仍要保留的草稿");
    assert.equal(documents.length, 1);
    assert.deepEqual((await booted.surfaceContext.get("sessions").manager.list()).map(item => item.sessionId), sessions.map(item => item.sessionId));
    assert.ok(errors.every(error => error.includes("fixture render failure")), JSON.stringify(errors));
    for (const path of ["/assets/modules/missing-AAAAAAAA.js", "/assets/modules/%2e%2e%2fserver.js", "/assets/modules/SkillsClientUi.js"]) assert.equal((await fetch(base + path)).status, 404);
    const head = await fetch(base + before.core, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.match(head.headers.get("content-security-policy"), /script-src 'self'/); assert.equal(head.headers.get("x-content-type-options"), "nosniff");
  } finally { await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
