import { IsolatedView } from "./isolated-view.js";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { SessionClientModel } from "../model/session.js";
import type { SettingsClientModel } from "../../../../settings/consumers/webui/model.js";
import { projectConversationTurns, projectLedger, type ConversationTurn, type LedgerBlock } from "../projection/ledger.js";
import { Icon, ErrorNotice, readableError, useSnapshot } from "./primitives.js";
import type { UiSessionSidebarResource, UiSessionSidebarTab, UiSessionSidebarTabActions, UiSlots, UiSlotSnapshot } from "../slots.js";
import type { ComposerDraft, ComposerDrafts } from "./drafts.js";
import { useLanguage, useText } from "../i18n.js";
import {
  closeSessionDockPane,
  closeSessionDockTab,
  createSessionDockLayout,
  focusSessionDockPane,
  openSessionDockGuide,
  openSessionDockTab,
  reconcileSessionDockLayout,
  selectSessionDockTab,
  splitSessionDockPane,
  toggleSessionDockFullscreen,
  updateSessionDockTab,
  type SessionDockLayout,
} from "./session-dock.js";
import { defaultRightSidebarWidth, rightSidebarMaxWidth, RIGHT_SIDEBAR_MIN_WIDTH, SidebarResizeHandle } from "./sidebar-resize.js";
import { MarkdownContent } from "./markdown.js";

const LEDGER_PAGE_TURNS = 24;

export function tailLedgerTurns<T>(turns: readonly T[], limit: number): readonly T[] {
  return turns.length > limit ? turns.slice(-limit) : turns;
}

export function RoundNavigation({ model, slots }: { model: SessionClientModel; slots: UiSlots }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model);
  const history = state.history?.sessionId === state.selectedId ? state.history : null;
  const turns = useMemo(() => projectConversationTurns(projectLedger(history, [], language)).filter(turn => turn.requests.length), [history, language]);
  return state.selectedId && turns.length ? <nav className="round-navigation" aria-label={t("本会话轮次", "Turns in this session")}><h2>{t("轮次", "Turns")}</h2>{turns.map((turn, index) => <a key={turn.id} href={`#turn-${encodeURIComponent(turn.id)}`} onClick={event => {
    event.preventDefault();
    slots.openLedgerTurn({ sessionId: state.selectedId!, turnId: turn.id, requiredTurns: turns.length - index });
  }}><span>{index + 1}</span><span>{turn.title}</span></a>)}</nav> : null;
}

export function ConversationViewTabs({ slots, current, archived }: { slots: UiSlots; current: "conversation" | "tool-calls"; archived: boolean }) {
  const t = useText();
  return <nav className="conversation-view-tabs" aria-label={t("会话内容", "Conversation content")}>
    <button type="button" aria-current={current === "conversation" ? "page" : undefined} onClick={() => slots.openPanel(archived ? "archives" : "conversation")}>{t("主会话", "Conversation")}</button>
    <button type="button" aria-current={current === "tool-calls" ? "page" : undefined} onClick={() => slots.openPanel("tool-calls")}>{t("工具调用", "Tool calls")}</button>
  </nav>;
}

export function Conversation({ model, settings, slots, drafts }: { model: SessionClientModel; settings: SettingsClientModel; slots: UiSlots; drafts: ComposerDrafts }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), stream = useSnapshot(model.run), preferences = useSnapshot(settings);
  const contributions = useSnapshot(slots);
  const [error, setError] = useState<string | null>(null), [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const prependScrollHeight = useRef<number | null>(null);
  const [ledgerWindow, setLedgerWindow] = useState({ sessionId: state.selectedId, limit: LEDGER_PAGE_TURNS });
  const [requestedTurnId, setRequestedTurnId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarOverlay, setSidebarOverlay] = useState(() => !wideSessionSidebar());
  const [sidebarPreference, setSidebarPreference] = useState(() => defaultRightSidebarWidth(typeof window === "undefined" ? 1240 : Math.max(700, window.innerWidth - 328)));
  const [conversationWidth, setConversationWidth] = useState(0);
  const [dockLayouts, setDockLayouts] = useState<Record<string, SessionDockLayout>>({});
  const conversation = useRef<HTMLElement>(null), sidebarToggle = useRef<HTMLButtonElement>(null), sidebar = useRef<HTMLElement>(null);
  const widthInitialized = useRef(false);
  const sidebarWide = useRef(wideSessionSidebar());
  const openingSidebar = useRef(false), sidebarWasOpen = useRef(sidebarOpen);
  const historyReady = state.history?.sessionId === state.selectedId;
  const topContributions = historyReady ? contributions.ledgerContributions.flatMap(item => {
    const block = item.source.getSnapshot().at(-1);
    return block === undefined ? [] : [{ item, block }];
  }) : [];
  const sidebarKinds = useMemo(() => contributions.sessionSidebarItems.map(item => item.kind ?? item.id), [contributions.sessionSidebarItems]);
  const sidebarLayout = state.selectedId ? reconcileSessionDockLayout(dockLayouts[state.selectedId], sidebarKinds) : createSessionDockLayout(sidebarKinds);
  const sidebarFullscreen = sidebarOpen && sidebarLayout.fullscreen;
  const sidebarMaxWidth = rightSidebarMaxWidth(conversationWidth || 1240);
  const sidebarWidth = sidebarMaxWidth > 0 ? Math.min(sidebarPreference, sidebarMaxWidth) : 0;
  const canonicalLedger = useMemo(() => projectLedger(state.history, [], language), [state.history, language]);
  const combinedLedger = useMemo(() => projectLedger(state.history, stream.events, language), [state.history, stream.events, language]);
  const canonicalTurns = useMemo(() => projectConversationTurns(canonicalLedger), [canonicalLedger]);
  const active = state.runs.find(item => item.status === "running");
  const cleanupError = [...state.runs].reverse().find(item => item.cleanupError)?.cleanupError;
  const focusRunId = active?.runId ?? (stream.terminal ? stream.runId : null);
  const focusLedgerTurn = focusRunId === null ? undefined : [...combinedLedger].reverse().find(turn => turn.blocks.some(block => block.runId === focusRunId));
  const focusTurn = useMemo(() => focusLedgerTurn === undefined ? undefined : projectConversationTurns([focusLedgerTurn], active && !stream.terminal ? focusLedgerTurn.id : null)[0], [focusLedgerTurn, active, stream.terminal]);
  const allTurns = useMemo(() => {
    if (!focusTurn) return canonicalTurns;
    const index = canonicalTurns.findIndex(turn => turn.id === focusTurn.id);
    if (index < 0) return Object.freeze([...canonicalTurns, focusTurn]);
    return Object.freeze(canonicalTurns.map((turn, turnIndex) => turnIndex === index ? focusTurn : turn));
  }, [canonicalTurns, focusTurn]);
  const turns = allTurns;
  const turnLimit = ledgerWindow.sessionId === state.selectedId ? ledgerWindow.limit : LEDGER_PAGE_TURNS;
  const visibleTurns = useMemo(() => tailLedgerTurns(turns, turnLimit), [turns, turnLimit]);
  const hiddenTurnCount = turns.length - visibleTurns.length;
  const session = state.sessions.find(item => item.sessionId === state.selectedId);
  const archived = session?.status === "archived";
  const mode = preferences.sections.find(item => item.namespace === "webui-composer")?.value["busy-delivery"] === "steer" ? "steer" : "queue";
  useEffect(() => { setFollow(true); }, [state.selectedId]);
  useEffect(() => slots.onOpenLedgerTurn(request => {
    if (request.sessionId !== state.selectedId) return;
    setFollow(false);
    setLedgerWindow(current => ({ sessionId: request.sessionId, limit: Math.max(current.sessionId === request.sessionId ? current.limit : LEDGER_PAGE_TURNS, request.requiredTurns) }));
    setRequestedTurnId(request.turnId);
  }), [slots, state.selectedId]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [turns, follow]);
  useLayoutEffect(() => {
    const before = prependScrollHeight.current, node = scroll.current;
    if (before === null || !node) return;
    node.scrollTop += node.scrollHeight - before;
    prependScrollHeight.current = null;
  }, [visibleTurns.length, state.selectedId]);
  useLayoutEffect(() => {
    if (!requestedTurnId) return;
    const target = document.getElementById(`turn-${encodeURIComponent(requestedTurnId)}`);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    window.history.replaceState(null, "", `#turn-${encodeURIComponent(requestedTurnId)}`);
    setRequestedTurnId(null);
  }, [requestedTurnId, visibleTurns.length]);
  useLayoutEffect(() => {
    const node = conversation.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      if (width <= 0) return;
      setConversationWidth(width);
      if (!widthInitialized.current) {
        widthInitialized.current = true;
        setSidebarPreference(defaultRightSidebarWidth(width));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1181px)");
    const adapt = () => {
      const wide = media.matches;
      setSidebarOverlay(!wide);
      if (!wide && sidebarWide.current) setSidebarOpen(false);
      sidebarWide.current = wide;
    };
    media.addEventListener("change", adapt);
    return () => media.removeEventListener("change", adapt);
  }, []);
  useEffect(() => {
    if (sidebarOpen && openingSidebar.current) {
      sidebar.current?.querySelector<HTMLButtonElement>("[data-session-sidebar-focus],button:not(:disabled)")?.focus();
      openingSidebar.current = false;
    } else if (!sidebarOpen && sidebarWasOpen.current) sidebarToggle.current?.focus();
    sidebarWasOpen.current = sidebarOpen;
  }, [sidebarOpen]);
  useEffect(() => {
    if (!state.selectedId) return;
    setDockLayouts(current => {
      const next = reconcileSessionDockLayout(current[state.selectedId!], sidebarKinds);
      return next === current[state.selectedId!] ? current : { ...current, [state.selectedId!]: next };
    });
  }, [state.selectedId, sidebarKinds]);
  function openSidebar() { openingSidebar.current = true; setSidebarOpen(true); }
  function closeSidebar() { setSidebarOpen(false); }
  function updateSidebarLayout(update: (layout: SessionDockLayout) => SessionDockLayout) {
    if (!state.selectedId) return;
    const sessionId = state.selectedId;
    setDockLayouts(current => {
      const before = reconcileSessionDockLayout(current[sessionId], sidebarKinds), next = update(before);
      return next === current[sessionId] ? current : { ...current, [sessionId]: next };
    });
  }
  if (!state.selectedId && state.loading) return null;
  if (!state.selectedId && state.filter === "archived") return <section className="empty-state"><Icon name="archive" /><h1>{t("还没有归档会话", "No archived sessions")}</h1><p>{t("归档后的会话会按工作区显示在侧栏中，聊天记录可以随时查看。", "Archived sessions appear by workspace in the sidebar. Their conversation history remains available.")}</p><ErrorNotice text={state.error ? readableError(state.error) : null} /></section>;
  if (!state.selectedId) return <section className="empty-state"><Icon name="trace" /><h1>{t("还没有选择会话", "No session selected")}</h1><p>{t("新会话需要先绑定工作区；确认前不会在 Host 中留下空会话。", "Choose a workspace before starting a session. No empty Host session is created until you send a message.")}</p><ErrorNotice text={error} /><button className="primary" disabled={!state.available || state.working} onClick={() => slots.openPanel("new-session")}>{t("新建会话", "New session")}</button></section>;
  return <section ref={conversation} className={`conversation ${sidebarOpen ? "session-sidebar-open" : "session-sidebar-closed"}${sidebarFullscreen ? " session-sidebar-fullscreen" : ""}`} style={{ "--session-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <div className="conversation-main" inert={sidebarOpen && (sidebarOverlay || sidebarFullscreen)}>
      <header className="ledger-header">
        <div className="ledger-header-title"><h1>{session?.title || t("会话", "Conversation")}</h1><p className="muted workspace-path" title={session?.scope}>{session?.scope}</p></div>
        <ConversationViewTabs slots={slots} current="conversation" archived={archived} />
        <div className="ledger-header-actions">{archived || active ? <span className={`run-state ${active ? "running" : ""}`}>{archived ? t("已归档", "Archived") : t("运行中", "Running")}</span> : null}{!sidebarOpen ? <button ref={sidebarToggle} className="icon-button session-sidebar-toggle" aria-label={t("打开会话侧栏", "Open session sidebar")} title={t("打开会话侧栏", "Open session sidebar")} aria-expanded={false} aria-controls="session-sidebar" onClick={openSidebar}><Icon name="panel-right-open" /></button> : null}</div>
      </header>
      <div className="ledger-scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 96); }}>
        {topContributions.length ? <section className="conversation-top-context" aria-label={t("会话上下文", "Conversation context")}>{topContributions.map(({ item, block }) => <IsolatedView key={item.id} View={item.View} block={block} />)}</section> : null}
        <div className="conversation-ledger-layout">
          {historyReady && contributions.conversationCards.length ? <aside className="conversation-card-stack" aria-label={t("会话任务", "Session tasks")}>{contributions.conversationCards.map(item => <IsolatedView key={item.id} View={item.View} sessionId={state.selectedId!} />)}</aside> : null}
          <div className="conversation-ledger-feed">
            <ErrorNotice text={state.error ? readableError(state.error) : null} />
            {cleanupError ? <p className="notice warning" role="alert">{t("运行收尾或派生状态清理失败；会话仍可重试删除：", "Run finalization or derived-state cleanup failed; Session deletion can be retried:")} {cleanupError}</p> : null}
            {stream.error ? <p className="notice warning">{stream.error}</p> : null}
            {hiddenTurnCount > 0 ? <div className="ledger-load-earlier"><button onClick={() => {
              const node = scroll.current;
              prependScrollHeight.current = node?.scrollHeight ?? null;
              setFollow(false);
              setLedgerWindow({ sessionId: state.selectedId, limit: turnLimit + LEDGER_PAGE_TURNS });
            }}>{t(`加载更早轮次（还剩 ${hiddenTurnCount} 轮）`, `Load earlier turns (${hiddenTurnCount} remaining)`)}</button></div> : null}
            {!historyReady && state.loading ? <div className="ledger-welcome" role="status"><h2>{t("正在加载会话…", "Loading conversation…")}</h2><p>{t("完整会话加载后会显示在这里。", "The full conversation will appear here when it is ready.")}</p></div> : !turns.length ? <div className="ledger-welcome"><h2>{t("这个会话还没有消息", "No messages in this conversation yet")}</h2><p>{t("描述你要完成的工作，Wish 会在这里显示过程和最终回答。", "Describe what you want done. Wish will show its work and final answer here.")}</p></div> : visibleTurns.map(turn => <ConversationTurnView key={turn.id} turn={turn} number={allTurns.findIndex(item => item.id === turn.id) + 1} connected={stream.connected} />)}
          </div>
        </div>
      </div>
      {!archived ? contributions.interactions.map(item => <IsolatedView key={item.id} View={item.View} />) : null}
      {!follow ? <button className="follow-latest" onClick={() => setFollow(true)}>{t("回到最新", "Jump to latest")}</button> : null}
      <div className="conversation-footer">
        {archived ? <footer className="composer archived-hint"><span>{t("已归档，聊天记录只读。", "Archived. Conversation history is read-only.")}</span><button disabled={!state.available || state.working} onClick={() => { setError(null); void model.restore(state.selectedId!).catch(cause => setError(readableError(cause.message))); }}>{t("取消归档", "Restore")}</button><ErrorNotice text={error} /></footer> : <Composer key={state.selectedId} sessionId={state.selectedId} composerItems={contributions.composerItems} model={model} draft={drafts.forSession(state.selectedId)} busy={!!active} available={state.available} working={state.working} defaultMode={mode} />}
        {contributions.sessionStatusItems.length ? <div className="session-status-dock" aria-label={t("会话统计", "Session statistics")}>{contributions.sessionStatusItems.map(item => <IsolatedView key={item.id} View={item.View} sessionId={state.selectedId!} />)}</div> : null}
      </div>
    </div>
    {sidebarOpen ? <><button className="session-sidebar-backdrop" aria-label={t("关闭会话侧栏遮罩", "Close session sidebar overlay")} tabIndex={-1} onClick={closeSidebar} />{sidebarMaxWidth >= RIGHT_SIDEBAR_MIN_WIDTH ? <SidebarResizeHandle side="right" width={sidebarWidth} min={RIGHT_SIDEBAR_MIN_WIDTH} max={sidebarMaxWidth} label={t("调整右侧栏宽度", "Resize right sidebar")} controls="session-sidebar" onChange={setSidebarPreference} /> : null}</> : null}
    <SessionSidebar sidebarRef={sidebar} items={contributions.sessionSidebarItems} sessionId={state.selectedId} layout={sidebarLayout} visible={sidebarOpen} updateLayout={updateSidebarLayout} close={closeSidebar} />
  </section>;
}
function SessionSidebar({ sidebarRef, items, sessionId, layout, visible, updateLayout, close }: { sidebarRef: RefObject<HTMLElement | null>; items: UiSlotSnapshot["sessionSidebarItems"]; sessionId: string; layout: SessionDockLayout; visible: boolean; updateLayout(update: (layout: SessionDockLayout) => SessionDockLayout): void; close(): void }) {
  const language = useLanguage(), t = useText();
  const [hasSplitRoom, setHasSplitRoom] = useState(false);
  const pendingPaneFocus = useRef<string | null>(null);
  const guideItems = items.filter(candidate => candidate.guide !== false);
  const tabLimitReached = Object.keys(layout.tabs).length >= 100;
  useEffect(() => {
    const node = sidebarRef.current;
    if (!node) return;
    const measure = () => setHasSplitRoom(node.clientWidth >= 560);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [sidebarRef]);
  useEffect(() => {
    const paneId = pendingPaneFocus.current;
    if (!paneId) return;
    pendingPaneFocus.current = null;
    sidebarRef.current?.querySelector<HTMLButtonElement>(`[data-session-dock-pane="${paneId}"] [data-session-sidebar-focus]`)?.focus();
  }, [layout, sidebarRef]);
  return <aside ref={sidebarRef} id="session-sidebar" className="session-sidebar" aria-label={t("会话侧栏", "Session sidebar")} data-fullscreen={layout.fullscreen || undefined} hidden={!visible} onKeyDown={event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (layout.fullscreen) updateLayout(toggleSessionDockFullscreen); else close();
  }}>
    <div className="session-dock" data-pane-count={layout.panes.length}>
      {layout.panes.map((pane, paneIndex) => {
        const tab = pane.activeTabId === null ? undefined : layout.tabs[pane.activeTabId];
        const item = tab === undefined ? undefined : items.find(candidate => (candidate.kind ?? candidate.id) === tab.kind);
        const panelId = `session-dock-panel-${pane.id}`;
        const openTab = (kind: string, options: { readonly title?: string; readonly params?: Readonly<Record<string, unknown>>; readonly replace?: boolean } = {}, append = false): void => {
          const definition = items.find(candidate => (candidate.kind ?? candidate.id) === kind);
          if (!definition) return;
          const title = options.title ?? (language === "en-US" ? definition.labelEn ?? definition.label : definition.label);
          updateLayout(current => openSessionDockTab(current, pane.id, {
            kind,
            contentId: append || definition.multiple ? `${kind}:${crypto.randomUUID()}` : `page:${kind}`,
            title,
            multiple: append || definition.multiple === true,
            ...(options.replace === undefined ? {} : { replace: options.replace }),
            ...(options.params === undefined ? {} : { params: options.params }),
          }));
        };
        const openResource = (resource: UiSessionSidebarResource): void => {
          const definition = items.find(candidate => candidate.accepts?.(resource));
          if (!definition) return;
          const kind = definition.kind ?? definition.id;
          updateLayout(current => openSessionDockTab(current, pane.id, { kind, contentId: resource.contentId, title: resource.title, multiple: false, ...(resource.params === undefined ? {} : { params: resource.params }) }));
        };
        return <section key={pane.id} data-session-dock-pane={pane.id} className={`session-dock-pane${layout.activePaneId === pane.id ? " active" : ""}`} aria-label={t(`会话面板 ${paneIndex + 1}`, `Session pane ${paneIndex + 1}`)} onPointerDown={() => updateLayout(current => focusSessionDockPane(current, pane.id))}>
          <header className="session-dock-strip">
            <nav className="session-dock-tabs" role="tablist" aria-label={t(`会话面板 ${paneIndex + 1} 标签页`, `Session pane ${paneIndex + 1} tabs`)}>
              {pane.tabIds.map((tabId, tabIndex) => { const candidate = layout.tabs[tabId]; if (!candidate) return null; const selected = candidate.id === pane.activeTabId; const definition = items.find(value => (value.kind ?? value.id) === candidate.kind); return <span key={candidate.id} className="session-dock-tab" data-selected={selected || undefined}><button id={`session-dock-tab-${pane.id}-${tabIndex}`} role="tab" aria-selected={selected} aria-controls={selected ? `${panelId}-${candidate.id}` : undefined} tabIndex={selected ? 0 : -1} data-session-sidebar-focus={selected || undefined} onKeyDown={moveDockTabFocus} onClick={() => updateLayout(current => selectSessionDockTab(current, pane.id, candidate.id))}>{definition?.icon ? <Icon name={definition.icon} /> : null}<span>{candidate.title}</span></button><button className="session-dock-tab-close" aria-label={t(`关闭 ${candidate.title}`, `Close ${candidate.title}`)} title={t("关闭标签页", "Close tab")} onClick={event => { event.stopPropagation(); definition?.onClose?.(sessionId, runtimeTab(candidate, selected && visible)); updateLayout(current => closeSessionDockTab(current, candidate.id)); }}><Icon name="close" /></button></span>; })}
              {!tab ? <button id={`session-dock-guide-tab-${pane.id}`} className="session-dock-guide-tab" role="tab" aria-selected={true} aria-controls={`${panelId}-guide`} tabIndex={0} data-session-sidebar-focus onKeyDown={moveDockTabFocus}><span>{t("开始", "Start")}</span></button> : null}
            </nav>
            <div className="session-dock-strip-fill" />
            <button className="session-dock-icon" aria-label={t("新标签页", "New tab")} title={tabLimitReached ? t("窗口已达到上限", "Window limit reached") : t("添加工作窗口", "Add work window")} disabled={tabLimitReached} onClick={event => { event.stopPropagation(); pendingPaneFocus.current = pane.id; updateLayout(current => openSessionDockGuide(current, pane.id)); }}><Icon name="plus" /></button>
            {layout.panes.length < 2 ? <button className="session-dock-icon" aria-label={t("分屏", "Split pane")} title={!layout.fullscreen ? t("请先全屏再分屏", "Enter fullscreen before splitting") : hasSplitRoom ? t("向右分屏", "Split to the right") : t("空间不足，无法分屏", "Not enough room to split")} disabled={!layout.fullscreen || !hasSplitRoom} onClick={event => { event.stopPropagation(); updateLayout(current => { const next = splitSessionDockPane(current, pane.id); if (next !== current) pendingPaneFocus.current = next.activePaneId; return next; }); }}><Icon name="split" /></button> : <button className="session-dock-icon" aria-label={t("关闭此分屏", "Close this pane")} title={t("关闭此分屏", "Close this pane")} onClick={event => { event.stopPropagation(); const closingPane = layout.panes.find(value => value.id === pane.id); for (const tabId of closingPane?.tabIds ?? []) { const closingTab = layout.tabs[tabId]; const definition = closingTab && items.find(value => (value.kind ?? value.id) === closingTab.kind); if (closingTab) definition?.onClose?.(sessionId, runtimeTab(closingTab, false)); } updateLayout(current => closeSessionDockPane(current, pane.id)); }}><Icon name="close" /></button>}
            {paneIndex === layout.panes.length - 1 || (!layout.fullscreen && layout.activePaneId === pane.id) ? <div className="session-dock-chrome">
              <button className="session-dock-icon session-dock-fullscreen-toggle" aria-label={layout.fullscreen ? t("退出全屏", "Exit fullscreen") : t("全屏", "Fullscreen")} title={layout.fullscreen ? t("退出全屏", "Exit fullscreen") : t("全屏", "Fullscreen")} aria-pressed={layout.fullscreen} onClick={event => { event.stopPropagation(); updateLayout(toggleSessionDockFullscreen); }}><Icon name={layout.fullscreen ? "fullscreen-exit" : "fullscreen"} /></button>
              <button className="session-dock-icon" aria-label={t("收起会话侧栏", "Close session sidebar")} title={t("收起会话侧栏", "Close session sidebar")} aria-expanded={true} aria-controls="session-sidebar" onClick={event => { event.stopPropagation(); close(); }}><Icon name="panel-right-close" /></button>
            </div> : null}
          </header>
          <div className="session-dock-content">{pane.tabIds.map((tabId, tabIndex) => {
            const candidate = layout.tabs[tabId];
            const definition = candidate === undefined ? undefined : items.find(value => (value.kind ?? value.id) === candidate.kind);
            if (!candidate || !definition) return null;
            const selected = candidate.id === pane.activeTabId;
            const actions: UiSessionSidebarTabActions = {
              openTab,
              openResource,
              update: (params, title) => updateLayout(current => updateSessionDockTab(current, candidate.id, params, title)),
              close: () => { definition.onClose?.(sessionId, runtimeTab(candidate, selected && visible)); updateLayout(current => closeSessionDockTab(current, candidate.id)); },
            };
            return <div key={candidate.id} id={`${panelId}-${candidate.id}`} className="session-dock-view" role="tabpanel" aria-labelledby={`session-dock-tab-${pane.id}-${tabIndex}`} hidden={!selected}><IsolatedView View={definition.View} sessionId={sessionId} tab={runtimeTab(candidate, selected && visible)} actions={actions} /></div>;
          })}{tab && !item ? <div className="session-sidebar-empty"><p>{t("正在恢复这个标签页…", "Restoring this tab…")}</p><small>{t("对应界面模块尚未就绪；标签和资源不会被删除。", "Its UI module is not ready yet; the tab and resource are preserved.")}</small></div> : !tab ? <div id={`${panelId}-guide`} className="session-sidebar-guide" role="tabpanel" aria-labelledby={`session-dock-guide-tab-${pane.id}`}><nav className="session-sidebar-guide-options" aria-label={t("可添加的窗口", "Available windows")}>{guideItems.map(candidate => {
            const label = language === "en-US" ? candidate.labelEn ?? candidate.label : candidate.label;
            const description = guideItems.length <= 4 ? language === "en-US" ? candidate.descriptionEn ?? candidate.description : candidate.description : undefined;
            if (candidate.Guide) return <IsolatedView key={candidate.id} View={candidate.Guide} sessionId={sessionId} open={(options?: { readonly title?: string; readonly params?: Readonly<Record<string, unknown>>; readonly replace?: boolean }) => { pendingPaneFocus.current = pane.id; openTab(candidate.kind ?? candidate.id, { ...options, replace: false }, true); }} />;
            return <button key={candidate.id} className="session-sidebar-guide-entry" data-session-sidebar-guide-entry={candidate.id} aria-label={t(`打开 ${label}`, `Open ${label}`)} aria-description={description} onClick={() => { pendingPaneFocus.current = pane.id; openTab(candidate.kind ?? candidate.id, {}, true); }}><span className="session-sidebar-guide-entry-icon" aria-hidden="true"><Icon name={candidate.icon ?? "cube"} /></span><span className="session-sidebar-guide-entry-text"><span className="session-sidebar-guide-entry-title">{label}</span>{description ? <span className="session-sidebar-guide-entry-description">{description}</span> : null}</span></button>;
          })}</nav>{!guideItems.length ? <p className="session-sidebar-empty">{t("目前没有可添加的窗口。", "No windows are available to add.")}</p> : null}</div> : null}</div>
        </section>;
      })}
    </div>
  </aside>;
}
function runtimeTab(tab: { readonly id: string; readonly kind: string; readonly contentId: string; readonly title: string; readonly params?: Readonly<Record<string, unknown>> }, visible: boolean): UiSessionSidebarTab {
  return Object.freeze({ ...tab, visible });
}
function moveDockTabFocus(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabs = [...event.currentTarget.closest("[role=tablist]")?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? []];
  const current = tabs.indexOf(event.currentTarget);
  let next: number | undefined;
  if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  const target = next === undefined ? undefined : tabs[next];
  if (!target) return;
  event.preventDefault(); target.focus();
}
function wideSessionSidebar(): boolean { return typeof window !== "undefined" && window.matchMedia("(min-width: 1181px)").matches; }
const ConversationTurnView = memo(function ConversationTurnView({ turn, number, connected }: { turn: ConversationTurn; number: number; connected: boolean }) {
  const language = useLanguage();
  return <section className={`conversation-turn${turn.live ? " live" : ""}`} id={`turn-${encodeURIComponent(turn.id)}`}>
    <header className="turn-heading"><span>{language === "en-US" ? `Turn ${number}` : `第 ${number} 轮`}</span></header>
    {turn.requests.map(block => <article className="conversation-request" key={block.id}><div className="message-text">{block.text}</div></article>)}
    {turn.live ? <LiveRunView blocks={turn.process} connected={connected} /> : <>
      {turn.process.length ? <ProcessDisclosure blocks={turn.process} toolCount={turn.toolCount} failed={turn.failed} stopped={turn.stopped} /> : null}
      {turn.answer ? <FinalAnswer block={turn.answer} /> : null}
    </>}
  </section>;
});
const FinalAnswer = memo(function FinalAnswer({ block }: { block: LedgerBlock }) {
  const t = useText();
  return <article className="final-answer"><header><strong>Wish</strong><span>{t("最终回答", "Final answer")}</span></header><div className="message-text message-markdown"><MarkdownContent source={block.text} /></div></article>;
});
const LiveRunView = memo(function LiveRunView({ blocks, connected }: { blocks: readonly LedgerBlock[]; connected: boolean }) {
  const t = useText(), replying = blocks.some(block => block.kind === "assistant" && block.text.trim().length > 0);
  return <section className="live-run" aria-busy="true"><header><span className="live-run-indicator" aria-hidden="true" /><strong role="status" aria-live="polite">{connected ? replying ? t("Wish 正在回复", "Wish is responding") : t("Wish 正在工作", "Wish is working") : t("正在核对运行状态", "Checking run status")}</strong></header>
    <div className="process-list">{blocks.length ? blocks.map(block => <ActivityRow key={block.id} block={block} live />) : <p className="live-run-empty">{t("正在分析你的请求…", "Analyzing your request…")}</p>}</div>
  </section>;
});
const ProcessDisclosure = memo(function ProcessDisclosure({ blocks, toolCount, failed, stopped }: { blocks: readonly LedgerBlock[]; toolCount: number; failed: boolean; stopped: boolean }) {
  const t = useText(), hasReasoning = blocks.some(block => !!block.reasoning);
  const summary = toolCount > 0
    ? t(`${toolCount} 个工具${hasReasoning ? " · 包含思考过程" : ""}`, `${toolCount} tool${toolCount === 1 ? "" : "s"}${hasReasoning ? " · reasoning included" : ""}`)
    : hasReasoning ? t("包含思考过程", "Reasoning included") : t(`${blocks.length} 项活动`, `${blocks.length} activit${blocks.length === 1 ? "y" : "ies"}`);
  return <details className={`process-disclosure${failed ? " failed" : stopped ? " stopped" : ""}`} open={failed || undefined}><summary><span className="process-state" aria-hidden="true" /><strong>{failed ? t("运行失败", "Run failed") : stopped ? t("运行已停止", "Run stopped") : t("查看过程", "View process")}</strong>{!stopped || blocks.length > 1 ? <small>{summary}</small> : null}</summary><div className="process-list">{blocks.map(block => <ActivityRow key={block.id} block={block} live={false} />)}</div></details>;
});
const ActivityRow = memo(function ActivityRow({ block, live }: { block: LedgerBlock; live: boolean }) {
  const t = useText();
  if (block.kind === "tool") {
    const status = toolStatus(block.status, t);
    return <article className={`process-activity tool-activity ${status.tone}`}><header><span className="activity-indicator" aria-hidden="true" /><strong>{block.title}</strong><span className="activity-status">{status.label}</span></header></article>;
  }
  if (block.kind === "system") return <article className={`process-activity ${block.status === "run.aborted" ? "process-stopped" : "process-error"}`}><header><span className="activity-indicator" aria-hidden="true" /><strong>{block.title}</strong></header>{block.text ? <p>{block.text}</p> : null}</article>;
  return <article className="process-activity model-activity">
    {block.reasoning ? <details className="reasoning" open={live || undefined}><summary>{live ? t("正在思考", "Thinking") : t("思考过程", "Thinking process")}</summary><pre>{block.reasoning}</pre></details> : null}
    {block.text ? <div className={live ? "live-stream-text" : "message-text message-markdown"}>{live ? block.text : <MarkdownContent source={block.text} />}</div> : null}
  </article>;
});
function toolStatus(status: string | undefined, t: ReturnType<typeof useText>): { label: string; tone: "pending" | "success" | "failed" | "neutral" } {
  switch (status) {
    case "tool.queued": return { label: t("排队中", "Queued"), tone: "pending" };
    case "tool.prepared": return { label: t("准备中", "Preparing"), tone: "pending" };
    case "tool.authorization_requested": return { label: t("等待批准", "Awaiting approval"), tone: "pending" };
    case "tool.dispatched": return { label: t("执行中", "Running"), tone: "pending" };
    case "tool.completed": return { label: t("已完成", "Completed"), tone: "success" };
    case "tool.failed": return { label: t("失败", "Failed"), tone: "failed" };
    case "tool.aborted": return { label: t("已停止", "Stopped"), tone: "failed" };
    case "tool.authorization_denied": return { label: t("未获批准", "Denied"), tone: "failed" };
    case "tool.recorded": return { label: t("已记录", "Recorded"), tone: "neutral" };
    default: return { label: status ?? t("已记录", "Recorded"), tone: "neutral" };
  }
}
function Composer({ sessionId, composerItems, model, draft, busy, available, working, defaultMode }: { sessionId: string; composerItems: UiSlotSnapshot["composerItems"]; model: SessionClientModel; draft: ComposerDraft; busy: boolean; available: boolean; working: boolean; defaultMode: "queue" | "steer" }) {
  const t = useText();
  const text = useSnapshot(draft), setText = draft.set;
  const [error, setError] = useState<string | null>(null), [composing, setComposing] = useState(false), [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);
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
        {busy ? <><button disabled={working || !available} onClick={() => { setError(null); setStoppingSessionId(sessionId); void model.abort().catch(cause => setError(readableError(cause.message))).finally(() => setStoppingSessionId(current => current === sessionId ? null : current)); }}>{stoppingSessionId === sessionId ? t("正在停止…", "Stopping…") : t("停止运行", "Stop run")}</button><button disabled={working || !available || !text.trim()} onClick={() => { void send("steer"); }}>{t("引导", "Steer")}</button><button className="primary" disabled={working || !available || !text.trim()} onClick={() => { void send("queue"); }}>{t("加入队列", "Queue")}</button></> : <button className="composer-send" aria-label={working ? t("正在发送", "Sending") : t("发送消息", "Send message")} title={t("发送消息", "Send message")} disabled={working || !available || !text.trim()} onClick={() => { void send("queue"); }}><Icon name="send" /></button>}
      </div>
    </div>
  </footer>;
}
