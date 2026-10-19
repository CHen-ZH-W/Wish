import type { SessionHistorySnapshot } from "../../../../sessions/types.js";
import type { WishOutputEvent } from "../../../types.js";
import { textFor, type WishLanguage } from "../theme.js";

export interface LedgerBlock {
  readonly id: string; readonly turnId: string; readonly stepId: string; readonly time: string;
  readonly runId?: string;
  readonly kind: "user" | "assistant" | "tool" | "checkpoint" | "system";
  readonly title: string; readonly text: string; readonly reasoning?: string;
  readonly toolName?: string; readonly input?: string; readonly status?: string;
  /** Optional domain-owned renderer and opaque payload supplied through a UI slot. */
  readonly viewId?: string; readonly data?: unknown;
  readonly anchor?: "turn-start" | "step-start";
}
export interface LedgerTurn { readonly id: string; readonly title: string; readonly blocks: readonly LedgerBlock[] }
export interface ConversationTurn {
  readonly id: string;
  readonly title: string;
  readonly requests: readonly LedgerBlock[];
  readonly answer?: LedgerBlock;
  readonly process: readonly LedgerBlock[];
  readonly live: boolean;
  readonly failed: boolean;
  readonly stopped: boolean;
  readonly toolCount: number;
}
const identity = (run: string, turn: string | undefined, step: string | undefined, kind: string) => `${run}/${turn ?? "unknown"}/${step ?? "unknown"}/${kind}`;

/** Shapes the event ledger into a conversation: requests and the final answer stay primary, work evidence stays available on demand. */
export function projectConversationTurns(turns: readonly LedgerTurn[], liveTurnId: string | null = null): readonly ConversationTurn[] {
  const projected = turns.flatMap(turn => {
    const requests = turn.blocks.filter(block => block.kind === "user");
    const failed = turn.blocks.some(block => block.status === "run.failed");
    const stopped = turn.blocks.some(block => block.status === "run.aborted");
    const live = turn.id === liveTurnId;
    const answer = live || failed || stopped ? undefined : [...turn.blocks].reverse().find(block => block.kind === "assistant" && block.text.trim().length > 0);
    const process: LedgerBlock[] = [];
    for (const block of turn.blocks) {
      if (block.kind === "user" || block.kind === "checkpoint") continue;
      if (block === answer) {
        if (block.reasoning) process.push(Object.freeze({ ...block, id: `${block.id}/reasoning`, text: "" }));
        continue;
      }
      process.push(block);
    }
    if (!requests.length && !answer && process.every(block => block.kind === "checkpoint")) return [];
    return [Object.freeze({
      id: turn.id,
      title: turn.title,
      requests: Object.freeze(requests),
      ...(answer === undefined ? {} : { answer }),
      process: Object.freeze(process),
      live,
      failed,
      stopped,
      toolCount: process.filter(block => block.kind === "tool").length,
    })];
  });
  return Object.freeze(projected);
}

/** Pure presentation projection. Durable transcript wins over its corresponding live output. */
export function projectLedger(history: SessionHistorySnapshot | null, events: readonly WishOutputEvent[], language: WishLanguage = "zh-CN", extensions: readonly LedgerBlock[] = []): readonly LedgerTurn[] {
  const blocks = new Map<string, LedgerBlock>(), canonical = new Set<string>(), canonicalToolResults = new Set<string>();
  const visibleTurnsByRun = new Map<string, { turnId: string; time: string }[]>();
  const continuationParents = new Map<string, string>();
  const orphanedContinuations = new Set<string>();
  const t = (zh: string, en: string) => textFor(language, zh, en);
  const put = (block: LedgerBlock) => { blocks.set(block.id, Object.freeze(block)); };
  const rememberVisibleTurn = (runId: string, userTurnId: string, time: string) => {
    const turnId = `${runId}/${userTurnId}`;
    const turns = visibleTurnsByRun.get(runId) ?? [];
    if (!turns.some(turn => turn.turnId === turnId)) turns.push({ turnId, time });
    visibleTurnsByRun.set(runId, turns);
  };
  const visibleTurnAt = (runId: string, time: string) => visibleTurnsByRun.get(runId)
    ?.filter(turn => turn.time <= time)
    .reduce<{ turnId: string; time: string } | undefined>((latest, turn) =>
      latest === undefined || latest.time <= turn.time ? turn : latest, undefined)?.turnId;
  for (const record of history?.records ?? []) {
    if (record.kind === "checkpoint") { put({ id: record.recordId, turnId: record.recordId, stepId: "", time: record.createdAt, kind: "checkpoint", title: t("上下文压缩记录", "Context checkpoint"), text: record.message.content }); continue; }
    const rawTurnId = `${record.runId}/${record.userTurnId}`, stepId = record.stepId, message = record.message;
    // Host continuations wake the parent model but are not user-authored conversation.
    if (message.role === "user" && record.inputSource === "continuation") {
      const parent = visibleTurnAt(record.runId, record.createdAt);
      if (parent) continuationParents.set(rawTurnId, parent);
      else orphanedContinuations.add(rawTurnId);
      continue;
    }
    if (orphanedContinuations.has(rawTurnId)) continue;
    if (message.role === "user") rememberVisibleTurn(record.runId, record.userTurnId, record.createdAt);
    const turnId = continuationParents.get(rawTurnId) ?? rawTurnId;
    const kind = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "system";
    const id = kind === "tool" ? `${record.runId}/tool/${message.toolCallId ?? record.recordId}` : record.origin === "steering" && kind === "user" ? record.recordId : identity(record.runId, record.userTurnId, kind === "user" ? "input" : stepId, kind);
    canonical.add(id);
    if (message.content || message.reasoningContent || kind !== "assistant") put({ id, turnId, stepId, runId: record.runId, time: record.createdAt, kind,
      title: kind === "user" ? record.origin === "steering" ? t("引导消息", "Steering message") : t("你的请求", "Your request") : kind === "assistant" ? "Wish" : kind === "tool" ? blocks.get(id)?.title ?? t("工具结果", "Tool result") : message.role,
      text: message.content, ...(message.reasoningContent ? { reasoning: message.reasoningContent } : {}),
      ...(kind === "tool" ? { ...blocks.get(id), text: message.content, status: message.content.startsWith("Tool failed [") ? "tool.failed" : "tool.completed" } : {}) });
    if (kind === "tool") canonicalToolResults.add(id);
    for (const call of message.toolCalls ?? []) {
      const toolId = `${record.runId}/tool/${call.id}`;
      put({ id: toolId, turnId, stepId, runId: record.runId, time: record.createdAt, kind: "tool", title: call.name, toolName: call.name, input: call.argumentsJson, text: blocks.get(toolId)?.text ?? "", status: blocks.get(toolId)?.status ?? "tool.recorded" });
    }
  }
  const live = new Map<string, LedgerBlock>();
  for (const event of events) {
    if (event.type === "runtime.transition" && event.payload.type === "user_turn.started" && event.payload.inputSource === "continuation") {
      const parent = visibleTurnAt(event.runId, event.occurredAt);
      if (parent) continuationParents.set(`${event.runId}/${event.payload.userTurnId}`, parent);
      else orphanedContinuations.add(`${event.runId}/${event.payload.userTurnId}`);
    }
    const rawTurnId = `${event.runId}/${event.userTurnId ?? "unknown"}`;
    if (orphanedContinuations.has(rawTurnId)) continue;
    const base = { runId: event.runId, turnId: continuationParents.get(rawTurnId) ?? rawTurnId, stepId: event.stepId ?? "", time: event.occurredAt };
    if (event.type === "runtime.transition" && event.payload.type === "user_turn.started" && event.payload.inputSource !== "continuation") {
      rememberVisibleTurn(event.runId, event.payload.userTurnId, event.occurredAt);
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
      if (canonicalToolResults.has(id)) {
        // Keep the durable result text, but use the structured terminal event for its outcome.
        if (payload.type === "tool.completed" || payload.type === "tool.failed" || payload.type === "tool.aborted") {
          const recorded = blocks.get(id);
          if (recorded) put({ ...recorded, status: payload.type });
        }
        continue;
      }
      const old = live.get(id) ?? blocks.get(id);
      live.set(id, { ...base, ...old, id, kind: "tool", title: payload.call.name, toolName: payload.call.name,
        input: payload.call.status === "ready" ? JSON.stringify(payload.call.input, null, 2) : JSON.stringify(payload.call.error),
        text: "result" in payload ? JSON.stringify(payload.result.ok ? payload.result.output : payload.result.error, null, 2) : "", status: payload.type });
    }
    if (event.type === "runtime.transition" && (event.payload.type === "run.failed" || event.payload.type === "run.aborted")) {
      const turnId = visibleTurnAt(event.runId, event.occurredAt);
      if (!turnId) continue;
      const id = `${event.runId}/terminal`;
      live.set(id, { ...base, turnId, id, kind: "system", title: event.payload.type === "run.failed" ? t("运行失败", "Run failed") : t("运行已停止", "Run stopped"), text: event.payload.type === "run.failed" ? event.payload.error.message : "", status: event.payload.type });
    }
  }
  for (const block of live.values()) put(block);
  const turns = new Map<string, { id: string; title: string; blocks: LedgerBlock[] }>();
  for (const block of [...blocks.values()].sort((a, b) => a.time.localeCompare(b.time))) {
    const turn = turns.get(block.turnId) ?? { id: block.turnId, title: t("会话内容", "Conversation content"), blocks: [] };
    if (block.kind === "user") turn.title = block.text.slice(0, 72);
    turn.blocks.push(block); turns.set(block.turnId, turn);
  }
  for (const block of extensions) {
    if (blocks.has(block.id)) continue;
    const turn = turns.get(block.turnId) ?? { id: block.turnId, title: t("会话内容", "Conversation content"), blocks: [] };
    const stepIndex = block.anchor === "step-start" ? turn.blocks.findIndex(item => item.stepId === block.stepId) : -1;
    const index = block.anchor === "turn-start" ? 0 : stepIndex >= 0
      ? stepIndex
      : turn.blocks.findIndex(item => item.time.localeCompare(block.time) > 0);
    turn.blocks.splice(index < 0 ? turn.blocks.length : index, 0, block);
    turns.set(block.turnId, turn);
  }
  return Object.freeze([...turns.values()].map(turn => Object.freeze({ ...turn, blocks: Object.freeze(turn.blocks) })));
}
