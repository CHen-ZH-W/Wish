import { IsolatedView } from "./isolated-view.js";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { SessionClientModel } from "../model/session.js";
import type { SettingsClientModel } from "../../../../settings/consumers/webui/model.js";
import { projectLedger, type LedgerBlock } from "../projection/ledger.js";
import { Icon, ErrorNotice, readableError, useSnapshot } from "./primitives.js";
import type { UiSessionSidebarResource, UiSessionSidebarTab, UiSessionSidebarTabActions, UiSlots, UiSlotSnapshot } from "../slots.js";
import { GenericToolDetails } from "./tool.js";
import type { ComposerDraft, ComposerDrafts } from "./drafts.js";
import { useLanguage, useText } from "../i18n.js";
import type { WishLanguage } from "../theme.js";
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
  const [sidebarOpen, setSidebarOpen] = useState(wideSessionSidebar);
  const [sidebarOverlay, setSidebarOverlay] = useState(() => !wideSessionSidebar());
  const [sidebarPreference, setSidebarPreference] = useState(() => defaultRightSidebarWidth(typeof window === "undefined" ? 1240 : Math.max(700, window.innerWidth - 328)));
  const [conversationWidth, setConversationWidth] = useState(0);
  const [dockLayouts, setDockLayouts] = useState<Record<string, SessionDockLayout>>(loadDockLayouts);
  const conversation = useRef<HTMLElement>(null), sidebarToggle = useRef<HTMLButtonElement>(null), sidebar = useRef<HTMLElement>(null);
  const widthInitialized = useRef(false);
  const sidebarWide = useRef(wideSessionSidebar());
  const openingSidebar = useRef(false), sidebarWasOpen = useRef(sidebarOpen);
  const categories = [...new Map(contributions.toolViews.flatMap(item => item.category ? [[item.category.id, item.category] as const] : [])).values()];
  const extensionBlocks = contributions.ledgerContributions.flatMap(item => item.source.getSnapshot());
  const sidebarKinds = useMemo(() => contributions.sessionSidebarItems.map(item => item.kind ?? item.id), [contributions.sessionSidebarItems]);
  const sidebarLayout = state.selectedId ? reconcileSessionDockLayout(dockLayouts[state.selectedId], sidebarKinds) : createSessionDockLayout(sidebarKinds);
  const sidebarFullscreen = sidebarOpen && sidebarLayout.fullscreen;
  const sidebarMaxWidth = rightSidebarMaxWidth(conversationWidth || 1240);
  const sidebarWidth = sidebarMaxWidth > 0 ? Math.min(sidebarPreference, sidebarMaxWidth) : 0;
  const allTurns = useMemo(() => projectLedger(state.history, stream.events, language, extensionBlocks), [state.history, stream.events, language, contributions]);
  const turns = useMemo(() => filter === "all" ? allTurns : allTurns.map(turn => ({ ...turn, blocks: turn.blocks.filter(block => filter === "tools" ? block.kind === "tool" : contributions.toolViews.some(item => item.toolName === block.toolName && item.category?.id === filter)) })).filter(turn => turn.blocks.length), [allTurns, filter, contributions.toolViews]);
  useEffect(() => { if (filter !== "all" && filter !== "tools" && !categories.some(item => item.id === filter)) setFilter("all"); }, [contributions.toolViews, filter]);
  const session = state.sessions.find(item => item.sessionId === state.selectedId), active = state.runs.find(item => item.status === "running");
  const archived = session?.status === "archived";
  const mode = preferences.sections.find(item => item.namespace === "webui-composer")?.value["busy-delivery"] === "steer" ? "steer" : "queue";
  useEffect(() => { setFollow(true); }, [state.selectedId]);
  useEffect(() => { saveDockLayouts(dockLayouts); }, [dockLayouts]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [turns, follow]);
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
      if (wide !== sidebarWide.current) setSidebarOpen(wide);
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
      <header className="ledger-header"><div><h1>{session?.title || t("执行记录", "Activity")}</h1><p className="muted workspace-path" title={session?.scope}>{session?.scope}</p></div><nav className="ledger-filters" aria-label={t("记录筛选", "Activity filters")}>{[{ id: "all", label: t("全部", "All") }, { id: "tools", label: t("工具", "Tools") }, ...categories].map(item => <button key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{language === "en-US" && "labelEn" in item ? item.labelEn ?? item.label : item.label}</button>)}</nav><span className={`run-state ${active ? "running" : ""}`}>{archived ? t("已归档", "Archived") : active ? t("运行中", "Running") : t("等待请求", "Waiting")}</span>{!sidebarOpen ? <button ref={sidebarToggle} className="icon-button session-sidebar-toggle" aria-label={t("打开会话侧栏", "Open session sidebar")} title={t("打开会话侧栏", "Open session sidebar")} aria-expanded={false} aria-controls="session-sidebar" onClick={openSidebar}><Icon name="panel-right-open" /></button> : null}</header>
      <div className="ledger-scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 96); }}>
        <ErrorNotice text={state.error ? readableError(state.error) : null} />
        {stream.error ? <p className="notice warning">{stream.error}</p> : null}
        {!turns.length ? <div className="ledger-welcome"><h2>{allTurns.length ? t("此筛选下没有记录", "No activity matches this filter") : t("这个会话还没有执行记录", "No activity in this session yet")}</h2><p>{allTurns.length ? t("可以切换“全部”查看完整过程。", "Choose All to see the full history.") : t("描述你要完成的工作。过程会按轮次和步骤排列在这里。", "Describe what you want done. The work will appear here by turn and step.")}</p></div> : turns.map(turn => <section className="ledger-turn" key={turn.id} id={`turn-${encodeURIComponent(turn.id)}`}><header className="turn-heading"><span>{language === "en-US" ? `Turn ${allTurns.findIndex(item => item.id === turn.id) + 1}` : `第 ${allTurns.findIndex(item => item.id === turn.id) + 1} 轮`}</span><span className="turn-rule" /></header>{turn.blocks.map((block, index) => <div className="ledger-step" key={block.id}>{block.stepId && turn.blocks[index - 1]?.stepId !== block.stepId ? <p className="step-location" title={block.stepId}>Step {block.stepId.split(":").at(-1)}</p> : null}<LedgerRow block={block} contributions={contributions} openManagement={() => slots.openPanel("plugins")} /></div>)}</section>)}
        {active ? <p className="live-status" role="status">{stream.connected ? t("正在接收运行事件…", "Receiving run events…") : t("正在核对运行状态…", "Checking run status…")}</p> : null}
      </div>
      {!archived ? contributions.interactions.map(item => <IsolatedView key={item.id} View={item.View} />) : null}
      {!follow ? <button className="follow-latest" onClick={() => setFollow(true)}>{t("回到最新记录", "Jump to latest")}</button> : null}
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
        const openTab = (kind: string, options: { readonly title?: string; readonly params?: Readonly<Record<string, unknown>>; readonly replace?: boolean } = {}): void => {
          const definition = items.find(candidate => (candidate.kind ?? candidate.id) === kind);
          if (!definition) return;
          const title = options.title ?? (language === "en-US" ? definition.labelEn ?? definition.label : definition.label);
          updateLayout(current => openSessionDockTab(current, pane.id, {
            kind,
            contentId: definition.multiple ? `${kind}:${crypto.randomUUID()}` : `page:${kind}`,
            title,
            ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
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
            {tab ? <nav className="session-dock-tabs" role="tablist" aria-label={t(`会话面板 ${paneIndex + 1} 标签页`, `Session pane ${paneIndex + 1} tabs`)}>
              {pane.tabIds.map((tabId, tabIndex) => { const candidate = layout.tabs[tabId]; if (!candidate) return null; const selected = candidate.id === tab.id; const definition = items.find(value => (value.kind ?? value.id) === candidate.kind); return <span key={candidate.id} className="session-dock-tab" data-selected={selected || undefined}><button id={`session-dock-tab-${pane.id}-${tabIndex}`} role="tab" aria-selected={selected} aria-controls={selected ? `${panelId}-${candidate.id}` : undefined} tabIndex={selected ? 0 : -1} data-session-sidebar-focus={selected || undefined} onKeyDown={moveDockTabFocus} onClick={() => updateLayout(current => selectSessionDockTab(current, pane.id, candidate.id))}>{definition?.icon ? <Icon name={definition.icon} /> : null}<span>{candidate.title}</span></button><button className="session-dock-tab-close" aria-label={t(`关闭 ${candidate.title}`, `Close ${candidate.title}`)} title={t("关闭标签页", "Close tab")} onClick={event => { event.stopPropagation(); definition?.onClose?.(sessionId, runtimeTab(candidate, selected && visible)); updateLayout(current => closeSessionDockTab(current, candidate.id)); }}><Icon name="close" /></button></span>; })}
            </nav> : <nav className="session-dock-tabs" role="tablist" aria-label={t(`会话面板 ${paneIndex + 1} 功能`, `Session pane ${paneIndex + 1} features`)}><button id={`session-dock-guide-tab-${pane.id}`} className="session-dock-guide-tab" role="tab" aria-selected={true} aria-controls={`${panelId}-guide`} data-session-sidebar-focus><span>{t("开始", "Start")}</span></button></nav>}
            <div className="session-dock-strip-fill" />
            {items.length ? <button className="session-dock-icon" aria-label={t("新标签页", "New tab")} title={t("选择其他功能", "Choose another feature")} onClick={event => { event.stopPropagation(); pendingPaneFocus.current = pane.id; updateLayout(current => openSessionDockGuide(current, pane.id)); }}><Icon name="plus" /></button> : null}
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
          })}{tab && !item ? <div className="session-sidebar-empty"><p>{t("正在恢复这个标签页…", "Restoring this tab…")}</p><small>{t("对应界面模块尚未就绪；标签和资源不会被删除。", "Its UI module is not ready yet; the tab and resource are preserved.")}</small></div> : !tab && items.length ? <div id={`${panelId}-guide`} className="session-sidebar-guide" role="tabpanel" aria-labelledby={`session-dock-guide-tab-${pane.id}`}><nav className="session-sidebar-guide-options" aria-label={t("选择会话侧栏功能", "Choose a session sidebar feature")}>{items.filter(candidate => candidate.guide !== false).map(candidate => {
            const label = language === "en-US" ? candidate.labelEn ?? candidate.label : candidate.label;
            const description = items.length <= 4 ? language === "en-US" ? candidate.descriptionEn ?? candidate.description : candidate.description : undefined;
            if (candidate.Guide) return <IsolatedView key={candidate.id} View={candidate.Guide} sessionId={sessionId} open={(options?: { readonly title?: string; readonly params?: Readonly<Record<string, unknown>>; readonly replace?: boolean }) => { pendingPaneFocus.current = pane.id; openTab(candidate.kind ?? candidate.id, { replace: true, ...options }); }} />;
            return <button key={candidate.id} className="session-sidebar-guide-entry" data-session-sidebar-guide-entry={candidate.id} aria-label={t(`打开 ${label}`, `Open ${label}`)} aria-description={description} onClick={() => { pendingPaneFocus.current = pane.id; openTab(candidate.kind ?? candidate.id, { replace: true }); }}><span className="session-sidebar-guide-entry-icon" aria-hidden="true"><Icon name={candidate.icon ?? "cube"} /></span><span className="session-sidebar-guide-entry-text"><span className="session-sidebar-guide-entry-title">{label}</span>{description ? <span className="session-sidebar-guide-entry-description">{description}</span> : null}</span></button>;
          })}</nav></div> : !tab ? <div className="session-sidebar-empty"><p>{t("此会话暂时没有侧栏内容。", "No sidebar content for this session yet.")}</p><small>{t("与当前会话相关的运行界面会显示在这里。", "Session-related runtime views will appear here.")}</small></div> : null}</div>
        </section>;
      })}
    </div>
  </aside>;
}
function runtimeTab(tab: { readonly id: string; readonly kind: string; readonly contentId: string; readonly title: string; readonly params?: Readonly<Record<string, unknown>> }, visible: boolean): UiSessionSidebarTab {
  return Object.freeze({ ...tab, visible });
}
const DOCK_STORAGE_KEY = "wish.session-dock.v2";
function loadDockLayouts(): Record<string, SessionDockLayout> {
  try { const value: unknown = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? "{}"); return value && typeof value === "object" ? value as Record<string, SessionDockLayout> : {}; }
  catch { return {}; }
}
function saveDockLayouts(layouts: Record<string, SessionDockLayout>): void {
  try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(layouts)); } catch { /* Layout persistence is optional. */ }
}
function moveDockTabFocus(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabs = [...event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? []];
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
const LedgerRow = memo(function LedgerRow({ block, contributions, openManagement }: { block: LedgerBlock; contributions: UiSlotSnapshot; openManagement(): void }) {
  const t = useText(), language = useLanguage();
  const ToolView = contributions.toolViews.find(item => item.toolName === block.toolName)?.View ?? GenericToolDetails;
  const LedgerView = block.viewId === undefined ? undefined : contributions.ledgerContributions.find(item => item.id === block.viewId)?.View;
  const availability = contributions.toolAvailability.find(item => item.toolName === block.toolName)?.state;
  return <article className={`ledger-row ledger-${block.kind}${LedgerView ? " ledger-contributed" : ""}`}><time dateTime={block.time}>{formatTime(block.time, language)}</time><span className="event-dot" aria-hidden="true" /><div className="event-body">{LedgerView ? <IsolatedView View={LedgerView} block={block} /> : <><header><strong>{block.title}</strong>{block.status ? <span className="record-state">{({ "tool.started": t("执行中", "Running"), "tool.completed": t("已有结果", "Result available"), "tool.dispatched": t("已派发", "Dispatched") } as Record<string, string>)[block.status] ?? block.status}</span> : null}</header>
    {block.kind === "tool" ? <>{availability === "unavailable" ? <p className="historical-capability">{t("历史记录 · Host 工具入口当前不可用", "History · Host tool currently unavailable")}<button onClick={openManagement}>{t("查看插件管理", "View plugins")}</button></p> : availability === "unknown" ? <p className="historical-capability">{t("历史记录保留 · 当前能力状态尚未确认", "History preserved · current capability status unconfirmed")}</p> : null}<details><summary>{t("查看调用与输出", "View call and output")}</summary><IsolatedView View={ToolView} block={block} /></details></> : <>
      {block.reasoning ? <details className="reasoning"><summary>{t("推理输出", "Reasoning")}</summary><pre>{block.reasoning}</pre></details> : null}{block.kind === "assistant" ? <div className="message-text message-markdown"><MarkdownContent source={block.text} /></div> : <div className="message-text">{block.text}</div>}
    </>}</>}
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
