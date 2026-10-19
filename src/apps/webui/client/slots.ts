import type { ComponentType } from "react";
import { SnapshotStore } from "./model/store.js";
import type { LedgerBlock } from "./projection/ledger.js";

export interface UiPanel {
  readonly id: string; readonly label: string; readonly labelEn?: string; readonly area: "workspace" | "settings";
  readonly View: ComponentType; readonly Icon?: ComponentType;
  /** Global rail entry instead of the area-local panel list. */
  readonly navigation?: "rail" | "hidden";
  /** Named local groups appear only while one of their members is open. */
  readonly navigationGroup?: string;
  /** Optional owner-provided sidebar replaces the area's default navigation. */
  readonly Sidebar?: ComponentType;
  /** Owner updates its presentation selection before the panel is shown. */
  readonly onOpen?: () => void;
  /** Optional owner-selected landing for this area; Shell does not inspect business state. */
  readonly defaultForArea?: () => boolean;
}
export interface UiNavigation { readonly id: string; readonly View: ComponentType; readonly forPanel?: string }
export interface UiLedgerNavigationRequest { readonly sessionId: string; readonly turnId: string; readonly requiredTurns: number }
export interface UiComposerItem { readonly id: string; readonly View: ComponentType<{ sessionId: string; busy: boolean }> }
export interface UiNewSessionComposerItem { readonly id: string; readonly View: ComponentType<{ disabled: boolean }> }
export interface UiSessionStatusItem { readonly id: string; readonly View: ComponentType<{ sessionId: string }> }
export interface UiConversationCard { readonly id: string; readonly order?: number; readonly View: ComponentType<{ sessionId: string }> }
export interface UiSessionSidebarResource {
  readonly kind: string;
  readonly contentId: string;
  readonly title: string;
  readonly params?: Readonly<Record<string, unknown>>;
}
export interface UiSessionSidebarTab {
  readonly id: string;
  readonly kind: string;
  readonly contentId: string;
  readonly title: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly visible: boolean;
}
export interface UiSessionSidebarTabActions {
  openTab(kind: string, options?: { readonly title?: string; readonly params?: Readonly<Record<string, unknown>>; readonly replace?: boolean }): void;
  openResource(resource: UiSessionSidebarResource): void;
  update(params: Readonly<Record<string, unknown>>, title?: string): void;
  close(): void;
}
export interface UiSessionSidebarViewProps {
  readonly sessionId: string;
  readonly tab: UiSessionSidebarTab;
  readonly actions: UiSessionSidebarTabActions;
}
export interface UiSessionSidebarGuideProps {
  readonly sessionId: string;
  open(options?: { readonly title?: string; readonly params?: Readonly<Record<string, unknown>>; readonly replace?: boolean }): void;
}
export interface UiSessionSidebarItem {
  readonly id: string;
  /** Stable tab kind. Defaults to id. */
  readonly kind?: string;
  /** Stable Start-page position; lower values appear first regardless of module load order. */
  readonly order?: number;
  readonly label: string;
  readonly labelEn?: string;
  readonly description?: string;
  readonly descriptionEn?: string;
  readonly icon?: "terminal" | "tmux" | "trace" | "book" | "model" | "folder" | "plug";
  /** Whether repeated programmatic opens create independent tabs. */
  readonly multiple?: boolean;
  /** Resource-only definitions do not appear on the Start page. */
  readonly guide?: boolean;
  readonly accepts?: (resource: UiSessionSidebarResource) => boolean;
  /** Optional owner-rendered launcher, for example a Host-discovered shell menu. */
  readonly Guide?: ComponentType<UiSessionSidebarGuideProps>;
  readonly View: ComponentType<UiSessionSidebarViewProps>;
  readonly onClose?: (sessionId: string, tab: UiSessionSidebarTab) => void;
}
export interface UiLedgerContribution {
  readonly id: string;
  readonly source: { getSnapshot(): readonly LedgerBlock[]; subscribe(listener: () => void): () => void };
  readonly View: ComponentType<{ block: LedgerBlock }>;
}
export interface UiToolView { readonly toolName: string; readonly View: ComponentType<{ block: LedgerBlock }>; readonly category?: { readonly id: string; readonly label: string; readonly labelEn?: string } }
export interface UiToolAvailability { readonly toolName: string; readonly state: "available" | "unavailable" | "unknown" }
export interface UiSlotSnapshot { readonly panels: readonly UiPanel[]; readonly navigation: readonly UiNavigation[]; readonly interactions: readonly UiNavigation[]; readonly composerItems: readonly UiComposerItem[]; readonly newSessionComposerItems: readonly UiNewSessionComposerItem[]; readonly sessionStatusItems: readonly UiSessionStatusItem[]; readonly conversationCards: readonly UiConversationCard[]; readonly sessionSidebarItems: readonly UiSessionSidebarItem[]; readonly ledgerContributions: readonly UiLedgerContribution[]; readonly toolViews: readonly UiToolView[]; readonly toolAvailability: readonly UiToolAvailability[]; readonly notices: readonly UiNavigation[] }

/** Presentation registrations only. Removing an owner removes its seats, not business history. */
export class UiSlots extends SnapshotStore<UiSlotSnapshot> {
  constructor() { super(Object.freeze({ panels: Object.freeze([]), navigation: Object.freeze([]), interactions: Object.freeze([]), composerItems: Object.freeze([]), newSessionComposerItems: Object.freeze([]), sessionStatusItems: Object.freeze([]), conversationCards: Object.freeze([]), sessionSidebarItems: Object.freeze([]), ledgerContributions: Object.freeze([]), toolViews: Object.freeze([]), toolAvailability: Object.freeze([]), notices: Object.freeze([]) })); }
  private pending: UiSlotSnapshot | undefined;
  private current(): UiSlotSnapshot { return this.pending ?? this.getSnapshot(); }
  protected override publish(value: UiSlotSnapshot): void { if (this.pending) this.pending = Object.freeze(value); else super.publish(value); }
  /** The caller serializes replacements. Readers never see an intermediate empty seat. */
  async batch(action: () => Promise<void>): Promise<void> {
    if (this.pending) throw new Error("UI contribution batches must be serialized");
    const before = this.getSnapshot(); this.pending = before;
    try { await action(); }
    finally {
      const next = this.pending; this.pending = undefined;
      const order = <T>(previous: readonly T[], entries: readonly T[], key: (item: T) => string): readonly T[] => {
        const rank = new Map(previous.map((item, index) => [key(item), index]));
        return Object.freeze([...entries].sort((a, b) => (rank.get(key(a)) ?? previous.length) - (rank.get(key(b)) ?? previous.length)));
      };
      super.publish(next === before ? next : { ...next,
        panels: order(before.panels, next.panels, item => item.id), navigation: order(before.navigation, next.navigation, item => item.id),
        interactions: order(before.interactions, next.interactions, item => item.id), composerItems: order(before.composerItems, next.composerItems, item => item.id), newSessionComposerItems: order(before.newSessionComposerItems, next.newSessionComposerItems, item => item.id), sessionStatusItems: order(before.sessionStatusItems, next.sessionStatusItems, item => item.id), conversationCards: orderedConversationCards(order(before.conversationCards, next.conversationCards, item => item.id)), sessionSidebarItems: orderedSessionSidebar(order(before.sessionSidebarItems, next.sessionSidebarItems, item => item.id)), ledgerContributions: order(before.ledgerContributions, next.ledgerContributions, item => item.id), notices: order(before.notices, next.notices, item => item.id),
        toolViews: order(before.toolViews, next.toolViews, item => item.toolName) });
    }
  }
  notice(entry: UiNavigation): () => void {
    if (this.current().notices.some(item => item.id === entry.id)) throw new Error(`Duplicate UI notice: ${entry.id}`);
    this.publish({ ...this.current(), notices: Object.freeze([...this.current().notices, entry]) });
    return () => this.publish({ ...this.current(), notices: Object.freeze(this.current().notices.filter(item => item !== entry)) });
  }
  private navigationListeners = new Set<(id: string) => void>();
  private requestedPanel: string | null = null;
  openPanel = (id: string): void => { this.requestedPanel = id; for (const listener of this.navigationListeners) listener(id); };
  /** An owner may choose the first view, but never override an explicit navigation. */
  openPanelIfIdle = (id: string): void => { if (this.requestedPanel === null) this.openPanel(id); };
  onOpenPanel(listener: (id: string) => void): () => void { this.navigationListeners.add(listener); if (this.requestedPanel !== null) listener(this.requestedPanel); return () => { this.navigationListeners.delete(listener); }; }
  private ledgerNavigationListeners = new Set<(request: UiLedgerNavigationRequest) => void>();
  openLedgerTurn = (request: UiLedgerNavigationRequest): void => { for (const listener of this.ledgerNavigationListeners) listener(request); };
  onOpenLedgerTurn(listener: (request: UiLedgerNavigationRequest) => void): () => void { this.ledgerNavigationListeners.add(listener); return () => { this.ledgerNavigationListeners.delete(listener); }; }
  setToolAvailability(toolName: string, state: UiToolAvailability["state"]): void {
    if (this.current().toolAvailability.some(item => item.toolName === toolName && item.state === state)) return;
    this.publish({ ...this.current(), toolAvailability: Object.freeze([...this.current().toolAvailability.filter(item => item.toolName !== toolName), Object.freeze({ toolName, state })]) });
  }
  tool(view: UiToolView): () => void {
    if (this.current().toolViews.some(item => item.toolName === view.toolName)) throw new Error(`Duplicate Tool renderer: ${view.toolName}`);
    this.publish({ ...this.current(), toolViews: Object.freeze([...this.current().toolViews, view]) });
    return () => this.publish({ ...this.current(), toolViews: Object.freeze(this.current().toolViews.filter(item => item !== view)) });
  }
  interaction(entry: UiNavigation): () => void {
    if (this.current().interactions.some(item => item.id === entry.id)) throw new Error(`Duplicate UI interaction: ${entry.id}`);
    this.publish({ ...this.current(), interactions: Object.freeze([...this.current().interactions, entry]) });
    return () => this.publish({ ...this.current(), interactions: Object.freeze(this.current().interactions.filter(item => item !== entry)) });
  }
  composer(entry: UiComposerItem): () => void {
    if (this.current().composerItems.some(item => item.id === entry.id)) throw new Error(`Duplicate UI composer item: ${entry.id}`);
    const item = Object.freeze({ ...entry });
    this.publish({ ...this.current(), composerItems: Object.freeze([...this.current().composerItems, item]) });
    return () => this.publish({ ...this.current(), composerItems: Object.freeze(this.current().composerItems.filter(candidate => candidate !== item)) });
  }
  newSessionComposer(entry: UiNewSessionComposerItem): () => void {
    if (this.current().newSessionComposerItems.some(item => item.id === entry.id)) throw new Error(`Duplicate new-session composer item: ${entry.id}`);
    const item = Object.freeze({ ...entry });
    this.publish({ ...this.current(), newSessionComposerItems: Object.freeze([...this.current().newSessionComposerItems, item]) });
    return () => this.publish({ ...this.current(), newSessionComposerItems: Object.freeze(this.current().newSessionComposerItems.filter(candidate => candidate !== item)) });
  }
  sessionStatus(entry: UiSessionStatusItem): () => void {
    if (this.current().sessionStatusItems.some(item => item.id === entry.id)) throw new Error(`Duplicate Session status item: ${entry.id}`);
    const item = Object.freeze({ ...entry });
    this.publish({ ...this.current(), sessionStatusItems: Object.freeze([...this.current().sessionStatusItems, item]) });
    return () => this.publish({ ...this.current(), sessionStatusItems: Object.freeze(this.current().sessionStatusItems.filter(candidate => candidate !== item)) });
  }
  conversationCard(entry: UiConversationCard): () => void {
    if (this.current().conversationCards.some(item => item.id === entry.id)) throw new Error(`Duplicate conversation card: ${entry.id}`);
    const item = Object.freeze({ ...entry });
    this.publish({ ...this.current(), conversationCards: orderedConversationCards([...this.current().conversationCards, item]) });
    return () => this.publish({ ...this.current(), conversationCards: Object.freeze(this.current().conversationCards.filter(candidate => candidate !== item)) });
  }
  sessionSidebar(entry: UiSessionSidebarItem): () => void {
    if (this.current().sessionSidebarItems.some(item => item.id === entry.id)) throw new Error(`Duplicate Session sidebar item: ${entry.id}`);
    const item = Object.freeze({ ...entry });
    this.publish({ ...this.current(), sessionSidebarItems: orderedSessionSidebar([...this.current().sessionSidebarItems, item]) });
    return () => this.publish({ ...this.current(), sessionSidebarItems: Object.freeze(this.current().sessionSidebarItems.filter(candidate => candidate !== item)) });
  }
  ledger(entry: UiLedgerContribution): () => void {
    if (this.current().ledgerContributions.some(item => item.id === entry.id)) throw new Error(`Duplicate ledger contribution: ${entry.id}`);
    const item = Object.freeze({ ...entry });
    const refresh = () => this.publish({ ...this.current() });
    const unsubscribe = item.source.subscribe(refresh);
    this.publish({ ...this.current(), ledgerContributions: Object.freeze([...this.current().ledgerContributions, item]) });
    return () => {
      unsubscribe();
      this.publish({ ...this.current(), ledgerContributions: Object.freeze(this.current().ledgerContributions.filter(candidate => candidate !== item)) });
    };
  }
  panel(panel: UiPanel): () => void {
    if (this.current().panels.some(item => item.id === panel.id)) throw new Error(`Duplicate UI panel: ${panel.id}`);
    const entry = Object.freeze({ ...panel });
    this.publish({ ...this.current(), panels: Object.freeze([...this.current().panels, entry]) });
    return () => this.publish({ ...this.current(), panels: Object.freeze(this.current().panels.filter(item => item !== entry)) });
  }
  navigation(entry: UiNavigation): () => void {
    if (this.current().navigation.some(item => item.id === entry.id)) throw new Error(`Duplicate UI navigation: ${entry.id}`);
    this.publish({ ...this.current(), navigation: Object.freeze([...this.current().navigation, entry]) });
    return () => this.publish({ ...this.current(), navigation: Object.freeze(this.current().navigation.filter(item => item !== entry)) });
  }
}

function orderedSessionSidebar(items: readonly UiSessionSidebarItem[]): readonly UiSessionSidebarItem[] {
  return Object.freeze([...items].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)));
}
function orderedConversationCards(items: readonly UiConversationCard[]): readonly UiConversationCard[] {
  return Object.freeze([...items].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)));
}
