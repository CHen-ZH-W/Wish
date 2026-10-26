import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
const captureDirectory = process.env.WISH_DEVELOPMENT_CAPTURE_DIR ?? "/tmp/wish-development-browser";
const current = project => project.changes.find(item => item.id === project.activeChangeId) ?? project.changes.at(-1);
const rawWish = "给这个本地项目加一个内容检查功能，保留现有文件，并说明验证结果。";
const checkSource = "const fs = require('node:fs'); if (fs.readFileSync('preserved.txt', 'utf8') !== 'existing user content\\n') process.exit(1); process.stdout.write('Existing data verified\\n');\n";
const spec = {
  objective: "浏览器验收样例：增加本地内容检查，保留已有数据", scope: ["增加本地检查脚本，读取文件并验证已有内容"], outOfScope: ["外部模型、公开部署与联网服务"], constraints: ["保留用户已有内容"],
  criteria: [{ id: "preserve", text: "已有文件内容保持不变", kind: "technical" }, { id: "explain", text: "交付说明清楚，能够继续提出修改", kind: "user" }],
  questions: [], assumptions: [], decisions: ["使用本地确定性模型夹具"], planMarkdown: "先确认目标与范围，再读取文件并核对保留情况。此样例用于浏览器验收。",
  assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "增加一个可逆的本地检查脚本" },
};

async function capture(page, name, resetScroll = true) {
  if (resetScroll) await page.locator(".development-conversation-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(captureDirectory, `${name}.png`), fullPage: true });
  const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
    controls: [...document.querySelectorAll(".development-conversation-card button,.development-conversation-card summary")].filter(node => node.getBoundingClientRect().height > 0).map(node => {
      const box = node.getBoundingClientRect(), css = getComputedStyle(node);
      return { label: node.textContent?.trim().slice(0, 90), x: box.x, y: box.y, width: box.width, height: box.height, disabled: node.disabled, color: css.color, background: css.backgroundColor, outline: css.outlineStyle };
    }) }));
  assert.equal(metrics.overflow, false, `${name}: no horizontal viewport overflow`);
  await writeFile(join(captureDirectory, `${name}.json`), JSON.stringify(metrics, null, 2));
}

test("ordinary conversation carries discovery, inline exact approval and retained workspace delivery", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-development-browser-"));
  const workspace = join(directory, "workspace");
  let booted, browser, development, providerRequests = 0, providerFailure;
  const calls = [];
  const provider = createServer((incoming, response) => {
    incoming.resume(); incoming.on("end", async () => {
      providerRequests++;
      try {
        const project = (await development.list())[0], change = project && current(project), proposal = change?.specs.at(-1), confirmation = change?.confirmations.at(-1);
        let name, input;
        if (!project) { name = "wish_begin"; input = { rawWish }; }
        else if (!proposal) { name = "wish_propose"; input = { expectedRevision: project.revision, spec }; }
        else if (change.phase === "running") {
          if (await readFile(join(workspace, "check.cjs"), "utf8").catch(() => null) === null) { name = "write"; input = { path: "check.cjs", content: checkSource }; }
          else if (!change.verifications.length) { name = "wish_verify"; input = { expectedRevision: project.revision, executionEpoch: change.executionEpoch, confirmationDigest: confirmation.digest, command: "node check.cjs", timeout: 10, criterionIds: ["preserve"] }; }
          else { name = "wish_report"; input = { expectedRevision: project.revision, executionEpoch: change.executionEpoch, confirmationDigest: confirmation.digest, summary: "浏览器样例：已新增本地检查脚本，实际验证保留原有文件内容。", limitations: ["本地确定性模型，不代表外部模型表现。"], nextSteps: ["直接在当前对话提出下一项修改。"] }; }
        }
        if (name) calls.push(name);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = name ? { tool_calls: [{ index: 0, id: `browser-development-${providerRequests}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } : { content: "已在当前对话整理目标与方案，等待你核对；实施完成后会在这里交付。" };
        response.end(`data: ${JSON.stringify({ id: "browser-development-fixture", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
      } catch (error) { providerFailure = error; response.writeHead(500); response.end(String(error)); }
    });
  });
  try {
    await mkdir(workspace); await mkdir(captureDirectory, { recursive: true });
    await writeFile(join(workspace, "preserved.txt"), "existing user content\n");
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    const configuration = { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
      providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native", models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
    booted = await bootstrap({ surface: "webui", cwd: workspace, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: workspace, WISH_MODELS_JSON: JSON.stringify(configuration), WISH_PERMISSION_PROFILE: "full-access", WISH_SHELL_PROVIDER: "host", WISH_SHELL_HOST_ENABLED: "1" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    development = booted.surfaceContext.get("wishDevelopment");
    assert.ok(development, "The actual WebUI Cordis graph activates wishDevelopment");
    const applicationOwner = booted.surfaceContext.get("application");
    assert.ok(applicationOwner, "The graph provides the shared Application owner");
    const application = await applicationOwner.open();
    await application.createSession({ sessionId: "browser-development-owner", workspaceRoot: workspace, title: "愿望浏览器验收会话" });
    const errors = [];
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    const base = booted.context.get("webManagementHost").url;
    await page.goto(base);
    assert.equal(await page.locator(".utility-rail").getByRole("button", { name: "愿望开发", exact: true }).count(), 0);
    await openSession(page, "愿望浏览器验收会话");
    await page.locator("#wish-composer").fill(rawWish);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const approve = page.getByRole("button", { name: "查看方案并确认", exact: true });
    await approve.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "查看方案并确认" && !button.disabled));
    let project = (await development.list())[0];
    const savedSpec = current(project).specs.at(-1);
    assert.deepEqual(calls, ["wish_begin", "wish_propose"], "ordinary chat naturally opens read-only discovery and saves its proposal");
    assert.equal(await readFile(join(workspace, "check.cjs"), "utf8").catch(() => null), null, "discovery does not implement the feature");
    assert.equal(await page.locator(".development-conversation-card > details[open]").count(), 0, "the conversation starts with a compact disclosure");
    assert.equal(await page.locator(".development-page,.development-navigation,.development-wish-form").count(), 0);
    await capture(page, "desktop-proposal");
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-proposal");
    await page.setViewportSize({ width: 1440, height: 900 });
    await approve.click();
    const confirm = page.getByRole("button", { name: "确认并开始", exact: true });
    await confirm.waitFor(); await confirm.focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    assert.equal(await confirm.evaluate(node => node.matches(":focus-visible")), true);
    await capture(page, "desktop-confirmation");
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-confirmation");
    await page.setViewportSize({ width: 1440, height: 900 });
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/controls/wish-development") && response.request().method() === "POST");
    await confirm.click();
    const controlResponse = await responsePromise;
    assert.equal(controlResponse.status(), 200, await controlResponse.text());
    const accepted = (await controlResponse.json()).value;
    assert.ok(accepted.runId, "UI approval returns the real Application Run identity");
    assert.equal(current(accepted.project).confirmations.at(-1).specDigest, savedSpec.digest);
    await page.waitForFunction(() => document.querySelector("[data-development-phase=review]"));
    const runs = await (await fetch(`${base}/api/sessions/browser-development-owner/runs`)).json();
    assert.ok(runs.runs.some(run => run.runId === accepted.runId), "the product-started Run is visible in the ordinary WebUI Run ledger");
    assert.deepEqual(calls, ["wish_begin", "wish_propose", "write", "wish_verify", "wish_report"]);
    await page.locator(".development-delivery > summary").click();
    await page.locator(".development-delivery").getByRole("heading", { name: "交付与验收", exact: true }).waitFor();
    await page.getByText("已验证", { exact: true }).waitFor();
    await page.locator(".development-delivery .development-evidence summary").click();
    await page.locator(".development-delivery").getByText("Existing data verified", { exact: true }).waitFor();
    await page.locator(".development-delivery .development-report").scrollIntoViewIfNeeded();
    await capture(page, "desktop-report", false);
    await captureEvidence(page, "desktop-evidence");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".development-delivery .development-report").scrollIntoViewIfNeeded(); await capture(page, "mobile-report", false);
    await captureEvidence(page, "mobile-evidence");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "我已核对，接受这次交付", exact: true }).click();
    await page.getByText("用户已接受", { exact: true }).waitFor();
    await page.getByText("下一项修改，直接在对话中告诉 Wish。", { exact: true }).waitFor();
    assert.equal(await readFile(join(workspace, "preserved.txt"), "utf8"), "existing user content\n");
    await application.deleteSession({ sessionId: "browser-development-owner" });
    await application.createSession({ sessionId: "browser-history-reader", workspaceRoot: workspace, title: "同工作区后续对话" });
    await page.reload();
    await openSession(page, "同工作区后续对话");
    await page.getByRole("heading", { name: "项目交付记录", exact: true }).waitFor();
    await page.locator(".development-delivery > summary").click();
    await page.locator(".development-delivery .development-evidence summary").click();
    await page.locator(".development-delivery").getByText("Existing data verified", { exact: true }).waitFor();
    await capture(page, "desktop-retained-history");
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-retained-history");
    await page.locator(".development-delivery .development-report").scrollIntoViewIfNeeded(); await capture(page, "mobile-retained-report", false);
    await captureEvidence(page, "mobile-retained-evidence");
    assert.equal(providerFailure, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await booted?.dispose();
    await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

async function captureEvidence(page, name) {
  const output = page.locator(".development-delivery .development-output");
  await output.evaluate(node => node.scrollIntoView({ block: "center", inline: "nearest" }));
  await capture(page, name, false);
  const visible = await output.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  });
  assert.equal(visible, true, `${name}: actual verification output is within the viewport`);
}

async function openSession(page, title) {
  const link = page.getByRole("button", { name: title, exact: true });
  if (!await link.isVisible()) {
    const expand = page.getByRole("button", { name: "展开侧栏", exact: true });
    if (await expand.isVisible()) await expand.click();
  }
  await link.click(); await page.locator("#wish-composer").waitFor();
}
