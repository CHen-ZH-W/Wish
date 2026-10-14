export interface SessionDockPane {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

export interface SessionDockTab {
  readonly id: string;
  readonly kind: string;
  readonly contentId: string;
  readonly title: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface SessionDockLayout {
  readonly panes: readonly SessionDockPane[];
  readonly tabs: Readonly<Record<string, SessionDockTab>>;
  readonly activePaneId: string;
  readonly fullscreen: boolean;
  readonly nextPane: number;
  readonly nextTab: number;
}

export function createSessionDockLayout(_kinds: readonly string[]): SessionDockLayout {
  return Object.freeze({
    panes: Object.freeze([Object.freeze({ id: "pane-1", tabIds: Object.freeze([]), activeTabId: null })]),
    tabs: Object.freeze({}),
    activePaneId: "pane-1",
    fullscreen: false,
    nextPane: 2,
    nextTab: 1,
  });
}

export function reconcileSessionDockLayout(layout: SessionDockLayout | undefined, kinds: readonly string[]): SessionDockLayout {
  if (!isSessionDockLayout(layout)) return createSessionDockLayout(kinds);
  let changed = false;
  // A client module may mount after the persisted layout is read, or disappear
  // briefly during HMR. Keep valid resource tabs until the user closes them.
  const tabs = layout.tabs;
  const panes = layout.panes.slice(0, 2).map(pane => {
    const tabIds = pane.tabIds.filter(id => tabs[id] !== undefined);
    const activeTabId = pane.activeTabId === null ? null : tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds.at(-1) ?? null;
    if (tabIds.length === pane.tabIds.length && activeTabId === pane.activeTabId) return pane;
    changed = true;
    return Object.freeze({ ...pane, tabIds: Object.freeze(tabIds), activeTabId });
  });
  if (panes.length !== layout.panes.length || panes.length === 0) changed = true;
  if (panes.length === 0) return createSessionDockLayout(kinds);
  const activePaneId = panes.some(pane => pane.id === layout.activePaneId) ? layout.activePaneId : panes[0]!.id;
  if (activePaneId !== layout.activePaneId) changed = true;
  return changed ? Object.freeze({ ...layout, panes: Object.freeze(panes), tabs: Object.freeze(tabs), activePaneId }) : layout;
}

function isSessionDockLayout(value: SessionDockLayout | undefined): value is SessionDockLayout {
  if (!value || typeof value !== "object" || !Array.isArray(value.panes) || value.panes.length === 0 || value.panes.length > 2) return false;
  if (!value.tabs || typeof value.tabs !== "object" || Array.isArray(value.tabs)) return false;
  if (typeof value.activePaneId !== "string" || typeof value.fullscreen !== "boolean") return false;
  if (!Number.isSafeInteger(value.nextPane) || value.nextPane < 1 || !Number.isSafeInteger(value.nextTab) || value.nextTab < 1) return false;
  const tabs = Object.values(value.tabs);
  if (tabs.length > 100 || tabs.some(tab => !tab || typeof tab.id !== "string" || typeof tab.kind !== "string" || typeof tab.contentId !== "string" || typeof tab.title !== "string")) return false;
  const tabIds = new Set(tabs.map(tab => tab.id));
  return value.panes.every(pane => pane && typeof pane.id === "string" && Array.isArray(pane.tabIds)
    && pane.tabIds.every((id: unknown) => typeof id === "string" && tabIds.has(id))
    && (pane.activeTabId === null || typeof pane.activeTabId === "string"));
}

export function selectSessionDockTab(layout: SessionDockLayout, paneId: string, tabId: string): SessionDockLayout {
  const target = layout.panes.find(pane => pane.id === paneId);
  if (!target?.tabIds.includes(tabId)) return layout;
  if (layout.activePaneId === paneId && target.activeTabId === tabId) return layout;
  const panes = layout.panes.map(pane => pane.id === paneId && pane.tabIds.includes(tabId) ? Object.freeze({ ...pane, activeTabId: tabId }) : pane);
  return Object.freeze({ ...layout, panes: Object.freeze(panes), activePaneId: paneId });
}

export function openSessionDockGuide(layout: SessionDockLayout, paneId: string): SessionDockLayout {
  const panes = layout.panes.map(pane => pane.id === paneId ? Object.freeze({ ...pane, activeTabId: null }) : pane);
  if (panes.every((pane, index) => pane === layout.panes[index])) return layout;
  return Object.freeze({ ...layout, panes: Object.freeze(panes), activePaneId: paneId });
}

export function openSessionDockTab(layout: SessionDockLayout, paneId: string, input: Omit<SessionDockTab, "id"> & { readonly multiple?: boolean; readonly replace?: boolean }): SessionDockLayout {
  const target = layout.panes.find(pane => pane.id === paneId) ?? layout.panes[0];
  if (!target) return layout;
  if (!input.multiple) {
    const existing = Object.values(layout.tabs).find(tab => tab.kind === input.kind && tab.contentId === input.contentId);
    if (existing) {
      const owner = layout.panes.find(pane => pane.tabIds.includes(existing.id));
      return owner ? selectSessionDockTab(layout, owner.id, existing.id) : layout;
    }
  }
  const id = `tab-${layout.nextTab}`;
  const tab = Object.freeze({ id, kind: input.kind, contentId: input.contentId, title: input.title, ...(input.params === undefined ? {} : { params: input.params }) });
  let removed: string | undefined;
  const panes = layout.panes.map(pane => {
    if (pane.id !== target.id) return pane;
    const tabIds = [...pane.tabIds];
    if (input.replace && pane.activeTabId !== null) {
      removed = pane.activeTabId;
      tabIds.splice(Math.max(0, tabIds.indexOf(pane.activeTabId)), 1, id);
    } else tabIds.push(id);
    return Object.freeze({ ...pane, tabIds: Object.freeze(tabIds), activeTabId: id });
  });
  const tabs = { ...layout.tabs, [id]: tab };
  if (removed) delete tabs[removed];
  return Object.freeze({ ...layout, panes: Object.freeze(panes), tabs: Object.freeze(tabs), activePaneId: target.id, nextTab: layout.nextTab + 1 });
}

export function updateSessionDockTab(layout: SessionDockLayout, tabId: string, params: Readonly<Record<string, unknown>>, title?: string): SessionDockLayout {
  const tab = layout.tabs[tabId];
  if (!tab) return layout;
  return Object.freeze({ ...layout, tabs: Object.freeze({ ...layout.tabs, [tabId]: Object.freeze({ ...tab, params, ...(title === undefined ? {} : { title }) }) }) });
}

export function closeSessionDockTab(layout: SessionDockLayout, tabId: string): SessionDockLayout {
  if (!layout.tabs[tabId]) return layout;
  const tabs = { ...layout.tabs }; delete tabs[tabId];
  const panes = layout.panes.map(pane => {
    const index = pane.tabIds.indexOf(tabId);
    if (index < 0) return pane;
    const tabIds = pane.tabIds.filter(id => id !== tabId);
    const activeTabId = pane.activeTabId === tabId ? tabIds[Math.min(index, tabIds.length - 1)] ?? null : pane.activeTabId;
    return Object.freeze({ ...pane, tabIds: Object.freeze(tabIds), activeTabId });
  });
  return Object.freeze({ ...layout, panes: Object.freeze(panes), tabs: Object.freeze(tabs) });
}

export function focusSessionDockPane(layout: SessionDockLayout, paneId: string): SessionDockLayout {
  return layout.activePaneId === paneId ? layout : Object.freeze({ ...layout, activePaneId: paneId });
}

export function splitSessionDockPane(layout: SessionDockLayout, paneId: string): SessionDockLayout {
  if (!layout.fullscreen || layout.panes.length >= 2) return layout;
  const index = layout.panes.findIndex(pane => pane.id === paneId);
  if (index < 0) return layout;
  const id = `pane-${layout.nextPane}`;
  const panes = [...layout.panes];
  panes.splice(index + 1, 0, Object.freeze({ id, tabIds: Object.freeze([]), activeTabId: null }));
  return Object.freeze({ ...layout, panes: Object.freeze(panes), activePaneId: id, nextPane: layout.nextPane + 1 });
}

export function closeSessionDockPane(layout: SessionDockLayout, paneId: string): SessionDockLayout {
  if (layout.panes.length <= 1) return layout;
  const removed = layout.panes.find(pane => pane.id === paneId);
  const panes = layout.panes.filter(pane => pane.id !== paneId);
  if (panes.length === layout.panes.length) return layout;
  const activePaneId = layout.activePaneId === paneId ? panes.at(-1)!.id : layout.activePaneId;
  const tabs = { ...layout.tabs };
  for (const tabId of removed?.tabIds ?? []) delete tabs[tabId];
  return Object.freeze({ ...layout, panes: Object.freeze(panes), tabs: Object.freeze(tabs), activePaneId });
}

export function toggleSessionDockFullscreen(layout: SessionDockLayout): SessionDockLayout {
  return Object.freeze({ ...layout, fullscreen: !layout.fullscreen });
}
