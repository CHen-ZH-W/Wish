import { Context } from "@deepseek-ai/cordis";
import { createRoot } from "react-dom/client";
import { ClientConnection } from "./connection.js";
import { PluginManagementModel } from "./model/management.js";
import { SettingsClientModel } from "../../../settings/consumers/webui/model.js";
import { SettingsPage } from "../../../settings/consumers/webui/view.js";
import { UiSlots } from "./slots.js";
import { bindToolAvailability } from "./plugins.js";
import { Shell } from "./ui/shell.js";
import { PluginPage } from "./ui/plugins.js";
import { SessionClientModel } from "./model/session.js";
import { Conversation, RoundNavigation } from "./ui/conversation.js";
import { SessionNavigation } from "./ui/sessions.js";
import { Icon } from "./ui/primitives.js";
import { FeaturesClientModel } from "./model/features.js";
import { TrajectoryClientUi } from "./ui/trajectory.js";
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
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "conversation", label: "执行记录", labelEn: "Activity", area: "workspace", onOpen: () => model.browse("active"), View: ConversationView }));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "archives", label: "归档", labelEn: "Archive", area: "workspace", navigation: "rail", Icon: () => <Icon name="archive" />, onOpen: () => model.browse("archived"), Sidebar: () => <SessionNavigation model={model} slots={slots} drafts={drafts} status="archived" panelId="archives" />, View: ConversationView }));
    ctx.effect(() => ctx.wishUiSlots.navigation({ id: "sessions", View: () => <SessionNavigation model={model} slots={slots} drafts={drafts} /> }));
    ctx.effect(() => ctx.wishUiSlots.navigation({ id: "rounds", forPanel: "conversation", View: () => <RoundNavigation model={model} /> }));
  } });
  await root.plugin({ name: "ui-workspace", inject: ["wishConnection", "wishSession", "wishDrafts", "wishUiSlots"], apply(ctx: Context) {
    const sessions = ctx.wishSession, slots = ctx.wishUiSlots, browser = new DirectoryBrowserModel(ctx.wishConnection);
    const flow = new NewSessionClientModel(sessions, ctx.wishDrafts);
    ctx.provide("wishNewSession", flow);
    ctx.effect(() => () => { browser.close(); flow.close(); });
    ctx.effect(() => slots.panel({ id: "new-session", label: "新建会话", labelEn: "New session", area: "workspace", navigation: "hidden", defaultForArea: () => {
      const state = sessions.getSnapshot();
      return !state.loading && !state.sessions.some(session => session.status === "active");
    }, onOpen: flow.start, View: () => <NewSession sessions={sessions} flow={flow} slots={slots} browser={browser} /> }));
    let startupResolved = false;
    const openOnEmpty = () => {
      const state = sessions.getSnapshot();
      if (startupResolved || state.loading || !state.available || state.error) return;
      startupResolved = true;
      if (!state.sessions.some(session => session.status === "active")) slots.openPanelIfIdle("new-session");
    };
    ctx.effect(() => { const unsubscribe = sessions.subscribe(openOnEmpty); openOnEmpty(); return unsubscribe; });
  } });
  await root.plugin({ name: "client-features", inject: ["wishConnection", "wishSession"], apply(ctx: Context) {
    const model = new FeaturesClientModel(ctx.wishConnection, ctx.wishSession); ctx.provide("wishFeatures", model); ctx.effect(() => () => model.close());
  } });
  await root.plugin({ name: "ui-management", inject: ["wishManagement", "wishSettings", "wishConnection", "wishUiSlots"], apply(ctx: Context) {
    const plugins = ctx.wishManagement, settings = ctx.wishSettings, status = ctx.wishConnection;
    const PluginsView = () => <PluginPage model={plugins} connection={status} />;
    const SettingsView = () => <SettingsPage model={settings} connection={status} namespaces={["webui-appearance", "webui-composer"]} />;
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "preferences", label: "通用设置", labelEn: "General", area: "settings", Icon: () => <Icon name="gear" />, View: SettingsView }));
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "plugins", label: "插件管理", labelEn: "Plugins", area: "settings", Icon: () => <Icon name="plug" />, View: PluginsView }));
  } });
  const modules = new UiModuleLoader(root, new URL(import.meta.url).pathname);
  root.effect(() => slots.notice({ id: "module-updates", View: () => <ModuleUpdateNotice model={modules} /> }));
  root.effect(() => () => modules.close(), "UI module lifetimes");
  modules.start();
  // Tool exposure is independent of UI code availability.
  for (const name of ["read", "write", "edit", "grep", "bash"]) root.effect(() => bindToolAvailability(root, [name], [`include:tool-${name}`]));
  root.effect(() => bindToolAvailability(root, ["list_skills", "read_skill"], ["include:skills-tools"]));
  root.effect(() => bindToolAvailability(root, ["spawn_agent", "list_agents", "capture_agent", "send_agent", "stop_agent", "collect_agent"], ["include:tool-subagents"]));
  await root.plugin(TrajectoryClientUi);
  const renderer = createRoot(element); renderer.render(<LanguageProvider model={root.get("wishSettings")!}><Shell slots={slots} connection={connection} /></LanguageProvider>);
  try {
    await connection.start();
    await Promise.all([root.get("wishManagement")!.refresh(), root.get("wishSettings")!.refresh()]);
  } catch { /* The shell retains its visible connection/recovery state. */ }
  return async () => { renderer.unmount(); await root.fiber.dispose(); };
}
const element = document.getElementById("wish-root");
if (element) void mountWishBrowser(element).then(close => window.addEventListener("pagehide", () => { void close(); }, { once: true }));
