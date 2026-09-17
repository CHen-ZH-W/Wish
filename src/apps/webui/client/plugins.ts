import type { Context, Fiber } from "@deepseek-ai/cordis";
import type { ClientConnection } from "./connection.js";
import type { PluginManagementModel } from "./model/management.js";
import type { UiSlots } from "./slots.js";
import type { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import type { SessionClientModel } from "./model/session.js";
import type { FeaturesClientModel } from "./model/features.js";
import type { ComposerDrafts } from "./ui/drafts.js";
import type { NewSessionClientModel } from "./model/new-session.js";

declare module "@deepseek-ai/cordis" {
  interface Context { wishConnection: ClientConnection; wishManagement: PluginManagementModel; wishSettings: SettingsClientModel; wishUiSlots: UiSlots; wishSession: SessionClientModel; wishNewSession: NewSessionClientModel; wishDrafts: ComposerDrafts; wishFeatures: FeaturesClientModel }
}
export interface ClientUiPlugin { readonly name: string; readonly inject?: readonly string[]; apply(ctx: Context): void }

/** Tool availability is independent of specialized renderer presence or per-Step permission. */
export function bindToolAvailability(root: Context, toolNames: readonly string[], alternativeEntries: readonly string[]): () => void {
  const management = root.get("wishManagement")!, connection = root.get("wishConnection")!, slots = root.get("wishUiSlots")!;
  const update = () => {
    const data = management.getSnapshot().data, online = connection.getSnapshot();
    const entries = alternativeEntries.map(id => data?.inspection.entries.find(entry => entry.id === id));
    const state = !online.online || !data || data.inspection.instanceId !== online.instanceId ? "unknown" : entries.some(entry => entry?.enabled === true && entry.phase === "active") ? "available" : entries.some(entry => !!entry) ? "unavailable" : "unknown";
    for (const name of toolNames) slots.setToolAvailability(name, state);
  };
  const removeManagement = management.subscribe(update), removeConnection = connection.subscribe(update); update();
  return () => { removeManagement(); removeConnection(); };
}

/** Generic Host-availability binding. The composition supplies explicit entry identities. */
export function bindCapabilityUi(root: Context, plugin: ClientUiPlugin, entryIds: readonly string[]): () => Promise<void> {
  const management = root.get("wishManagement")!, connection = root.get("wishConnection")!;
  let fork: Fiber | undefined, generation: string | null = null, closed = false, version = 0;
  let tail = Promise.resolve();
  const update = () => {
    const expected = ++version;
    tail = tail.then(async () => {
      if (expected !== version) return;
      const data = management.getSnapshot().data;
      const enabled = !closed && connection.getSnapshot().online && !!data && entryIds.every(id => data.inspection.entries.some(entry => entry.id === id && entry.enabled === true && entry.phase === "active"));
      const instance = connection.getSnapshot().instanceId;
      if ((!enabled || generation !== instance) && fork) { const previous = fork; fork = undefined; await previous.dispose(); }
      if (enabled && !fork) { generation = instance; fork = root.plugin({ ...plugin, ...(plugin.inject ? { inject: [...plugin.inject] } : {}) }); await fork; }
    }).catch(() => { /* A failed optional UI contribution must not remove management. */ });
  };
  const removeManagement = management.subscribe(update), removeConnection = connection.subscribe(update);
  update();
  return async () => { closed = true; removeManagement(); removeConnection(); update(); await tail; };
}
