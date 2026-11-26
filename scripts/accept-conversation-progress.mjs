import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationProcess } from "../dist/apps/webui/client/ui/conversation-process.js";

const block = (id, value) => ({ id, turnId: "turn", stepId: id, time: id, title: "Wish", kind: "assistant", text: "", ...value });
const render = (blocks, extra = {}, connected = true) => renderToStaticMarkup(createElement(ConversationProcess, {
  turn: { id: "turn", title: "Task", requests: [], process: blocks, live: true, failed: false, stopped: false, toolCount: 0, ...extra }, connected,
}));

test("reasoning-only output uses a short status without mounting the full work record", () => {
  const raw = "This entire reasoning paragraph must remain available only on request.";
  const html = render([block("thought", { reasoning: raw.repeat(100) })]);
  assert.match(html, /Wish 正在工作/u);
  assert.match(html, /查看过程/u);
  assert.doesNotMatch(html, /<pre|This entire reasoning|process-list/u);
  assert.doesNotMatch(html, /<details[^>]+open/u);
});

test("a new thinking step does not leave an earlier progress update marked as replying", () => {
  const blocks = [block("progress", { text: "我已找到入口，继续检查调用方。" }), block("next", { reasoning: "More investigation without a heading." })];
  const html = render(blocks);
  assert.match(html, /我已找到入口，继续检查调用方。/u);
  assert.match(html, /Wish 正在工作/u);
  assert.doesNotMatch(html, /Wish 正在回复|More investigation/u);
  assert.match(render([block("heading", { reasoning: "**检查调用方**\n\nPrivate details" })]), /检查调用方/u);
  assert.doesNotMatch(render([block("partial", { reasoning: "**Incomplete heading" })]), /Incomplete heading/u);
});

test("human wait, reconnect and Tool approval statuses take precedence over model activity", () => {
  const blocks = [block("tool", { kind: "tool", title: "bash", status: "tool.authorization_requested" }), block("thought", { reasoning: "**检查输出**" })];
  assert.match(render(blocks), /等待批准 · bash/u);
  assert.match(render(blocks, {}, false), /正在核对运行状态/u);
  const waiting = render(blocks, { contributions: [block("question", { status: "waiting-input" })] }, false);
  assert.match(waiting, /等你回答后继续/u);
  assert.match(waiting, /aria-busy="false"/u);
});

test("terminal states retain their process controls without an active progress surface", () => {
  const blocks = [block("thought", { reasoning: "Private reasoning" })];
  const stopped = render(blocks, { live: false, stopped: true });
  assert.match(stopped, /运行已停止/u);
  assert.doesNotMatch(stopped, /live-run|Private reasoning/u);
  const failed = render(blocks, { live: false, failed: true });
  assert.match(failed, /运行失败/u);
  assert.match(failed, /class="process-disclosure failed" open=""/u);
  assert.doesNotMatch(failed, /live-run|Private reasoning/u);
});
