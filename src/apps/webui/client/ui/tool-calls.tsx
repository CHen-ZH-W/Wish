import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionClientModel } from "../model/session.js";
import { projectLedger, type LedgerBlock } from "../projection/ledger.js";
import type { UiSlots, UiSlotSnapshot } from "../slots.js";
import { useLanguage, useText } from "../i18n.js";
import type { WishLanguage } from "../theme.js";
import { ErrorNotice, readableError, useSnapshot } from "./primitives.js";
import { IsolatedView } from "./isolated-view.js";
import { GenericToolDetails } from "./tool.js";
import { ConversationViewTabs, tailLedgerTurns } from "./conversation.js";

const TOOL_PAGE_TURNS = 24;

/** Session subview for detailed Tool calls and results; it is not a second conversation timeline. */
export function ToolCalls({ model, slots }: { model: SessionClientModel; slots: UiSlots }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), stream = useSnapshot(model.run), contributions = useSnapshot(slots);
  const [follow, setFollow] = useState(true);
  const [pageWindow, setPageWindow] = useState({ sessionId: state.selectedId, limit: TOOL_PAGE_TURNS });
  const scroll = useRef<HTMLDivElement>(null), prependScrollHeight = useRef<number | null>(null);
  const historyReady = state.history?.sessionId === state.selectedId;
  const history = historyReady ? state.history : null;
  const ledgerTurns = useMemo(() => projectLedger(history, stream.events, language), [history, stream.events, language]);
  const toolTurns = useMemo(() => ledgerTurns.flatMap((turn, index) => {
    const blocks = turn.blocks.filter(block => block.kind === "tool");
    return blocks.length ? [{ ...turn, number: index + 1, blocks }] : [];
  }), [ledgerTurns]);
  const turnLimit = pageWindow.sessionId === state.selectedId ? pageWindow.limit : TOOL_PAGE_TURNS;
  const visibleTurns = useMemo(() => tailLedgerTurns(toolTurns, turnLimit), [toolTurns, turnLimit]);
  const hiddenTurnCount = toolTurns.length - visibleTurns.length;
  const session = state.sessions.find(item => item.sessionId === state.selectedId);
  const archived = session?.status === "archived";
  const active = state.runs.find(item => item.status === "running");
  const openManagement = useCallback(() => slots.openPanel("plugins"), [slots]);

  useEffect(() => { setFollow(true); }, [state.selectedId]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [toolTurns, follow]);
  useLayoutEffect(() => {
    const before = prependScrollHeight.current, node = scroll.current;
    if (before === null || !node) return;
    node.scrollTop += node.scrollHeight - before;
    prependScrollHeight.current = null;
  }, [visibleTurns.length, state.selectedId]);

  if (!state.selectedId && state.loading) return null;
  if (!state.selectedId) return <section className="empty-state"><h1>{t("尚未选择会话", "No session selected")}</h1><p>{t("先选择一个会话，再查看它的工具调用。", "Choose a session to inspect its tool calls.")}</p></section>;
  return <section className="tool-calls-page">
    <header className="ledger-header">
      <div className="ledger-header-title"><h1>{session?.title || t("会话", "Conversation")}</h1><p className="muted workspace-path" title={session?.scope}>{session?.scope}</p></div>
      <ConversationViewTabs slots={slots} current="tool-calls" archived={archived} />
      <div className="ledger-header-actions">{archived || active ? <span className={`run-state ${active ? "running" : ""}`}>{archived ? t("已归档", "Archived") : t("运行中", "Running")}</span> : null}</div>
    </header>
    <div className="tool-calls-scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 96); }}>
      <div className="tool-calls-feed">
        <ErrorNotice text={state.error ? readableError(state.error) : null} />
        {stream.error ? <p className="notice warning">{stream.error}</p> : null}
        {hiddenTurnCount > 0 ? <div className="ledger-load-earlier"><button onClick={() => {
          prependScrollHeight.current = scroll.current?.scrollHeight ?? null;
          setFollow(false);
          setPageWindow({ sessionId: state.selectedId, limit: turnLimit + TOOL_PAGE_TURNS });
        }}>{t(`加载更早工具调用（还剩 ${hiddenTurnCount} 轮）`, `Load earlier tool calls (${hiddenTurnCount} turns remaining)`)}</button></div> : null}
        {!historyReady && state.loading ? <div className="ledger-welcome" role="status"><h2>{t("正在加载工具调用…", "Loading tool calls…")}</h2><p>{t("会话历史加载后会显示在这里。", "Tool calls will appear when the conversation history is ready.")}</p></div> : !toolTurns.length ? <div className="ledger-welcome"><h2>{t("这个会话还没有工具调用", "No tool calls in this conversation")}</h2><p>{t("需要查看参数或结果时，可以回到这里。", "Detailed inputs and results will appear here when tools are used.")}</p></div> : visibleTurns.map(turn => <section className="tool-call-turn" key={turn.id}><header className="tool-call-turn-heading"><span>{language === "en-US" ? `Turn ${turn.number}` : `第 ${turn.number} 轮`}</span><span /></header>{turn.blocks.map((block, index) => <div className="tool-call-step" key={block.id}>{block.stepId && turn.blocks[index - 1]?.stepId !== block.stepId ? <p className="tool-call-step-location" title={block.stepId}>Step {block.stepId.split(":").at(-1)}</p> : null}<ToolCallRecord block={block} contributions={contributions} openManagement={openManagement} /></div>)}</section>)}
        {active ? <p className="tool-calls-live-status" role="status">{stream.connected ? t("工具调用正在更新…", "Tool calls are updating…") : t("正在核对运行状态…", "Checking run status…")}</p> : null}
      </div>
    </div>
    {!follow ? <button className="tool-calls-follow-latest" onClick={() => setFollow(true)}>{t("回到最新工具调用", "Jump to latest tool call")}</button> : null}
  </section>;
}

const ToolCallRecord = memo(function ToolCallRecord({ block, contributions, openManagement }: { block: LedgerBlock; contributions: UiSlotSnapshot; openManagement(): void }) {
  const t = useText(), language = useLanguage();
  const ToolView = contributions.toolViews.find(item => item.toolName === block.toolName)?.View ?? GenericToolDetails;
  const availability = contributions.toolAvailability.find(item => item.toolName === block.toolName)?.state;
  return <article className="tool-call-row"><time dateTime={block.time}>{formatTime(block.time, language)}</time><span className="tool-call-event-dot" aria-hidden="true" /><div className="tool-call-body"><header><strong>{block.title}</strong>{block.status ? <span className="record-state">{recordStatus(block.status, t)}</span> : null}</header>
    {availability === "unavailable" ? <p className="historical-capability">{t("历史记录 · Host 工具入口当前不可用", "History · Host tool currently unavailable")}<button onClick={openManagement}>{t("查看插件管理", "View plugins")}</button></p> : availability === "unknown" ? <p className="historical-capability">{t("历史记录保留 · 当前能力状态尚未确认", "History preserved · current capability status unconfirmed")}</p> : null}
    <details className="tool-call-details"><summary>{t("查看调用与输出", "View call and output")}</summary><IsolatedView View={ToolView} block={block} /></details>
  </div></article>;
});

function recordStatus(status: string, t: ReturnType<typeof useText>): string {
  return ({
    "tool.queued": t("排队中", "Queued"),
    "tool.prepared": t("准备中", "Preparing"),
    "tool.authorization_requested": t("等待批准", "Awaiting approval"),
    "tool.dispatched": t("已派发", "Dispatched"),
    "tool.completed": t("已有结果", "Result available"),
    "tool.failed": t("失败", "Failed"),
    "tool.aborted": t("已停止", "Stopped"),
    "tool.authorization_denied": t("未获批准", "Denied"),
    "tool.recorded": t("已记录", "Recorded"),
  } as Record<string, string>)[status] ?? status;
}

function formatTime(value: string, language: WishLanguage): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
}
