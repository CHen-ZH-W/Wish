import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("a title finishes during the main response and redraws without waiting for slow Run reads", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-title-browser-"));
  const main = Promise.withResolvers(), title = Promise.withResolvers(), slowRead = Promise.withResolvers(), readEntered = Promise.withResolvers();
  const calls = [], errors = [];
  let booted, browser, titleSavedAt;
  const provider = createServer((incoming, response) => {
    let body = ""; incoming.setEncoding("utf8"); incoming.on("data", data => { body += data; });
    incoming.on("end", async () => {
      const request = JSON.parse(body), auxiliary = request.tools === undefined;
      const asking = request.messages.some(message => message.role === "user" && String(message.content).includes("询问用户"));
      calls.push({ auxiliary, at: Date.now() });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      if (!auxiliary && asking) {
        const delta = { tool_calls: [{ index: 0, id: "title-input-wait", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ title: "选择检查范围", questions: [{ id: "scope", question: "检查哪个模块？" }] }) } }] };
        response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (auxiliary) await title.promise;
      else {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "正在处理" }, finish_reason: null }] })}\n\n`);
        await main.promise;
      }
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: auxiliary ? asking ? "等待回答时及时命名" : "及时更新会话标题" : "已完成" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  try {
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    const configuration = { schemaVersion: 1, defaultModel: "fixture/main", fallbackModels: [], maxRetries: 0,
      providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native",
        models: [{ id: "main", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: JSON.stringify(configuration), WISH_MEMORY_ENABLED: "0", WISH_PERMISSION_PROFILE: "full-access" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const application = await booted.surfaceContext.get("application").open();
    const session = await application.createSession({ workspaceRoot: directory });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(booted.context.get("webManagementHost").url);
    await page.locator(".session-link").click();
    await page.locator("#wish-composer").fill("请检查并及时更新这个会话的标题");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.locator(".session-link").filter({ hasText: "请检查并及时更新这个会话的标题" }).waitFor();
    const conversation = await page.locator(".conversation").elementHandle();
    await page.locator("#wish-composer").fill("标题刷新时保留草稿");
    const deadline = Date.now() + 5000;
    while (!calls.some(call => call.auxiliary) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.length, 2, "title request starts before main completion");
    assert.equal(calls[0].auxiliary, false, "main request starts first");
    // Hold an ancillary read for longer than the 3-second polling interval.
    await page.route(`**/api/sessions/${session.sessionId}/runs`, async route => { readEntered.resolve(); await slowRead.promise; await route.continue(); });
    await readEntered.promise;
    title.resolve();
    while ((await application.getSession({ sessionId: session.sessionId })).titleSource !== "model") await new Promise(resolve => setTimeout(resolve, 10));
    titleSavedAt = Date.now();
    await page.locator(".session-link").filter({ hasText: "及时更新会话标题" }).waitFor({ timeout: 8000 });
    await page.locator(".ledger-header h1").filter({ hasText: "及时更新会话标题" }).waitFor();
    assert.equal(await conversation.evaluate(node => node === document.querySelector(".conversation")), true);
    assert.equal(await page.locator("#wish-composer").inputValue(), "标题刷新时保留草稿");
    assert.ok(booted.surfaceContext.get("runEngine").lifecycleSnapshot().activeRuns > 0, "main response is still running");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".ledger-header h1").filter({ hasText: "及时更新会话标题" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mainToTitleDispatchMs: calls[1].at - calls[0].at, titleSaveToVisibleMs: Date.now() - titleSavedAt, mainStillRunning: true }));
    main.resolve(); slowRead.resolve();
    await page.unrouteAll({ behavior: "wait" });
    const waiting = await application.createSession({ workspaceRoot: directory });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload(); await page.getByRole("button", { name: "新会话", exact: true }).click();
    await page.locator("#wish-composer").fill("请先询问用户要检查哪个模块");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.locator('.conversation-interaction[data-status="pending"]').waitFor();
    await page.locator(".ledger-header h1").filter({ hasText: "等待回答时及时命名" }).waitFor({ timeout: 8000 });
    assert.equal((await application.getSession({ sessionId: waiting.sessionId })).titleSource, "model");
    assert.equal((await booted.surfaceContext.get("interactions").get(waiting.sessionId)).requests[0].status, "pending", "the question is still waiting for the human");
    assert.ok(booted.surfaceContext.get("runEngine").lifecycleSnapshot().activeRuns > 0);
    assert.deepEqual(errors, []);
  } finally {
    main.resolve(); title.resolve(); slowRead.resolve();
    await browser?.close(); await booted?.dispose();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
