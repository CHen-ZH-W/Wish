import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const repository = fileURLToPath(new URL("..", import.meta.url));
// Production Skills views, client model and Shell; deterministic control/query
// responses stand in for the Host. This fixture creates no Session service.
const entry = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { SnapshotStore } from "./src/apps/webui/client/model/store.ts";
import { UiSlots } from "./src/apps/webui/client/slots.ts";
import { Shell } from "./src/apps/webui/client/ui/shell.tsx";
import { SkillsClientUi } from "./src/skills/consumers/webui/index.tsx";

const skills = [
  { packageId: "memory:memory-guide", name: "memory-guide", description: "检查项目入口、运行链路、依赖和验证方式，整理可复用的只读分析流程。保留来源依据，区分当前验证与历史经验，并完整交付分析结论。", source: "memory", digest: "workspace-v1", modelInvocable: true },
  { packageId: "user:user-guide", name: "user-guide", description: "用户目录中的手动参考说明", source: "user", digest: "user-v1", modelInvocable: false },
];
const contents = new Map([
  ["memory-guide", "---\nname: memory-guide\ndescription: 记忆生成的审阅说明\n---\n# 记忆审阅\n\n先检查改动，再记录验证结果。\n\n" + "long-resource-path/".repeat(28)],
  ["user-guide", "# 用户参考\n\n保留用户已有 Skill。"],
]);
let revision = 1, failNext = false;
const calls = [], removers = [];
function catalog() { return { schemaVersion: 1, workspace: { root: "/fixture/wish", fingerprint: "fixture-workspace", revision: "workspace-v1" },
  catalogDigest: "catalog-" + revision, skills: [...skills], issues: [], import: { maxFiles: 100, maxFileBytes: 200000, maxPackageBytes: 1000000 } }; }
class Connection extends SnapshotStore {
  constructor() { super({ online: true, businessAvailable: true, instanceId: "skills-fixture", error: null }); }
  invalidations = new Set();
  onInvalidation(callback) { this.invalidations.add(callback); return () => this.invalidations.delete(callback); }
  invalidate() { for (const callback of this.invalidations) callback(); }
  async request(path, body) {
    calls.push({ path, body });
    if (path === "/api/queries/skills/default") {
      const skill = skills.find(item => item.name === body.name);
      if (!skill || body.expectedDigest !== skill.digest || body.expectedPackageId !== skill.packageId) throw Error("skill_selection_stale");
      return { value: { schemaVersion: 1, entry: skill, content: contents.get(skill.name) } };
    }
    if (path !== "/api/controls/skills/default") throw Error("Unexpected fixture endpoint " + path);
    if (!body) return { value: catalog() };
    if (failNext) { failNext = false; throw Error("fixture_import_failed"); }
    if (body.expectedCatalogDigest !== "catalog-" + revision) throw Error("skill_catalog_changed");
    if (body.action === "set-enabled") {
      const index = skills.findIndex(item => item.name === body.name && item.packageId === body.expectedPackageId && item.digest === body.expectedDigest);
      if (index < 0) throw Error("skill_changed");
      skills[index] = { ...skills[index], enabled: body.enabled }; revision++;
      return { value: { schemaVersion: 1, entry: skills[index], catalog: catalog() } };
    }
    const file = body.files.find(item => item.path === "SKILL.md" || item.path.endsWith("/SKILL.md"));
    if (!file) throw Error("skill_import_missing_document");
    const name = /^name:\s*(.+)$/m.exec(file.content)?.[1]?.trim();
    if (!name) throw Error("skill_import_invalid_document");
    const existing = skills.findIndex(item => item.name === name);
    if (existing >= 0 && !body.overwrite) throw Error("skill_import_exists");
    const imported = { packageId: "user:" + name, name, description: "从本地文件导入的操作说明", source: "user", digest: name + "-v" + ++revision, modelInvocable: true };
    if (existing < 0) skills.push(imported); else skills.splice(existing, 1, imported);
    contents.set(name, file.content);
    return { value: { schemaVersion: 1, catalog: catalog(), imported } };
  }
}
const connection = new Connection(), slots = new UiSlots();
const ctx = { wishConnection: connection, wishUiSlots: slots,
  effect(action) { const remove = action(); if (typeof remove === "function") removers.push(remove); } };
SkillsClientUi.apply(ctx); slots.openPanel("skills");
const root = createRoot(document.getElementById("root")); root.render(<Shell slots={slots} connection={connection} />);
window.fixture = { calls, invalidate() { connection.invalidate(); }, failImport() { failNext = true; },
  close() { root.unmount(); for (const remove of removers.reverse()) remove(); } };
`;

const result = await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "skills-library-fixture.tsx", loader: "tsx" },
  absWorkingDir: repository, bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
const bundle = result.outputFiles[0].text;

if (process.argv.includes("--build-only")) {
  console.log("Skills library Browser fixture bundled; no Browser interactions were run.");
} else for (const width of [1920, 1440, 390]) test(`independent Skills library browses and imports local files at ${width}px`, { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-skills-browser-"));
  const artifacts = resolve(process.env.WISH_BROWSER_ARTIFACT_DIR ?? "/tmp/wish-skills-library-review");
  let browser, page;
  try {
    const skillDirectory = join(directory, "imported-guide");
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await mkdir(artifacts, { recursive: true });
    const markdown = "---\nname: imported-guide\ndescription: 导入本地说明及参考文件\n---\n# 已导入的说明\n\n参考 references/checklist.md 完成验收。\n";
    await writeFile(join(skillDirectory, "SKILL.md"), markdown);
    await writeFile(join(skillDirectory, "references", "checklist.md"), "# 检查单\n\n保留相对目录。\n");
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10_000);
    const errors = [], consoleErrors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    const css = (await Promise.all([
      readFile(new URL("../src/apps/webui/public/app.css", import.meta.url), "utf8"),
      readFile(new URL("../src/skills/consumers/webui/style.css", import.meta.url), "utf8"),
    ])).join("\n");
    await page.setContent('<!doctype html><html lang="zh-CN"><style>' + css + '</style><div id="root"></div></html>');
    await page.addScriptTag({ content: bundle });
    await page.getByRole("heading", { name: "Skills", exact: true, level: 1 }).waitFor();
    const library = await page.locator(".skill-library").evaluate(node => {
      const description = node.querySelector(".skill-library-copy>span"), row = node.querySelector(".skill-library-row");
      const main = row.querySelector(".skill-library-item").getBoundingClientRect(), toggle = row.querySelector(".skill-toggle").getBoundingClientRect();
      return { width: node.getBoundingClientRect().width, descriptionHeight: description.clientHeight, descriptionScrollHeight: description.scrollHeight,
        mainRight: main.right, mainBottom: main.bottom, toggleLeft: toggle.left, toggleTop: toggle.top };
    });
    assert.ok(library.descriptionScrollHeight <= library.descriptionHeight + 1, "Skill descriptions remain fully visible");
    if (width <= 720) assert.ok(library.toggleTop >= library.mainBottom, "narrow layouts give actions their own row");
    else assert.ok(library.toggleLeft >= library.mainRight, "wide layouts keep actions beside the content");
    assert.equal(await page.getByText("请先在会话区选择或创建会话。", { exact: true }).count(), 0);
    if (!await page.locator("#wish-sidebar").isVisible()) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page.locator("#wish-sidebar").getByRole("button", { name: /memory-guide/u }).click();
    await page.getByRole("heading", { name: "memory-guide", exact: true }).waitFor();
    assert.match(await page.locator(".skill-markdown").textContent(), /先检查改动，再记录验证结果/u);
    assert.equal(await page.getByText("工作区来源", { exact: true }).count(), 0);
    const activation = page.getByRole("switch", { name: "启用 memory-guide", exact: true });
    await activation.click();
    await page.waitForFunction(() => document.querySelector('.skill-toggle[aria-checked="false"]'));
    assert.equal(await activation.getAttribute("aria-checked"), "false");
    assert.match(await page.locator(".skill-markdown").textContent(), /先检查改动/u);
    await activation.click();
    await page.waitForFunction(() => !document.querySelector('.skill-toggle[aria-checked="false"]'));
    assert.equal(await activation.getAttribute("aria-checked"), "true");

    async function capture(name, theme = "light") {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      const geometry = await page.evaluate(() => {
        const page = document.querySelector(".skills-page"), style = getComputedStyle(page);
        const contentWidth = page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const widths = Object.fromEntries([".skill-content", ".skill-markdown", ".skill-markdown p", ".skill-source", ".skill-import:not([hidden])"]
          .flatMap(selector => { const node = page.querySelector(selector); return node ? [[selector, node.getBoundingClientRect().width]] : []; }));
        return { documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth,
          background: style.backgroundColor, pageWidth: page.getBoundingClientRect().width,
          mainWidth: document.querySelector(".workspace-content").clientWidth, contentWidth, widths };
      });
      assert.ok(geometry.documentWidth <= width + 1, "Skills never creates page-level horizontal overflow");
      assert.ok(Math.abs(geometry.pageWidth - geometry.mainWidth) <= 1, "Skills uses the full main area");
      for (const [selector, actual] of Object.entries(geometry.widths)) assert.ok(Math.abs(actual - geometry.contentWidth) <= 1,
        `${selector} uses all available content width: ${actual} / ${geometry.contentWidth}`);
      assert.ok(Math.abs(library.width - geometry.contentWidth) <= 1, "the Skill library uses the same full width as its documents");
      await page.screenshot({ path: join(artifacts, `${width}-${name}${theme === "dark" ? "-dark" : ""}.png`), fullPage: true });
      return geometry;
    }
    const captures = [await capture("browse"), await capture("browse", "dark")];
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
    const directoryChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await (await directoryChooser).setFiles(skillDirectory);
    await page.getByRole("button", { name: "开始导入", exact: true }).waitFor();
    await page.evaluate(() => window.fixture.failImport());
    await page.getByRole("button", { name: "开始导入", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /fixture_import_failed/u }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始导入", exact: true }).isDisabled(), true, "failed authority revokes admission until a fresh catalog is read");
    assert.equal(await page.getByRole("checkbox", { name: "覆盖 Wish 中同名的导入 Skill", exact: true }).isChecked(), false);
    await page.evaluate(() => window.fixture.invalidate());
    await page.getByRole("button", { name: "开始导入", exact: true }).click({ trial: true });
    captures.push(await capture("import-retry"));
    await page.getByRole("button", { name: "开始导入", exact: true }).click();
    await page.getByRole("heading", { name: "imported-guide", exact: true }).waitFor();
    assert.match(await page.locator(".skill-markdown").textContent(), /已导入的说明/u);
    const writes = await page.evaluate(() => window.fixture.calls.filter(call => call.path === "/api/controls/skills/default" && call.body && call.body.action !== "set-enabled"));
    assert.equal(writes.length, 2); assert.equal(writes[0].body.overwrite, false); assert.equal(writes[1].body.overwrite, false);
    assert.equal(writes[0].body.expectedCatalogDigest, "catalog-3");
    assert.deepEqual(writes[1].body.files.map(file => file.path).sort(), ["imported-guide/SKILL.md", "imported-guide/references/checklist.md"]);
    assert.equal(writes[1].body.files.find(file => file.path.endsWith("/SKILL.md")).content, markdown);
    captures.push(await capture("imported"));

    await page.getByRole("button", { name: "收起导入", exact: true }).click();
    await page.getByRole("button", { name: "导入 Skill", exact: true }).click();
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "选择 SKILL.md", exact: true }).click();
    await (await fileChooser).setFiles(join(skillDirectory, "SKILL.md"));
    await page.getByRole("button", { name: "开始导入", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /同名|skill_import_exists/u }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "覆盖 Wish 中同名的导入 Skill", exact: true }).isChecked(), false);
    await page.getByRole("checkbox", { name: "覆盖 Wish 中同名的导入 Skill", exact: true }).check();
    await page.evaluate(() => window.fixture.invalidate());
    await page.getByRole("button", { name: "开始导入", exact: true }).click();
    await page.waitForFunction(() => window.fixture.calls.some(call => call.path === "/api/queries/skills/default" && call.body?.expectedDigest === "imported-guide-v5"));
    await page.getByRole("heading", { name: "imported-guide", exact: true }).waitFor();
    const allCalls = await page.evaluate(() => window.fixture.calls);
    const finalWrite = allCalls.filter(call => call.path === "/api/controls/skills/default" && call.body && call.body.action !== "set-enabled").at(-1);
    assert.equal(finalWrite.body.overwrite, true, "replacement requires an explicit checkbox selection");
    assert.equal(finalWrite.body.expectedCatalogDigest, "catalog-4");
    assert.ok(allCalls.every(call => !call.path.includes("/sessions/")));
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(join(artifacts, `${width}-browser.json`), JSON.stringify({ scope: "production Shell and Skills client; deterministic Host transport; real local file chooser; no Session and no Provider", captures, errors, consoleErrors, calls: allCalls }, null, 2) + "\n");
  } catch (error) {
    if (page) await page.screenshot({ path: join(artifacts, `${width}-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { await page?.evaluate(() => window.fixture?.close()).catch(() => {}); await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
