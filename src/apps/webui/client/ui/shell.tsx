import { IsolatedView } from "./isolated-view.js";
import { useEffect, useRef, useState } from "react";
import type { UiSlots } from "../slots.js";
import type { ConnectionSnapshot } from "../connection.js";
import { Icon, useSnapshot, type ReadableSnapshot } from "./primitives.js";
import { useLanguage, useText } from "../i18n.js";

/** Only presentation state lives here; no Context, transport or module-name dispatch. */
export function Shell({ slots, connection }: { slots: UiSlots; connection: ReadableSnapshot<ConnectionSnapshot> }) {
  const language = useLanguage(), t = useText();
  const contributions = useSnapshot(slots), status = useSnapshot(connection);
  const [area, setArea] = useState<"workspace" | "settings">("workspace");
  const [selected, select] = useState<string | null>(null);
  const [collapsed, collapse] = useState(false), [drawerOpen, showDrawer] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const sidebarOpen = narrow ? drawerOpen : !collapsed, overlay = narrow && sidebarOpen;
  const navigation = useRef<HTMLElement>(null), expandButton = useRef<HTMLButtonElement>(null);
  const opening = useRef(false), wasOpen = useRef(sidebarOpen);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const resized = () => { setNarrow(media.matches); showDrawer(false); };
    media.addEventListener("change", resized);
    return () => media.removeEventListener("change", resized);
  }, []);
  useEffect(() => {
    if (sidebarOpen && opening.current) { navigation.current?.querySelector<HTMLButtonElement>("button")?.focus(); opening.current = false; }
    if (!sidebarOpen && wasOpen.current && (navigation.current?.contains(document.activeElement) || document.activeElement === document.body)) expandButton.current?.focus();
    wasOpen.current = sidebarOpen;
  }, [sidebarOpen]);
  function closeSidebar() { if (narrow) showDrawer(false); else collapse(true); }
  function openSidebar() { opening.current = true; if (narrow) showDrawer(true); else collapse(false); }
  const panels = contributions.panels.filter(panel => panel.area === area);
  const railPanels = contributions.panels.filter(panel => panel.navigation === "rail");
  useEffect(() => slots.onOpenPanel(id => {
    const target = slots.getSnapshot().panels.find(item => item.id === id);
    if (target) { target.onOpen?.(); setArea(target.area); select(id); showDrawer(false); }
  }), [slots]);
  const panel = panels.find(item => item.id === selected) ?? panels.find(item => item.defaultForArea?.()) ?? panels.find(item => item.navigation === undefined) ?? panels[0];
  const globalPanel = panel?.navigation === "rail";
  useEffect(() => { if (selected && !panels.some(item => item.id === selected)) { panel?.onOpen?.(); select(null); } }, [contributions, area, selected, panel]);
  function openArea(next: "workspace" | "settings") {
    const candidates = slots.getSnapshot().panels.filter(item => item.area === next);
    const target = candidates.find(item => item.defaultForArea?.()) ?? candidates.find(item => item.navigation === undefined);
    if (target) slots.openPanel(target.id);
    else { setArea(next); select(null); showDrawer(false); }
  }
  const panelLabel = (item: typeof panel) => item && language === "en-US" ? item.labelEn ?? item.label : item?.label;
  const sidebarTitle = globalPanel ? panelLabel(panel) : area === "workspace" ? t("执行工作区", "Workspace") : t("设置", "Settings");
  const connectionLabel = status.online ? t("Host 已连接", "Host connected") : t("Host 连接中断", "Host disconnected");
  return <div className={`wish-shell${sidebarOpen ? " sidebar-open" : " sidebar-collapsed"}`}>
    <a className="skip-link" href="#workspace-main">{t("跳到工作区", "Skip to workspace")}</a>
    <nav className="utility-rail" aria-label={t("主要导航", "Main navigation")}>
      <div className="brand-control">
        {sidebarOpen ? <span className="wordmark" aria-label="Wish">W</span> : <button ref={expandButton} className="brand-toggle" aria-label={t("展开侧栏", "Open sidebar")} title={t("展开侧栏", "Open sidebar")} aria-expanded={false} aria-controls="wish-sidebar" aria-describedby="host-connection-status" onClick={openSidebar}><span className="wordmark" aria-hidden="true">W</span><span className="brand-expand-icon"><Icon name="panel-open" /></span></button>}
        <span id="host-connection-status" role="status" className={`connection-state ${status.online ? "online" : "offline"}`} title={connectionLabel}><span className="sr-only">{connectionLabel}</span></span>
      </div>
      <button className={area === "workspace" && !globalPanel ? "rail-button active" : "rail-button"} aria-current={area === "workspace" && !globalPanel ? "page" : undefined} aria-label={t("执行工作区", "Workspace")} title={t("执行工作区", "Workspace")} onClick={() => openArea("workspace")}><Icon name="conversation" /></button>
      {railPanels.map(item => <button key={item.id} className={panel?.id === item.id ? "rail-button active" : "rail-button"} aria-current={panel?.id === item.id ? "page" : undefined} aria-label={panelLabel(item)} title={panelLabel(item)} onClick={() => slots.openPanel(item.id)}>{item.Icon ? <IsolatedView View={item.Icon} /> : <Icon name="trace" />}</button>)}
      <button className={area === "settings" && !globalPanel ? "rail-button active rail-bottom" : "rail-button rail-bottom"} aria-current={area === "settings" && !globalPanel ? "page" : undefined} aria-label={t("设置与插件", "Settings and plugins")} title={t("设置与插件", "Settings and plugins")} onClick={() => openArea("settings")}><Icon name="settings" /></button>
    </nav>
    {overlay ? <button className="navigation-backdrop" aria-label={t("关闭侧栏遮罩", "Close sidebar overlay")} tabIndex={-1} onClick={closeSidebar} /> : null}
    <aside id="wish-sidebar" ref={navigation} hidden={!sidebarOpen} tabIndex={-1} className="session-index" aria-label={t(`${sidebarTitle}侧栏`, `${sidebarTitle} sidebar`)} onClick={event => { if ((event.target as Element).closest("a")) showDrawer(false); }} onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeSidebar(); }
    }}>
      <header className="sidebar-header"><div><span className="brand">Wish</span><h2>{sidebarTitle}</h2></div><button className="icon-button" aria-label={t("收起侧栏", "Collapse sidebar")} title={t("收起侧栏", "Collapse sidebar")} aria-expanded={true} aria-controls="wish-sidebar" onClick={closeSidebar}><Icon name="panel-close" /></button></header>
      <div className="sidebar-content">{panel?.Sidebar ? <IsolatedView View={panel.Sidebar} /> : <>
        {area === "workspace" ? contributions.navigation.length ? contributions.navigation.filter(item => !item.forPanel || item.forPanel === panel?.id).map(item => <IsolatedView key={item.id} View={item.View} />) : <><h2>{t("会话", "Sessions")}</h2><p className="muted">{t("会话入口尚未加载。", "Session navigation has not loaded.")}</p></> : null}
        <nav className="panel-navigation" aria-label={t("可用视图", "Available views")}>{panels.filter(item => item.navigation === undefined).map(item => <button key={item.id} className={panel?.id === item.id ? "navigation-item selected" : "navigation-item"} onClick={() => slots.openPanel(item.id)} aria-current={panel?.id === item.id ? "page" : undefined}>{item.Icon ? <IsolatedView View={item.Icon} /> : <Icon name={area === "settings" ? "settings" : "trace"} />}{panelLabel(item)}</button>)}</nav>
      </>}</div>
    </aside>
    <main id="workspace-main" className="workspace-main" tabIndex={-1} inert={overlay}>
      {!status.online && status.error ? <p className="connection-notice" role="status">{status.error}</p> : null}
      {status.online && !status.businessAvailable ? <p className="connection-notice" role="status">{t("业务服务暂不可用。设置和插件管理仍可操作。", "Agent service is temporarily unavailable. Settings and plugins remain available.")}</p> : null}
      {contributions.notices.map(item => <IsolatedView key={item.id} View={item.View} />)}
      <div className="workspace-content">{panel ? <IsolatedView View={panel.View} /> : <section className="empty-state"><Icon name="trace" /><h1>{t("执行记录", "Activity")}</h1><p>{t("这里按轮次展示对话、工具调用和子 Agent 的执行过程。", "Conversations, tool calls, and subagent work appear here by turn.")}</p><p className="muted">{t("当前没有已加载的会话视图。你可以先检查插件状态。", "No session view is loaded. Check plugin status first.")}</p><button className="primary" onClick={() => openArea("settings")}>{t("打开设置与插件", "Open settings and plugins")}</button></section>}</div>
    </main>
  </div>;
}
