import { Context } from "@deepseek-ai/cordis";
import { createRoot } from "react-dom/client";
import { ClientConnection } from "./connection.js";
import { PluginManagementModel } from "./model/management.js";
import { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import { SettingsPage } from "../../../settings/consumers/webui/view.js";
import { UiSlots } from "./slots.js";
import { bindPageReadiness, bindToolAvailability } from "./plugins.js";
import { Shell } from "./ui/shell.js";
import { PluginPage } from "./ui/plugins.js";
import { SessionClientModel } from "./model/session.js";
import { Conversation, RoundNavigation } from "./ui/conversation.js";
import { ToolCalls } from "./ui/tool-calls.js";
import { SessionNavigation } from "./ui/sessions.js";
import { Icon } from "./ui/primitives.js";
import { FeaturesClientModel } from "./model/features.js";
import { ComposerDrafts } from "./ui/drafts.js";
import { UiModuleLoader } from "./module-loader.js";
import { ModuleUpdateNotice } from "./ui/module-updates.js";
import { bindTheme } from "./theme.js";
import { LanguageProvider } from "./i18n.js";
import { NewSession } from "./ui/new-session.js";
import { DirectoryBrowserModel } from "../../../workspace/consumers/webui/directory-model.js";
import { NewSessionClientModel } from "./model/new-session.js";

/** Browser has its own Cordis tree; stable composition loads optional UI through a build manifest. */
export async function mountWishBrowser(element: HTMLElement): Promise<() => Promise<void>> {
  const root = new Context();
  const connection = new ClientConnection(), slots = new UiSlots();
  root.provide("wishConnection", connection); root.provide("wishUiSlots", slots);
  root.effect(() => () => connection.close(), "browser connection");
  await root.plugin({ name: "client-management-models", inject: ["wishConnection"], apply(ctx: Context) {
    const plugins = new PluginManagementModel(ctx.wishConnection), settings = new SettingsClientModel(ctx.wishConnection);
    ctx.provide("wishManagement", plugins); ctx.provide("wishSettings", settings);
    ctx.effect(() => bindTheme(settings), "browser theme");
    ctx.effect(() => () => { plugins.close(); settings.close(); }, "management client models");
  } });
  await root.plugin({ name: "client-session", inject: ["wishConnection"], apply(ctx: Context) {
    const model = new SessionClientModel(ctx.wishConnection); ctx.provide("wishSession", model); ctx.effect(() => () => model.close());
  } });
  await root.plugin({ name: "ui-conversation", inject: ["wishSession", "wishSettings", "wishUiSlots"], apply(ctx: Context) {
    const model = ctx.wishSession, settings = ctx.wishSettings, slots = ctx.wishUiSlots, drafts = new ComposerDrafts();
    ctx.provide("wishDrafts", drafts);
    ctx.effect(() => () => drafts.close());
    const ConversationView = () => <Conversation model={model} settings={settings} slots={slots} drafts={drafts} />;
    const ArchiveConversationView = () => <Conversation model={model} settings={settings} slots={slots} drafts={drafts} />;
    const ToolCallsView = () => <ToolCalls model={model} slots={slots} />;
    const ArchiveToolCallsView = () => <ToolCalls model={model} slots={slots} />;
    const ArchiveNavigation = () => <SessionNavigation model={model} slots={slots} drafts={drafts} status="archived" panelId="archives" />;
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "conversation", label: "会话", labelEn: "Conversation", area: "workspace", navigationGroup: "session", preserveState: true, Icon: () => <Icon name="conversation" />, onOpen: () => model.browse("active"), View: ConversationView }));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "tool-calls", label: "工具调用", labelEn: "Tool calls", area: "workspace", navigation: "hidden", navigationGroup: "session", preserveState: true, View: ToolCallsView }));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "archive-tool-calls", label: "工具调用", labelEn: "Tool calls", area: "workspace", navigation: "hidden", navigationGroup: "session", preserveState: true, onOpen: () => model.browse("archived"), Sidebar: ArchiveNavigation, View: ArchiveToolCallsView }));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "archives", label: "归档", labelEn: "Archive", area: "workspace", navigation: "rail", preserveState: true, Icon: () => <Icon name="archive" />, onOpen: () => model.browse("archived"), Sidebar: ArchiveNavigation, View: ArchiveConversationView }));
    ctx.effect(() => ctx.wishUiSlots.navigation({ id: "sessions", View: () => <SessionNavigation model={model} slots={slots} drafts={drafts} /> }));
    ctx.effect(() => ctx.wishUiSlots.navigation({ id: "rounds", forPanel: "conversation", View: () => <RoundNavigation model={model} slots={slots} /> }));
  } });
  await root.plugin({ name: "ui-workspace", inject: ["wishConnection", "wishSession", "wishDrafts", "wishUiSlots"], apply(ctx: Context) {
    const sessions = ctx.wishSession, slots = ctx.wishUiSlots, browser = new DirectoryBrowserModel(ctx.wishConnection);
    const flow = new NewSessionClientModel(sessions, ctx.wishDrafts);
    // A Browser visit starts as a fresh intent. Existing Sessions remain in the
    // index and are opened only when the user selects one explicitly.
    flow.start();
    ctx.provide("wishNewSession", flow);
    ctx.effect(() => () => { browser.close(); flow.close(); });
    ctx.effect(() => slots.panel({ id: "new-session", label: "新建会话", labelEn: "New session", area: "workspace", navigation: "hidden", preserveState: true, defaultForArea: () => true,
      onOpen: flow.start, View: () => <NewSession sessions={sessions} flow={flow} slots={slots} browser={browser} /> }));
    slots.openPanelIfIdle("new-session");
  } });
  await root.plugin({ name: "client-features", inject: ["wishConnection", "wishSession"], apply(ctx: Context) {
    const model = new FeaturesClientModel(ctx.wishConnection, ctx.wishSession); ctx.provide("wishFeatures", model); ctx.effect(() => () => model.close());
  } });
  await root.plugin({ name: "ui-management", inject: ["wishManagement", "wishSettings", "wishConnection", "wishUiSlots"], apply(ctx: Context) {
    const plugins = ctx.wishManagement, settings = ctx.wishSettings, status = ctx.wishConnection;
    const PluginsView = () => <PluginPage model={plugins} connection={status} />;
    const SettingsView = () => <SettingsPage model={settings} connection={status} namespaces={["webui-appearance", "webui-composer", "permissions"]} />;
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "preferences", label: "通用设置", labelEn: "General", area: "settings", preserveState: true, Icon: () => <Icon name="gear" />, View: SettingsView }));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "plugins", label: "插件管理", labelEn: "Plugins", area: "settings", preserveState: true, Icon: () => <Icon name="plug" />, View: PluginsView }));
  } });
  const modules = new UiModuleLoader(root, new URL(import.meta.url).pathname);
  root.effect(() => bindPageReadiness(root, "session", ["conversation", "archives", "tool-calls", "archive-tool-calls"], root.get("wishSession")!.readiness, true, () => {
    const state = root.get("wishSession")!.getSnapshot();
    return state.history?.sessionId === state.selectedId;
  }));
  root.effect(() => bindPageReadiness(root, "session-list", ["new-session"], root.get("wishSession")!.readiness, false));
  root.effect(() => bindPageReadiness(root, "settings", ["preferences", "models", "new-session", "conversation", "archives"], root.get("wishSettings")!.readiness, false));
  root.effect(() => bindPageReadiness(root, "management", ["plugins"], root.get("wishManagement")!.readiness, false));
  root.effect(() => bindPageReadiness(root, "features", ["conversation", "archives"], root.get("wishFeatures")!.readiness));
  root.effect(() => slots.notice({ id: "module-updates", View: () => <ModuleUpdateNotice model={modules} /> }));
  root.effect(() => () => modules.close(), "UI module lifetimes");
  modules.start();
  // Tool exposure is independent of UI code availability.
  for (const name of ["read", "write", "edit", "grep", "bash"]) root.effect(() => bindToolAvailability(root, [name], [`include:tool-${name}`]));
  root.effect(() => bindToolAvailability(root, ["list_skills", "read_skill"], ["include:skills-tools"]));
  root.effect(() => bindToolAvailability(root, ["spawn_agent", "list_agents", "capture_agent", "send_agent", "stop_agent", "collect_agent"], ["include:tool-subagents"]));
  try {
    await connection.start();
    await Promise.all([root.get("wishManagement")!.refresh(), root.get("wishSettings")!.refresh(), root.get("wishSession")!.readiness.whenSettled()]);
    await modules.whenSettled();
  } catch { /* The shell retains its visible connection/recovery state. */ }
  const renderer = createRoot(element); renderer.render(<LanguageProvider model={root.get("wishSettings")!}><Shell slots={slots} connection={connection} /></LanguageProvider>);
  return async () => { renderer.unmount(); await root.fiber.dispose(); };
}
const element = document.getElementById("wish-root");
if (element) void mountWishBrowser(element).then(close => window.addEventListener("pagehide", () => { void close(); }, { once: true }));
