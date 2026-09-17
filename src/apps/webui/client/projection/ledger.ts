import type { SessionHistorySnapshot } from "../../../../sessions/types.js";
import type { WishOutputEvent } from "../../../types.js";
import { textFor, type WishLanguage } from "../theme.js";

export interface LedgerBlock {
  readonly id: string; readonly turnId: string; readonly stepId: string; readonly time: string;
  readonly runId?: string;
  readonly kind: "user" | "assistant" | "tool" | "checkpoint" | "system";
  readonly title: string; readonly text: string; readonly reasoning?: string;
  readonly toolName?: string; readonly input?: string; readonly status?: string;
}
export interface LedgerTurn { readonly id: string; readonly title: string; readonly blocks: readonly LedgerBlock[] }
const identity = (run: string, turn: string | undefined, step: string | undefined, kind: string) => `${run}/${turn ?? "unknown"}/${step ?? "unknown"}/${kind}`;

/** Pure presentation projection. Durable transcript wins over its corresponding live output. */
export function projectLedger(history: SessionHistorySnapshot | null, events: readonly WishOutputEvent[], language: WishLanguage = "zh-CN"): readonly LedgerTurn[] {
  const blocks = new Map<string, LedgerBlock>(), canonical = new Set<string>();
  const t = (zh: string, en: string) => textFor(language, zh, en);
  const put = (block: LedgerBlock) => { blocks.set(block.id, Object.freeze(block)); };
  for (const record of history?.records ?? []) {
    if (record.kind === "checkpoint") { put({ id: record.recordId, turnId: record.recordId, stepId: "", time: record.createdAt, kind: "checkpoint", title: t("上下文压缩记录", "Context checkpoint"), text: record.message.content }); continue; }
    const turnId = `${record.runId}/${record.userTurnId}`, stepId = record.stepId, message = record.message;
    const kind = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "system";
    const id = kind === "tool" ? `${record.runId}/tool/${message.toolCallId ?? record.recordId}` : record.origin === "steering" && kind === "user" ? record.recordId : identity(record.runId, record.userTurnId, kind === "user" ? "input" : stepId, kind);
    canonical.add(id);
    if (message.content || message.reasoningContent || kind !== "assistant") put({ id, turnId, stepId, runId: record.runId, time: record.createdAt, kind,
      title: kind === "user" ? record.origin === "steering" ? t("引导消息", "Steering message") : t("你的请求", "Your request") : kind === "assistant" ? "Wish" : kind === "tool" ? blocks.get(id)?.title ?? t("工具结果", "Tool result") : message.role,
      text: message.content, ...(message.reasoningContent ? { reasoning: message.reasoningContent } : {}),
      ...(kind === "tool" ? { ...blocks.get(id), text: message.content, status: t("已有结果", "Result available") } : {}) });
    for (const call of message.toolCalls ?? []) {
      const toolId = `${record.runId}/tool/${call.id}`;
      put({ id: toolId, turnId, stepId, runId: record.runId, time: record.createdAt, kind: "tool", title: call.name, toolName: call.name, input: call.argumentsJson, text: blocks.get(toolId)?.text ?? "", status: blocks.get(toolId)?.status ?? t("已记录调用", "Call recorded") });
    }
  }
  const live = new Map<string, LedgerBlock>();
  for (const event of events) {
    const base = { runId: event.runId, turnId: `${event.runId}/${event.userTurnId ?? "unknown"}`, stepId: event.stepId ?? "", time: event.occurredAt };
    if (event.type === "runtime.transition" && event.payload.type === "user_turn.started") {
      const id = identity(event.runId, event.payload.userTurnId, "input", "user");
      if (!canonical.has(id)) live.set(id, { ...base, turnId: `${event.runId}/${event.payload.userTurnId}`, id, kind: "user", title: t("你的请求", "Your request"), text: event.payload.input.text });
    }
    if (event.type === "model.stream" && (event.payload.type === "text_delta" || event.payload.type === "reasoning_delta")) {
      const id = identity(event.runId, event.userTurnId, event.stepId, "assistant");
      if (canonical.has(id)) continue;
      const old = live.get(id) ?? { ...base, id, kind: "assistant" as const, title: "Wish", text: "", reasoning: "" };
      live.set(id, { ...old, ...(event.payload.type === "text_delta" ? { text: old.text + event.payload.text } : { reasoning: (old.reasoning ?? "") + event.payload.text }) });
    }
    if (event.type === "tool.lifecycle") {
      const payload = event.payload, id = `${event.runId}/tool/${payload.call.id}`;
      if (canonical.has(id)) continue;
      const old = blocks.get(id);
      live.set(id, { ...base, ...old, id, kind: "tool", title: payload.call.name, toolName: payload.call.name,
        input: payload.call.status === "ready" ? JSON.stringify(payload.call.input, null, 2) : JSON.stringify(payload.call.error),
        text: "result" in payload ? JSON.stringify(payload.result.ok ? payload.result.output : payload.result.error, null, 2) : "", status: payload.type });
    }
    if (event.type === "runtime.transition" && (event.payload.type === "run.failed" || event.payload.type === "run.aborted")) {
      const id = `${event.runId}/terminal`;
      live.set(id, { ...base, id, kind: "system", title: event.payload.type === "run.failed" ? t("运行失败", "Run failed") : t("运行已停止", "Run stopped"), text: JSON.stringify(event.payload.type === "run.failed" ? event.payload.error : event.payload.cancellation, null, 2) });
    }
  }
  for (const block of live.values()) put(block);
  const turns = new Map<string, { id: string; title: string; blocks: LedgerBlock[] }>();
  for (const block of [...blocks.values()].sort((a, b) => a.time.localeCompare(b.time))) {
    const turn = turns.get(block.turnId) ?? { id: block.turnId, title: t("执行记录", "Activity"), blocks: [] };
    if (block.kind === "user") turn.title = block.text.slice(0, 72);
    turn.blocks.push(block); turns.set(block.turnId, turn);
  }
  return Object.freeze([...turns.values()].map(turn => Object.freeze({ ...turn, blocks: Object.freeze(turn.blocks) })));
}
