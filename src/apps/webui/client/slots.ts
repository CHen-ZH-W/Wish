import type { ComponentType } from "react";
import { SnapshotStore } from "./model/store.js";
import type { LedgerBlock } from "./projection/ledger.js";

export interface UiPanel {
  readonly id: string; readonly label: string; readonly labelEn?: string; readonly area: "workspace" | "settings";
  readonly View: ComponentType; readonly Icon?: ComponentType;
  /** Global rail entry instead of the area-local panel list. */
  readonly navigation?: "rail" | "hidden";
  /** Optional owner-provided sidebar replaces the area's default navigation. */
  readonly Sidebar?: ComponentType;
  /** Owner updates its presentation selection before the panel is shown. */
  readonly onOpen?: () => void;
  /** Optional owner-selected landing for this area; Shell does not inspect business state. */
  readonly defaultForArea?: () => boolean;
}
export interface UiNavigation { readonly id: string; readonly View: ComponentType; readonly forPanel?: string }
export interface UiComposerItem { readonly id: string; readonly View: ComponentType<{ sessionId: string; busy: boolean }> }
export interface UiNewSessionComposerItem { readonly id: string; readonly View: ComponentType<{ disabled: boolean }> }
export interface UiToolView { readonly toolName: string; readonly View: ComponentType<{ block: LedgerBlock }>; readonly category?: { readonly id: string; readonly label: string; readonly labelEn?: string } }
export interface UiToolAvailability { readonly toolName: string; readonly state: "available" | "unavailable" | "unknown" }
export interface UiSlotSnapshot { readonly panels: readonly UiPanel[]; readonly navigation: readonly UiNavigation[]; readonly interactions: readonly UiNavigation[]; readonly composerItems: readonly UiComposerItem[]; readonly newSessionComposerItems: readonly UiNewSessionComposerItem[]; readonly toolViews: readonly UiToolView[]; readonly toolAvailability: readonly UiToolAvailability[]; readonly notices: readonly UiNavigation[] }

/** Presentation registrations only. Removing an owner removes its seats, not business history. */
export class UiSlots extends SnapshotStore<UiSlotSnapshot> {
  constructor() { super(Object.freeze({ panels: Object.freeze([]), navigation: Object.freeze([]), interactions: Object.freeze([]), composerItems: Object.freeze([]), newSessionComposerItems: Object.freeze([]), toolViews: Object.freeze([]), toolAvailability: Object.freeze([]), notices: Object.freeze([]) })); }
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
        interactions: order(before.interactions, next.interactions, item => item.id), composerItems: order(before.composerItems, next.composerItems, item => item.id), newSessionComposerItems: order(before.newSessionComposerItems, next.newSessionComposerItems, item => item.id), notices: order(before.notices, next.notices, item => item.id),
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
