import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { assertContainerWidth } from "./support/conversation-layout.mjs";

const captureDirectory = process.env.WISH_WEBUI_CAPTURE_DIR;

for (const width of [1440, 1280, 390]) test(`conversation streams progress and retains opt-in reasoning at ${width}px`, { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-progress-"));
  const reasoning = `**定位实现**\n\n${"完整思考记录保留在过程详情中。".repeat(200)}`;
  const nextReasoning = `**核对读取结果**\n\n${"这是最终步骤的完整思考。".repeat(100)}`;
  const progress = "我已经定位到会话消息的展示入口，正在核对工具调用与正文之间的顺序。接下来会读取工作区文件，确认进度更新可以沿着主会话正文的完整宽度自然换行，并继续保留可展开的思考记录和当前输入草稿。";
  const answer = "已完成检查，文件内容为 progress evidence。";
  const paragraph = "主会话中的正文需要一直排到容器的可用边界，按照实际宽度自然换行，同时保留列表和引用的正常缩进。".repeat(4);
  const answerMarkdown = `${answer}\n\n${paragraph}\n\n- ${paragraph}\n\n> ${paragraph}\n\n\`\`\`text\n${"workspace/".repeat(50)}\n\`\`\``;
  const requests = [], streams = [], errors = [];
  let booted, browser, providerFailure;
  const provider = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8"); incoming.on("data", data => { body += data; });
    incoming.on("end", () => {
      try {
        const request = JSON.parse(body);
        requests.push(request);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: `progress-${requests.length}`, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
        const stream = { send, finish(reason = "stop") { send({}, reason); response.end("data: [DONE]\n\n"); }, response };
        streams.push(stream);
        send({ reasoning_content: requests.length === 1 ? reasoning : requests.length === 2 ? nextReasoning : "这段没有标题的思考不应该出现在主窗口。".repeat(100) });
      } catch (error) { providerFailure = error; response.end(); }
    });
  });
  try {
    await writeFile(join(directory, "evidence.txt"), "progress evidence\n");
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    const configuration = { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
      providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native",
        models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: true, toolCalling: true, developerRole: true }] }] };
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MODELS_JSON: JSON.stringify(configuration), WISH_PERMISSION_PROFILE: "full-access", WISH_SESSION_TITLE_ENABLED: "0", WISH_MEMORY_ENABLED: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const application = await booted.surfaceContext.get("application").open();
    await application.createSession({ sessionId: "progress", workspaceRoot: directory, title: "进度展示验收" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => errors.push(error.message));
    const openSession = async () => {
      await page.locator(".wish-shell").waitFor();
      const expand = page.getByRole("button", { name: "展开侧栏", exact: true });
      if (await expand.isVisible()) await expand.click();
      await page.getByRole("button", { name: "进度展示验收", exact: true }).click();
      await page.locator("#wish-composer").waitFor();
    };
    await page.goto(booted.context.get("webManagementHost").url);
    await openSession();
    await page.locator("#wish-composer").fill("请检查 evidence.txt 并核对结果。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const live = page.locator(".live-run"), disclosure = page.locator(".process-disclosure").last();
    await live.getByRole("status").filter({ hasText: "定位实现" }).waitFor();
    assert.equal(await page.locator(".reasoning pre").count(), 0, "full reasoning is not mounted by default");
    assert.equal(await disclosure.evaluate(node => node.open), false);
    assert.equal(await live.getByText("完整思考记录", { exact: false }).count(), 0, "the main progress feed does not echo reasoning paragraphs");
    assert.match(JSON.stringify(requests[0].messages.filter(message => message.role === "system")), /brief progress updates in ordinary assistant text/u, "the actual model request asks the main model for progress");

    streams[0].send({ content: progress });
    await live.locator(".progress-message").filter({ hasText: progress }).waitFor();
    const progressLayout = await assertConversationBodyWidth(page, live.locator(".progress-message"), "live progress");
    await page.locator("#wish-composer").fill("这份未发送草稿需要保留。");
    await disclosure.locator(":scope > summary").click();
    await assertContainerWidth(disclosure.locator(".model-activity .message-markdown").first(), "expanded process body");
    await assertContainerWidth(disclosure.locator(".model-activity .message-markdown > p").first(), "expanded process paragraph");
    await disclosure.locator(".reasoning > summary").first().click();
    const outerNode = await disclosure.elementHandle(), reasoningNode = await disclosure.locator(".reasoning").first().elementHandle();
    const fullReasoning = disclosure.locator(".reasoning pre").first();
    await fullReasoning.waitFor(); assert.equal(await fullReasoning.textContent(), reasoning);
    await fullReasoning.evaluate(node => { node.scrollTop = 120; });
    const readingScroll = await fullReasoning.evaluate(node => node.scrollTop);
    const ledgerScroll = await page.locator(".ledger-scroll").evaluate(node => node.scrollTop);
    streams[0].send({ reasoning_content: "\n补充检查依据。" });
    await page.waitForFunction(() => document.querySelector(".reasoning pre")?.textContent?.endsWith("补充检查依据。"));
    assert.equal(await reasoningNode.evaluate(node => node.open), true, "a delta retains the user's disclosure choice");
    assert.equal(await fullReasoning.evaluate(node => node.scrollTop), readingScroll, "a reasoning delta retains its independent reading position");
    assert.equal(await page.locator(".ledger-scroll").evaluate(node => node.scrollTop), ledgerScroll, "inspecting a process pauses automatic follow");

    streams[0].send({ tool_calls: [{ index: 0, id: "read-evidence", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(directory, "evidence.txt") }) } }] });
    streams[0].finish("tool_calls");
    await live.getByRole("status").filter({ hasText: "核对读取结果" }).waitFor();
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(message => message.role === "tool" && String(message.content).includes("progress evidence")), "a real Tool result reaches the next model step");
    assert.equal(await live.locator(".progress-message").first().textContent(), progress);
    assert.equal(await live.locator(".tool-activity.success").count(), 1);
    assert.equal(await page.locator("#wish-composer").inputValue(), "这份未发送草稿需要保留。");
    assert.equal(await disclosure.evaluate((node, previous) => node === previous, outerNode), true);

    await page.getByRole("button", { name: "设置与插件", exact: true }).click();
    await page.getByRole("heading", { name: "通用设置", exact: true }).waitFor();
    await page.locator(".utility-rail").getByRole("button", { name: "会话", exact: true }).click();
    await live.waitFor();
    assert.equal(await disclosure.evaluate((node, previous) => node === previous, outerNode), true, "navigation retains the process DOM");
    assert.equal(await reasoningNode.evaluate(node => node.open), true);
    assert.equal(await page.locator("#wish-composer").inputValue(), "这份未发送草稿需要保留。");

    await disclosure.locator(":scope > summary").click();
    await page.waitForFunction(() => document.querySelector(".process-disclosure .process-list") === null);
    assert.equal(await page.locator(".reasoning pre").count(), 0, "closing the process unmounts its large body");
    await capture(page, width, "running");
    await disclosure.locator(":scope > summary").click();
    await disclosure.locator(".reasoning > summary").last().click();
    const finalReasoningNode = await disclosure.locator(".reasoning").last().elementHandle();
    streams[1].send({ content: answerMarkdown });
    await live.locator(".progress-message").filter({ hasText: answer }).waitFor();
    streams[1].finish();
    await page.locator(".final-answer").filter({ hasText: answer }).waitFor();
    const answerLayout = await assertConversationBodyWidth(page, page.locator(".final-answer .message-text"), "final answer");
    await assertContainerWidth(page.locator(".final-answer .message-markdown > p").first(), "final answer paragraph");
    await assertContainerWidth(page.locator(".final-answer .message-markdown > p").nth(1), "long answer paragraph");
    await assertContainerWidth(page.locator(".final-answer .message-markdown li > p"), "list paragraph with indentation");
    await assertContainerWidth(page.locator(".final-answer .message-markdown blockquote > p"), "quoted paragraph with indentation");
    assert.equal(await page.locator(".final-answer .message-code-block pre").evaluate(node => node.scrollWidth > node.clientWidth), true, "long code scrolls inside its own container");
    assert.equal(await live.count(), 0);
    assert.equal(await disclosure.evaluate((node, previous) => node === previous, outerNode), true, "completion keeps the same process disclosure");
    assert.equal(await disclosure.evaluate(node => node.open), true);
    assert.equal(await disclosure.locator(".reasoning").last().evaluate((node, previous) => node === previous, finalReasoningNode), true, "final-answer extraction retains the reasoning node");
    assert.equal(await finalReasoningNode.evaluate(node => node.open), true);
    assert.equal(await disclosure.locator(".reasoning pre").last().textContent(), nextReasoning);
    await disclosure.locator(":scope > summary").click();
    await capture(page, width, "completed");
    if (captureDirectory) await writeFile(join(captureDirectory, `progress-${width}-layout.json`), JSON.stringify({ progress: progressLayout, answer: answerLayout }, null, 2));

    await page.reload(); await openSession();
    await page.locator(".final-answer").filter({ hasText: answer }).waitFor();
    assert.equal(await disclosure.evaluate(node => node.open), false);
    await disclosure.locator(":scope > summary").click();
    await disclosure.locator(".reasoning > summary").first().click();
    assert.equal(await disclosure.locator(".reasoning pre").first().textContent(), `${reasoning}\n补充检查依据。`, "the complete reasoning survives canonical history and reload");
    await disclosure.locator(":scope > summary").click();
    await page.locator("#wish-composer").fill("再分析一会儿，检验停止后保留过程。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const stoppedTurn = page.locator(".conversation-turn").last();
    await stoppedTurn.locator(".live-run").getByRole("status").filter({ hasText: "Wish 正在工作" }).waitFor();
    assert.equal(await stoppedTurn.locator(".progress-message").count(), 0, "reasoning does not invent a progress update");
    assert.equal(await stoppedTurn.locator(".reasoning pre").count(), 0);
    await stoppedTurn.locator(".process-disclosure > summary").filter({ hasText: "包含思考过程" }).waitFor();
    await page.getByRole("button", { name: "停止运行", exact: true }).click();
    const stoppedProcess = stoppedTurn.locator(".process-disclosure.stopped");
    await stoppedProcess.waitFor();
    assert.equal(await stoppedProcess.evaluate(node => node.open), false);
    await stoppedProcess.locator(":scope > summary").click();
    await stoppedProcess.locator(".reasoning > summary").click();
    await stoppedProcess.locator(".reasoning pre").waitFor();
    assert.match(await stoppedProcess.locator(".reasoning pre").textContent(), /这段没有标题的思考/u);
    assert.equal(providerFailure, undefined); assert.deepEqual(errors, []);
  } finally {
    for (const stream of streams) stream.response.end();
    await browser?.close(); await booted?.dispose();
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

async function capture(page, width, state) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px ${state}: no horizontal overflow`);
  if (!captureDirectory) return;
  await mkdir(captureDirectory, { recursive: true });
  await page.screenshot({ path: join(captureDirectory, `progress-${width}-${state}.png`), fullPage: true });
}

async function assertConversationBodyWidth(page, body, label) {
  const [feed, request, text] = await Promise.all([
    page.locator(".conversation-ledger-feed").boundingBox(),
    page.locator(".conversation-request").last().boundingBox(),
    body.boundingBox(),
  ]);
  assert.ok(feed && request && text, `${label}: conversation reading surfaces exist`);
  assert.ok(Math.abs(text.x - feed.x) <= 1, `${label}: left edge follows the main feed`);
  assert.ok(Math.abs(text.width - feed.width) <= 1, `${label}: text uses the complete main feed (${text.width}px of ${feed.width}px)`);
  assert.ok(Math.abs(text.x + text.width - request.x - request.width) <= 1, `${label}: right edge aligns with the user request`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: no horizontal overflow`);
  return { feedWidth: feed.width, textWidth: text.width, left: text.x, right: text.x + text.width };
}
