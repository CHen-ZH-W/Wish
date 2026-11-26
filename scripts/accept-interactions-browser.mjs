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

const captureDirectory = process.env.WISH_INTERACTIONS_CAPTURE_DIR ?? "/tmp/wish-interactions-browser";
const questions = { title: "先明确 Wish 的会话体验", description: "这些选择用于明确本次改进的方向，你也可以直接写下自己的想法。", questions: [
  { id: "focus", question: "这一步优先完善什么？", why: "选择会影响接下来的实现重点。", options: [{ id: "feedback", label: "会话内反馈", description: "在原消息处选择、补充和回看回答。", recommended: true }, { id: "project", label: "项目理解", description: "先梳理模块关系，再展开修改。" }] },
  { id: "keep", question: "哪些体验需要一并保留？", multiple: true, options: [{ id: "draft", label: "保留草稿", description: "切换会话后继续填写。" }, { id: "history", label: "回看记录", description: "刷新后仍能看到已提交的回答。" }] },
  { id: "own", question: "还有什么想法或要求？" },
] };

test("conversation questions round-trip through the real Host and survive navigation, refresh, failure, skip and stop", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-interactions-browser-")), workspace = join(directory, "workspace");
  let booted, browser, providerRequests = 0, providerFailure;
  const received = [], errors = [];
  const provider = createServer((incoming, response) => {
    let body = ""; incoming.setEncoding("utf8"); incoming.on("data", data => { body += data; });
    incoming.on("end", () => {
      try {
        const request = JSON.parse(body); received.push(request); providerRequests++;
        const lastUser = request.messages.findLastIndex(message => message.role === "user");
        const answered = request.messages.slice(lastUser + 1).some(message => message.role === "tool");
        const normalReply = String(request.messages[lastUser]?.content).includes("继续按新消息");
        const ask = !answered && !normalReply;
        const delta = ask ? { tool_calls: [{ index: 0, id: `interaction-call-${providerRequests}`, type: "function", function: { name: "ask_user", arguments: JSON.stringify(questions) } }] } : { content: normalReply ? "已按你在对话中的新消息继续。" : "已收到你的反馈，继续完善 Wish 的会话体验。" };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "interaction-fixture", choices: [{ index: 0, delta, finish_reason: ask ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
      } catch (error) { providerFailure = error; response.writeHead(500); response.end(String(error)); }
    });
  });
  try {
    await mkdir(workspace); await mkdir(captureDirectory, { recursive: true });
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    const configuration = { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0, providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native", models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
    booted = await bootstrap({ surface: "webui", cwd: workspace, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: workspace, WISH_MODELS_JSON: JSON.stringify(configuration), WISH_PERMISSION_PROFILE: "full-access", WISH_SESSION_TITLE_ENABLED: "0", WISH_MEMORY_ENABLED: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const owner = booted.surfaceContext.get("interactions"); assert.ok(owner, "default WebUI graph provides the interaction owner");
    const application = await booted.surfaceContext.get("application").open();
    await application.createSession({ sessionId: "interaction-a", workspaceRoot: workspace, title: "Wish 交互检验" });
    await application.createSession({ sessionId: "interaction-b", workspaceRoot: workspace, title: "其他会话" });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    const base = booted.context.get("webManagementHost").url;
    await page.goto(base); await openSession(page, "Wish 交互检验");
    await send(page, "请先通过会话里的选项询问我希望怎样完善 Wish，再按反馈继续。");
    const pending = page.locator('.conversation-interaction[data-status="pending"]');
    await pending.waitFor(); console.log("# initial question visible");
    assert.equal(await page.locator(".conversation-top-context .conversation-interaction").count(), 0);
    assert.equal(await pending.locator('input:checked').count(), 0, "a recommendation is not a submitted or preselected answer");
    assert.ok(await pending.locator("xpath=ancestor::section[contains(@class,'conversation-turn')]").count());
    const waitingCalls = providerRequests; await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(providerRequests, waitingCalls, "human waiting does not poll the model");
    await pending.getByLabel("会话内反馈", { exact: false }).check();
    await pending.getByLabel("保留草稿", { exact: false }).check(); await pending.getByLabel("回看记录", { exact: false }).check();
    await pending.locator("textarea").nth(0).fill("先做好会话里的原位交互");
    await pending.locator("textarea").nth(2).fill("不要增加管理员审批，也不要设置迭代轮次上限。");
    await openSession(page, "其他会话"); assert.equal(await page.locator(".conversation-interaction").count(), 0);
    await openSession(page, "Wish 交互检验");
    assert.equal(await pending.locator("textarea").nth(2).inputValue(), "不要增加管理员审批，也不要设置迭代轮次上限。");
    await page.reload(); await openSession(page, "Wish 交互检验"); await pending.waitFor();
    assert.equal(await pending.locator('input:checked').count(), 3); assert.match(await pending.locator("textarea").nth(0).inputValue(), /原位交互/);
    console.log("# navigation and refresh drafts retained"); await capture(page, "desktop-pending");
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-pending");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route("**/features/conversation-interactions", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporary_failure", message: "fixture" } }) }), { times: 1 });
    await pending.getByRole("button", { name: "提交回答并继续", exact: true }).click();
    await pending.getByText("回答未能提交", { exact: false }).waitFor();
    assert.match(await pending.locator("textarea").nth(2).inputValue(), /迭代轮次/);
    const submit = pending.getByRole("button", { name: "提交回答并继续", exact: true });
    await submit.click();
    const answered = page.locator('.conversation-interaction[data-status="answered"]'); await answered.waitFor();
    await page.getByText("已收到你的反馈，继续完善 Wish 的会话体验。", { exact: true }).waitFor();
    assert.equal((await owner.get("interaction-a")).requests[0].answers[1].optionIds.length, 2);
    assert.ok(received.some(request => request.messages.some(message => message.role === "tool" && String(message.content).includes("迭代轮次上限"))), "actual Tool output reaches the next model request");
    console.log("# answer submitted and delivered to the model"); await capture(page, "desktop-answer"); await page.setViewportSize({ width: 390, height: 844 }); await capture(page, "mobile-answer");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload(); await openSession(page, "Wish 交互检验"); await answered.waitFor();
    assert.match(await answered.innerText(), /不要增加管理员审批/);
    console.log("# answered record restored after refresh"); await send(page, "再问一个问题，检验跳过后继续。"); await pending.waitFor();
    await pending.getByRole("button", { name: "跳过，让 Wish 继续", exact: true }).click();
    await page.locator('.conversation-interaction[data-status="dismissed"]').waitFor(); await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    console.log("# skipped question settled"); await send(page, "再问一个问题，检验停止运行。"); await pending.waitFor();
    await page.getByRole("button", { name: "停止运行", exact: true }).click();
    await page.locator('.conversation-interaction[data-status="interrupted"]').waitFor();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    console.log("# stopped question settled"); await send(page, "再问一个问题，我会改用普通消息回复。"); await pending.waitFor();
    await page.locator("#wish-composer").fill("继续按新消息处理，不需要替我选择任何选项。");
    await page.getByRole("button", { name: "加入队列", exact: true }).click();
    await page.getByText("已转回对话", { exact: true }).waitFor();
    await page.getByText("已按你在对话中的新消息继续。", { exact: true }).waitFor();
    assert.equal((await owner.get("interaction-a")).requests.at(-1).answers, undefined);
    assert.equal(providerFailure, undefined); assert.deepEqual(errors, []);
    await writeFile(join(captureDirectory, "result.json"), JSON.stringify({ fixture: "local deterministic model", providerRequests, errors, captures: ["desktop-pending", "mobile-pending", "desktop-answer", "mobile-answer"] }, null, 2));
  } finally { await browser?.close(); await booted?.dispose(); await new Promise(resolve => provider.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

async function openSession(page, title) {
  const link = page.getByRole("button", { name: title, exact: true });
  if (!await link.isVisible()) { const expand = page.getByRole("button", { name: "展开侧栏", exact: true }); if (await expand.isVisible()) await expand.click(); }
  await link.click(); await page.locator("#wish-composer").waitFor();
}
async function send(page, value) { await page.locator("#wish-composer").fill(value); await page.getByRole("button", { name: "发送消息", exact: true }).click(); }
async function capture(page, name) {
  await assertContainerWidth(page.locator(".interaction-description").last(), `${name}: question description`);
  const paragraph = page.locator('.conversation-interaction[data-status="pending"] .interaction-why, .interaction-receipt dd p').first();
  await assertContainerWidth(paragraph, `${name}: question or answer paragraph`);
  await page.locator(".conversation-interaction").last().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no horizontal overflow`);
  await page.screenshot({ path: join(captureDirectory, `${name}.png`), fullPage: true });
}
