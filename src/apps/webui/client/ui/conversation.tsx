import { IsolatedView } from "./isolated-view.js";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { SessionClientModel } from "../model/session.js";
import type { SettingsClientModel } from "../../../../settings/consumers/webui/model.js";
import { projectLedger, type LedgerBlock } from "../projection/ledger.js";
import { Icon, ErrorNotice, readableError, useSnapshot } from "./primitives.js";
import type { UiSlots, UiSlotSnapshot } from "../slots.js";
import { GenericToolDetails } from "./tool.js";
import type { ComposerDraft, ComposerDrafts } from "./drafts.js";
import { useLanguage, useText } from "../i18n.js";
import type { WishLanguage } from "../theme.js";

export function RoundNavigation({ model }: { model: SessionClientModel }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), turns = useMemo(() => projectLedger(state.history, [], language), [state.history, language]);
  return turns.length ? <nav className="round-navigation" aria-label={t("本会话轮次", "Turns in this session")}><h2>{t("轮次", "Turns")}</h2>{turns.slice(-8).map((turn, index) => <a key={turn.id} href={`#turn-${encodeURIComponent(turn.id)}`}><span>{Math.max(0, turns.length - 8) + index + 1}</span><span>{turn.title}</span></a>)}</nav> : null;
}
export function Conversation({ model, settings, slots, drafts }: { model: SessionClientModel; settings: SettingsClientModel; slots: UiSlots; drafts: ComposerDrafts }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), stream = useSnapshot(model.run), preferences = useSnapshot(settings);
  const contributions = useSnapshot(slots);
  const [error, setError] = useState<string | null>(null), [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("all");
  const categories = [...new Map(contributions.toolViews.flatMap(item => item.category ? [[item.category.id, item.category] as const] : [])).values()];
  const allTurns = useMemo(() => projectLedger(state.history, stream.events, language), [state.history, stream.events, language]);
  const turns = useMemo(() => filter === "all" ? allTurns : allTurns.map(turn => ({ ...turn, blocks: turn.blocks.filter(block => filter === "tools" ? block.kind === "tool" : contributions.toolViews.some(item => item.toolName === block.toolName && item.category?.id === filter)) })).filter(turn => turn.blocks.length), [allTurns, filter, contributions.toolViews]);
  useEffect(() => { if (filter !== "all" && filter !== "tools" && !categories.some(item => item.id === filter)) setFilter("all"); }, [contributions.toolViews, filter]);
  const session = state.sessions.find(item => item.sessionId === state.selectedId), active = state.runs.find(item => item.status === "running");
  const archived = session?.status === "archived";
  const mode = preferences.sections.find(item => item.namespace === "webui-composer")?.value["busy-delivery"] === "steer" ? "steer" : "queue";
  useEffect(() => { setFollow(true); }, [state.selectedId]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [turns, follow]);
  if (!state.selectedId && state.loading) return null;
  if (!state.selectedId && state.filter === "archived") return <section className="empty-state"><Icon name="archive" /><h1>{t("还没有归档会话", "No archived sessions")}</h1><p>{t("归档后的会话会按工作区显示在侧栏中，聊天记录可以随时查看。", "Archived sessions appear by workspace in the sidebar. Their conversation history remains available.")}</p><ErrorNotice text={state.error ? readableError(state.error) : null} /></section>;
  if (!state.selectedId) return <section className="empty-state"><Icon name="trace" /><h1>{t("还没有选择会话", "No session selected")}</h1><p>{t("新会话需要先绑定工作区；确认前不会在 Host 中留下空会话。", "Choose a workspace before starting a session. No empty Host session is created until you send a message.")}</p><ErrorNotice text={error} /><button className="primary" disabled={!state.available || state.working} onClick={() => slots.openPanel("new-session")}>{t("新建会话", "New session")}</button></section>;
  return <section className="conversation">
    <header className="ledger-header"><div><h1>{session?.title || t("执行记录", "Activity")}</h1><p className="muted workspace-path" title={session?.scope}>{session?.scope}</p></div><nav className="ledger-filters" aria-label={t("记录筛选", "Activity filters")}>{[{ id: "all", label: t("全部", "All") }, { id: "tools", label: t("工具", "Tools") }, ...categories].map(item => <button key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{language === "en-US" && "labelEn" in item ? item.labelEn ?? item.label : item.label}</button>)}</nav><span className={`run-state ${active ? "running" : ""}`}>{archived ? t("已归档", "Archived") : active ? t("运行中", "Running") : t("等待请求", "Waiting")}</span></header>
    <div className="ledger-scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 96); }}>
      <ErrorNotice text={state.error ? readableError(state.error) : null} />
      {stream.gap ? <p className="notice warning">{t("这里只保留有界运行事件窗口，部分早期事件未包含。下面的规范历史仍保留；不会自动重放工具。", "Only a bounded window of run events is available. Earlier events may be missing; the saved history remains below. Tools are not replayed automatically.")}</p> : null}
      {stream.error ? <p className="notice warning">{stream.error}</p> : null}
      {!turns.length ? <div className="ledger-welcome"><h2>{allTurns.length ? t("此筛选下没有记录", "No activity matches this filter") : t("这个会话还没有执行记录", "No activity in this session yet")}</h2><p>{allTurns.length ? t("可以切换“全部”查看完整过程。", "Choose All to see the full history.") : t("描述你要完成的工作。过程会按轮次和步骤排列在这里。", "Describe what you want done. The work will appear here by turn and step.")}</p></div> : turns.map(turn => <section className="ledger-turn" key={turn.id} id={`turn-${encodeURIComponent(turn.id)}`}><header className="turn-heading"><span>{language === "en-US" ? `Turn ${allTurns.findIndex(item => item.id === turn.id) + 1}` : `第 ${allTurns.findIndex(item => item.id === turn.id) + 1} 轮`}</span><span className="turn-rule" /></header>{turn.blocks.map((block, index) => <div className="ledger-step" key={block.id}>{block.stepId && turn.blocks[index - 1]?.stepId !== block.stepId ? <p className="step-location" title={block.stepId}>Step {block.stepId.split(":").at(-1)}</p> : null}<LedgerRow block={block} contributions={contributions} openManagement={() => slots.openPanel("plugins")} /></div>)}</section>)}
      {active ? <p className="live-status" role="status">{stream.connected ? t("正在接收运行事件…", "Receiving run events…") : t("正在核对运行状态…", "Checking run status…")}</p> : null}
    </div>
    {!archived ? contributions.interactions.map(item => <IsolatedView key={item.id} View={item.View} />) : null}
    {!follow ? <button className="follow-latest" onClick={() => setFollow(true)}>{t("回到最新记录", "Jump to latest")}</button> : null}
    {archived ? <footer className="composer archived-hint"><span>{t("已归档，聊天记录只读。", "Archived. Conversation history is read-only.")}</span><button disabled={!state.available || state.working} onClick={() => { setError(null); void model.restore(state.selectedId!).catch(cause => setError(readableError(cause.message))); }}>{t("取消归档", "Restore")}</button><ErrorNotice text={error} /></footer> : <Composer key={state.selectedId} sessionId={state.selectedId} composerItems={contributions.composerItems} model={model} draft={drafts.forSession(state.selectedId)} busy={!!active} available={state.available} working={state.working} defaultMode={mode} />}
  </section>;
}
const LedgerRow = memo(function LedgerRow({ block, contributions, openManagement }: { block: LedgerBlock; contributions: UiSlotSnapshot; openManagement(): void }) {
  const t = useText(), language = useLanguage();
  const ToolView = contributions.toolViews.find(item => item.toolName === block.toolName)?.View ?? GenericToolDetails;
  const availability = contributions.toolAvailability.find(item => item.toolName === block.toolName)?.state;
  return <article className={`ledger-row ledger-${block.kind}`}><time dateTime={block.time}>{formatTime(block.time, language)}</time><span className="event-dot" aria-hidden="true" /><div className="event-body"><header><strong>{block.title}</strong>{block.status ? <span className="record-state">{({ "tool.started": t("执行中", "Running"), "tool.completed": t("已有结果", "Result available"), "tool.dispatched": t("已派发", "Dispatched") } as Record<string, string>)[block.status] ?? block.status}</span> : null}</header>
    {block.kind === "tool" ? <>{availability === "unavailable" ? <p className="historical-capability">{t("历史记录 · Host 工具入口当前不可用", "History · Host tool currently unavailable")}<button onClick={openManagement}>{t("查看插件管理", "View plugins")}</button></p> : availability === "unknown" ? <p className="historical-capability">{t("历史记录保留 · 当前能力状态尚未确认", "History preserved · current capability status unconfirmed")}</p> : null}<details><summary>{t("查看调用与输出", "View call and output")}</summary><IsolatedView View={ToolView} block={block} /></details></> : <>
      {block.reasoning ? <details className="reasoning"><summary>{t("推理输出", "Reasoning")}</summary><pre>{block.reasoning}</pre></details> : null}<div className="message-text">{block.text}</div>
    </>}
  </div></article>;
});
function Composer({ sessionId, composerItems, model, draft, busy, available, working, defaultMode }: { sessionId: string; composerItems: UiSlotSnapshot["composerItems"]; model: SessionClientModel; draft: ComposerDraft; busy: boolean; available: boolean; working: boolean; defaultMode: "queue" | "steer" }) {
  const t = useText();
  const text = useSnapshot(draft), setText = draft.set;
  const [error, setError] = useState<string | null>(null), [composing, setComposing] = useState(false);
  const stream = useSnapshot(model.run);
  async function send(mode: "queue" | "steer") {
    if (!text.trim() || working || !available) return;
    const submitted = text; setError(null);
    try { await model.send(submitted, mode); draft.accepted(submitted); }
    catch (cause) { setError(`${readableError(cause instanceof Error ? cause.message : t("发送失败", "Send failed"))}${t("。草稿已保留；结果不确定时先刷新核对。", ". Draft kept. If delivery is uncertain, refresh to check first.")}`); }
  }
  const pending = stream.deliveries.filter(item => item.status === "queued");
  return <footer className="composer"><ErrorNotice text={error} />
    {pending.length ? <div className="delivery-dock" role="status">{pending.map(item => <p key={item.id}><strong>{item.mode === "queue" ? t("队列", "Queued") : t("待送达引导", "Pending steering")}</strong><span>{item.text}</span></p>)}</div> : null}
    <div className={`message-composer-card composer-card${busy ? " busy" : ""}`}>
      <label className="sr-only" htmlFor="wish-composer">{t("消息", "Message")}</label>
      <textarea id="wish-composer" rows={2} maxLength={131072} value={text} placeholder={t("输入消息…", "Write a message…")} disabled={!available} onChange={event => setText(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(defaultMode); } }} />
      <div className="composer-actions">
        <div className="composer-tools">{composerItems.map(item => <IsolatedView key={item.id} View={item.View} sessionId={sessionId} busy={busy} />)}{!available ? <span className="muted">{t("业务服务不可用，草稿保留", "Agent unavailable; draft kept")}</span> : null}</div>
        {busy ? <><button disabled={working || !available} onClick={() => { setError(null); void model.abort().catch(cause => setError(readableError(cause.message))); }}>{t("停止运行", "Stop run")}</button><button disabled={working || !available || !text.trim()} onClick={() => { void send("steer"); }}>{t("引导", "Steer")}</button><button className="primary" disabled={working || !available || !text.trim()} onClick={() => { void send("queue"); }}>{t("加入队列", "Queue")}</button></> : <button className="composer-send" aria-label={working ? t("正在发送", "Sending") : t("发送消息", "Send message")} title={t("发送消息", "Send message")} disabled={working || !available || !text.trim()} onClick={() => { void send("queue"); }}><Icon name="send" /></button>}
      </div>
    </div>
  </footer>;
}
function formatTime(value: string, language: WishLanguage): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : ""; }
