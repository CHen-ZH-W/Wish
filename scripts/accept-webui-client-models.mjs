import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RefreshQueue, SnapshotStore, freezeWire } from "../dist/apps/webui/client/model/store.js";
import { FeaturesClientModel } from "../dist/apps/webui/client/model/features.js";
import { ComposerDrafts } from "../dist/apps/webui/client/ui/drafts.js";
import { NewSessionClientModel } from "../dist/apps/webui/client/model/new-session.js";
import { PluginManagementModel } from "../dist/apps/webui/client/model/management.js";
import { ClientConnection } from "../dist/apps/webui/client/connection.js";
import { SettingsClientModel } from "../dist/settings/consumers/webui/model.js";
import { Context } from "@deepseek-ai/cordis";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { bindCapabilityUi, bindToolAvailability } from "../dist/apps/webui/client/plugins.js";
import { SkillsClientUi } from "../dist/skills/consumers/webui/index.js";
import { SkillsClientModel, parseSkillFeatureData } from "../dist/skills/consumers/webui/model.js";
import { ModelsClientUi } from "../dist/models/consumers/webui/index.js";
import { ModelsSettingsClientModel, parseCapacity } from "../dist/models/consumers/webui/model.js";
import { bindAppearance, bindTheme, selectedFontSize, selectedLanguage, selectedTheme } from "../dist/apps/webui/client/theme.js";
import { ComposerPreferences } from "../dist/apps/webui/host/preferences.js";
import { PluginPage } from "../dist/apps/webui/client/ui/plugins.js";
import { Icon } from "../dist/apps/webui/client/ui/primitives.js";
import { closeSessionDockPane, closeSessionDockTab, createSessionDockLayout, openSessionDockGuide, openSessionDockTab, reconcileSessionDockLayout, selectSessionDockTab, splitSessionDockPane, toggleSessionDockFullscreen, updateSessionDockTab } from "../dist/apps/webui/client/ui/session-dock.js";
import { defaultRightSidebarWidth, LEFT_SIDEBAR_MAX_WIDTH, LEFT_SIDEBAR_MIN_WIDTH, resizeSidebarWidth, rightSidebarMaxWidth, RIGHT_SIDEBAR_MIN_WIDTH, SidebarResizeHandle } from "../dist/apps/webui/client/ui/sidebar-resize.js";
import { TmuxClientUi, tmuxLiveSyncEnabled } from "../dist/tmux/consumers/webui/index.js";
import { TodoClientUi } from "../dist/todo/consumers/webui/index.js";
import { SubagentsClientUi } from "../dist/subagents/consumers/webui/index.js";
import { GoalClientUi } from "../dist/goal/consumers/webui/index.js";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
class MutableStore extends SnapshotStore {
  update(value) { this.publish({ ...this.getSnapshot(), ...value }); }
}
test("feature mirror reconciles Todo changes without a parent Run event", async () => {
  const sessions = new MutableStore({ available: true, selectedId: "session-one", working: false,
    sessions: [{ sessionId: "session-one", status: "active" }] });
  let revision = 1, reads = 0;
  const connection = { async request(path) {
    assert.equal(path, "/api/sessions/session-one/features");
    reads++;
    return { features: [{ key: "todo", data: { revision }, actions: [] }] };
  } };
  const model = new FeaturesClientModel(connection, sessions);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().views[0].data.revision, 1);
    revision = 2;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Todo feature did not refresh")); }, 3800);
      const unsubscribe = model.subscribe(() => {
        if (model.getSnapshot().views[0]?.data.revision !== 2) return;
        clearTimeout(timeout); unsubscribe(); resolve();
      });
    });
    assert.ok(reads >= 2);
  } finally { model.close(); }
});
test("active Todo card observes child completion promptly without a parent Tool event", async () => {
  const root = new Context(), slots = new UiSlots();
  const run = new MutableStore({ runId: "run-one", terminal: false, events: [] });
  const sessions = Object.assign(new MutableStore({ available: true, selectedId: "session-one", working: false,
    sessions: [{ sessionId: "session-one", status: "active" }], runs: [{ runId: "run-one", status: "running" }] }), { run });
  let status = "in_progress", reads = 0;
  const connection = { async request() {
    reads++;
    return { features: [{ key: "todo", token: {}, actions: [], data: { schemaVersion: 1, sessionId: "session-one",
      runId: "run-one", userTurnId: "turn-one", revision: status === "completed" ? 2 : 1,
      items: [{ id: "child", content: "Review child result", status }] } }] };
  } };
  const features = new FeaturesClientModel(connection, sessions);
  root.provide("wishUiSlots", slots); root.provide("wishSession", sessions); root.provide("wishFeatures", features);
  const plugin = await root.plugin(TodoClientUi);
  try {
    await features.refresh();
    status = "completed";
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { remove(); reject(new Error("Active Todo card did not follow child completion")); }, 2400);
      const remove = features.subscribe(() => {
        if (features.getSnapshot().views[0]?.data.items[0]?.status !== "completed") return;
        clearTimeout(timeout); remove(); resolve();
      });
    });
    assert.ok(reads >= 2);
  } finally { await plugin.dispose(); features.close(); await root.fiber.dispose(); }
});
test("a running child remains visible with its own stop action when spawn has no result card", async () => {
  const root = new Context(), slots = new UiSlots();
  const features = new MutableStore({ sessionId: "session-one", available: true, pending: false,
    views: [{ key: "subagents", actions: [{ name: "stop" }], data: {
      kind: "subagent-observation",
      records: [{ id: "child-one", role: "reviewer", status: "running", target: { target: "tmux-pane" } }],
    } }],
  });
  root.provide("wishUiSlots", slots); root.provide("wishFeatures", features);
  const plugin = await root.plugin(SubagentsClientUi);
  try {
    const card = slots.getSnapshot().conversationCards.find(item => item.id === "subagents");
    assert.ok(card);
    const markup = renderToStaticMarkup(createElement(card.View, { sessionId: "session-one" }));
    assert.match(markup, /reviewer/u);
    assert.match(markup, /停止/u);
  } finally { await plugin.dispose(); await root.fiber.dispose(); }
});
test("WebUI appearance settings expose live language and font-size choices without replacing theme", () => {
  const definitions = [];
  ComposerPreferences.apply({ settings: { register(_ctx, definition) { definitions.push(definition); } } });
  const appearance = definitions.find(definition => definition.namespace === "webui-appearance");
  assert.equal(appearance.applies, "live");
  assert.deepEqual(appearance.fields.map(field => field.key), ["theme", "language", "font-size"]);
  assert.deepEqual(appearance.fields.find(field => field.key === "language").options.map(option => option.value), ["zh-CN", "en-US"]);
  assert.deepEqual(appearance.fields.find(field => field.key === "font-size").options.map(option => option.value), ["standard", "large", "extra-large"]);
});
test("shipped WebUI stylesheet scales fixed text sizes for both larger choices", async () => {
  const css = await readFile(new URL("../dist/apps/webui/public/app.css", import.meta.url), "utf8");
  assert.match(css, /:root\[data-font-size=large\]\{--wish-font-scale:1\.142857\}/);
  assert.match(css, /:root\[data-font-size=extra-large\]\{--wish-font-scale:1\.285714\}/);
  assert.match(css, /font-size:calc\(14px \* var\(--wish-font-scale\)\)/);
  assert.doesNotMatch(css, /font-size:\d+px/);
  assert.match(css, /\.configuration-readonly[^}]*color:var\(--muted\)/);
  assert.match(css, /\.configuration-incomplete[^}]*color:var\(--warning\)/);
  assert.match(css, /\.conversation\{--session-sidebar-width:clamp\(420px,42vw,640px\);display:grid;grid-template-columns:minmax\(0,1fr\) var\(--session-sidebar-width\)/u);
  assert.match(css, /\.conversation\.session-sidebar-fullscreen \.session-sidebar\{position:fixed;z-index:30;inset:0;width:100vw;height:100dvh/u);
  assert.match(css, /\.session-sidebar-guide\{display:flex;box-sizing:border-box/u);
  assert.match(css, /\.session-dock-tabs \.session-dock-guide-tab\{min-width:80px/u);
  assert.match(css, /\.session-sidebar-guide-entry\{display:flex;align-items:center;gap:14px/u);
  assert.match(css, /\.sidebar-resize-handle\{position:absolute;z-index:9;top:0;bottom:0;width:9px;cursor:col-resize/u);
  assert.match(css, /\.conversation\.session-sidebar-fullscreen \.right-sidebar-resize-handle\{display:none\}/u);
  assert.match(css, /\.conversation-card-stack:empty\{display:none\}/u, "an empty module contribution reserves no visible card space");
  assert.match(css, /\.ledger-load-earlier\{display:flex;justify-content:center/u, "older turns use a compact explicit paging control");
  assert.match(css, /\.conversation-turn\{[^}]*content-visibility:auto/u, "completed turns preserve a light render boundary");
  assert.match(css, /\.live-run\{[^}]*border-top:1px solid var\(--line\)/u, "the active turn has one dedicated live surface");
  assert.match(css, /\.final-answer\{padding:8px 0 6px\}/u, "the canonical answer has its own primary reading surface");
  assert.match(css, /\.conversation-top-context\{[^}]*border-bottom:1px solid var\(--line\)/u, "session context has a stable place above the conversation");
  assert.match(css, /\.tool-calls-page\{[^}]*display:flex[^}]*height:100%/u, "Tool details remain a separate conversation subview");
  assert.match(css, /\.tool-call-turn\{[^}]*content-visibility:auto/u, "long Tool histories retain an offscreen rendering boundary");
  assert.doesNotMatch(css, /\.ledger-filters/u, "the primary conversation no longer exposes event-category filters");
  assert.doesNotMatch(css, /\.ledger-row/u, "the primary conversation no longer renders a generic event timeline");
  assert.match(css, /\.conversation-ledger-layout:has\(>\.conversation-card-stack:not\(:empty\)\)\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(260px,320px\)/u, "visible cards create a bounded desktop task column");
  assert.match(css, /@media\(max-width:860px\)\{\.conversation-ledger-layout:has\(>\.conversation-card-stack:not\(:empty\)\)\{display:flex;flex-direction:column/u, "narrow conversations put cards above the activity feed");
  assert.match(css, /@media\(max-width:1180px\)[^{]*\{\.conversation\{grid-template-columns:minmax\(0,1fr\)\}/u);
  assert.match(css, /\.tmux-sidebar-view\{container-type:inline-size;display:flex;flex:1;min-width:0;min-height:0;width:100%;height:100%/u);
  assert.match(css, /\.tmux-sidebar-toolbar\{[^}]*align-self:stretch[^}]*width:100%[^}]*height:38px;min-height:38px[^}]*border-bottom:1px solid var\(--line\)/u);
  assert.match(css, /\.tmux-sidebar-toolbar button\{position:absolute;top:5px;right:6px/u, "the refresh action stays anchored to the stationary sidebar edge while resizing");
  assert.doesNotMatch(css, /tmux-observed-at/u, "tmux exposes one concise status row instead of a second scrolling notice");
  assert.match(css, /\.tmux-sidebar-view \.terminal-list\{[^}]*flex:1[^}]*min-height:0[^}]*overflow:auto/u);
  assert.match(css, /@container \(max-width:420px\)\{[^@]*\.tmux-process-heading\{align-items:flex-start;flex-direction:column/u);
  assert.doesNotMatch(css, /\.tmux-sidebar-toolbar\{display:flex;align-items:flex-start/u, "obsolete page-style tmux toolbar rules are removed");
});
test("main conversation keeps detailed Tool evidence in a Tool-only session subview", async () => {
  const main = await readFile(new URL("../src/apps/webui/client/main.tsx", import.meta.url), "utf8");
  const conversation = await readFile(new URL("../src/apps/webui/client/ui/conversation.tsx", import.meta.url), "utf8");
  const toolCalls = await readFile(new URL("../src/apps/webui/client/ui/tool-calls.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("../src/apps/webui/client/ui/shell.tsx", import.meta.url), "utf8");
  assert.match(conversation, /source\.getSnapshot\(\)\.at\(-1\)/u, "the main conversation places the latest contributed context at its top");
  assert.match(conversation, /conversation-request" key=\{block\.id\}><div className="message-text">\{block\.text\}/u, "the main conversation keeps the user's request text without a redundant speaker label");
  assert.doesNotMatch(conversation, /"You" : "你"/u, "the main conversation does not label user messages as You");
  assert.doesNotMatch(conversation, /查看调用与输出|View call and output|GenericToolDetails/u, "Tool inputs and results are not mounted in the main conversation");
  assert.match(toolCalls, /block\.kind === "tool"/u, "the subview projects only Tool blocks");
  assert.match(toolCalls, /查看调用与输出/u, "the subview keeps detailed call and output disclosure");
  assert.match(toolCalls, /GenericToolDetails/u, "the subview retains a generic renderer when a Tool module is unavailable");
  assert.match(conversation, /conversation-view-tabs[^]*主会话[^]*工具调用/u, "the conversation header keeps main and Tool views side by side");
  assert.match(conversation, /ConversationViewTabs slots=\{slots\} current="conversation" archived=\{archived\}/u, "the main conversation marks its navigation item current");
  assert.match(toolCalls, /ConversationViewTabs slots=\{slots\} current="tool-calls" archived=\{archived\}/u, "the Tool subview keeps the same navigation and marks Tool calls current");
  assert.match(conversation, /archived \? "archives" : "conversation"/u, "the paired navigation preserves active versus archived conversation scope");
  assert.doesNotMatch(toolCalls, /所有记录|All records|推理输出|Reasoning|MarkdownContent/u, "the aggregate execution timeline is not restored");
  assert.match(shell, /panel\?\.navigationGroup === undefined \? item\.navigationGroup === undefined : item\.navigationGroup === panel\.navigationGroup/u, "session views do not leak into new-session or unrelated panel navigation");
  assert.match(shell, /localPanels\.length > 1/u, "a single main conversation panel does not create a redundant sidebar entry");
  assert.match(conversation, /onClick=\{\(\) => slots\.openPanel\("tool-calls"\)\}/u, "the paired header navigation opens Tool calls from the main conversation");
  assert.doesNotMatch(conversation, /localStorage|session-dock\.v2/u, "session Dock presentation starts clean after the page is reopened");
  assert.match(main, /const flow = new NewSessionClientModel[^]*flow\.start\(\)[^]*openPanelIfIdle\("new-session"\)/u, "every Browser visit starts from a fresh new-session intent");
  assert.match(conversation, /\[sidebarOpen, setSidebarOpen\] = useState\(false\)/u, "the right sidebar starts collapsed at every viewport width");
  assert.doesNotMatch(conversation, /setSidebarOpen\(wide\)/u, "responsive changes never open the right sidebar without user intent");
});
test("native select menus retain explicit light and dark theme surfaces", async () => {
  const css = await readFile(new URL("../dist/apps/webui/public/app.css", import.meta.url), "utf8");
  assert.match(css, /--control-surface:#fff;--control-text:#202c3e/u);
  assert.match(css, /select option,select optgroup\{color:var\(--control-text\);background-color:var\(--control-surface\)\}/u);
  assert.match(css, /select option:hover,select option:focus,select option:checked\{color:var\(--control-text\);background-color:var\(--active\)\}/u);
  assert.match(css, /--control-surface:#0d0d0f;--control-text:#e7e7eb/u);
  assert.match(css, /:root\[data-theme=dark\] select\{color-scheme:dark\}/u);
});
test("plugin page renders Host-classified Kernel as a gray read-only control", () => {
  const entry = { id: "include:timer", name: "cordis:timer", parentId: "include", kind: "plugin", managementClass: "kernel",
    gate: "default", enabled: true, fiberId: 2, phase: "active" };
  const snapshot = { data: { owners: [], requests: [], codeReload: null,
    protocols: [], inspection: { instanceId: "instance", entries: [entry], fibers: [] }, revision: "revision", preferences: {}, controls: {},
    pending: null, status: "ready", writable: true, operation: null, lastReceipt: null,
    configuration: { watching: true, phase: "idle", digest: "digest", code: null } }, loading: false, error: null, pending: false };
  const model = { getSnapshot: () => snapshot, subscribe: () => () => {}, preview: async () => {}, change: async () => {}, cancel: async () => {}, recover: async () => {} };
  const connection = { getSnapshot: () => ({ online: true }), subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(PluginPage, { model, connection }));
  assert.match(html, /class="configuration-toggle configuration-readonly" disabled="" aria-label="内核只读 include:timer"/u);
  assert.match(html, />Kernel · 只读<\/button>/u);
  assert.doesNotMatch(html, /aria-pressed=/u);
});
test("plugin page exposes a managed protocol failure as an amber disabled warning", () => {
  const entry = { id: "include:unsafe", name: "./unsafe.mjs", parentId: "include", kind: "plugin", managementClass: "managed",
    gate: "default", enabled: true, fiberId: 3, phase: "active" };
  const snapshot = { data: { owners: [{ fiberId: 3, lifecycle: "unregistered", codeReload: "unregistered" }], requests: [], codeReload: null,
    protocols: [{ entryId: entry.id, conformance: "incomplete", stop: "missing", codeUpdate: "missing" }],
    inspection: { instanceId: "instance", entries: [entry], fibers: [] }, revision: "revision", preferences: {}, controls: {},
    pending: null, status: "ready", writable: true, operation: null, lastReceipt: null,
    configuration: { watching: true, phase: "idle", digest: "digest", code: null } }, loading: false, error: null, pending: false };
  const model = { getSnapshot: () => snapshot, subscribe: () => () => {}, preview: async () => {}, change: async () => {}, cancel: async () => {}, recover: async () => {} };
  const connection = { getSnapshot: () => ({ online: true }), subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(PluginPage, { model, connection }));
  assert.match(html, /class="configuration-toggle configuration-incomplete" disabled="" aria-label="插件协议不完整 include:unsafe" aria-pressed="true"/u);
  assert.match(html, />协议不完整<\/button>/u);
  assert.match(html, />缺少安全停用协议<\/small>/u);
});
test("plugin page keeps an enabled managed plugin actionable while it waits for dependencies", () => {
  const entry = { id: "include:consumer", name: "cordis:consumer", parentId: "include", kind: "plugin", managementClass: "managed",
    gate: "default", enabled: true, fiberId: 5, phase: "pending" };
  const snapshot = { data: { owners: [], requests: [], codeReload: null,
    protocols: [{ entryId: entry.id, conformance: "inactive", stop: "inactive", codeUpdate: "inactive" }],
    inspection: { instanceId: "instance", entries: [entry], fibers: [] }, revision: "revision", preferences: {},
    controls: { [entry.id]: { managementClass: "managed", canEnable: false, canDisable: true, canReplace: false } },
    pending: null, status: "ready", writable: true, operation: null, lastReceipt: null,
    configuration: { watching: true, phase: "idle", digest: "digest", code: null } }, loading: false, error: null, pending: false };
  const model = { getSnapshot: () => snapshot, subscribe: () => () => {}, preview: async () => {}, change: async () => {}, cancel: async () => {}, recover: async () => {} };
  const connection = { getSnapshot: () => ({ online: true }), subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(PluginPage, { model, connection }));
  assert.match(html, /class="configuration-toggle configuration-enabled" aria-label="停用 include:consumer" aria-pressed="true"/u);
  assert.match(html, />等待依赖<\/span>/u);
});
test("plugin page exposes an undeclared entry as noncompliant instead of Kernel", () => {
  const entry = { id: "include:external", name: "./external.mjs", parentId: "include", kind: "plugin", managementClass: "noncompliant",
    gate: "default", enabled: true, fiberId: 4, phase: "active" };
  const snapshot = { data: { owners: [], requests: [], codeReload: null, protocols: [],
    inspection: { instanceId: "instance", entries: [entry], fibers: [] }, revision: "revision", preferences: {}, controls: {},
    pending: null, status: "ready", writable: true, operation: null, lastReceipt: null,
    configuration: { watching: true, phase: "idle", digest: "digest", code: null } }, loading: false, error: null, pending: false };
  const model = { getSnapshot: () => snapshot, subscribe: () => () => {}, preview: async () => {}, change: async () => {}, cancel: async () => {}, recover: async () => {} };
  const connection = { getSnapshot: () => ({ online: true }), subscribe: () => () => {} };
  const html = renderToStaticMarkup(createElement(PluginPage, { model, connection }));
  assert.match(html, /class="configuration-toggle configuration-incomplete" disabled="" aria-label="未声明托管分类 include:external"/u);
  assert.match(html, />未声明 · 不合规<\/button>/u);
  assert.doesNotMatch(html, /Kernel · 只读/u);
});
test("a UI owner can choose the initial panel without overriding later navigation", () => {
  const slots = new UiSlots(), View = () => null;
  const dispose = slots.panel({ id: "new-session", label: "新建会话", area: "workspace", navigation: "hidden", defaultForArea: () => true, View });
  const seen = [];
  slots.openPanelIfIdle("new-session");
  const unsubscribe = slots.onOpenPanel(id => seen.push(id));
  assert.deepEqual(seen, ["new-session"], "a late-mounted Shell receives the initial navigation");
  assert.equal(slots.getSnapshot().panels[0].defaultForArea(), true);
  slots.openPanel("preferences");
  slots.openPanelIfIdle("new-session");
  assert.deepEqual(seen, ["new-session", "preferences"], "an owner cannot take over after explicit navigation");
  unsubscribe(); dispose();
});
test("session sidebar seats are ordered, replaceable UI contributions", async () => {
  const slots = new UiSlots(), View = () => null;
  const future = slots.sessionSidebar({ id: "future", label: "未来功能", View });
  const tmux = slots.sessionSidebar({ id: "tmux", order: 30, label: "tmux", View });
  const files = slots.sessionSidebar({ id: "files", order: 20, label: "文件", labelEn: "Files", View });
  const terminal = slots.sessionSidebar({ id: "terminal", order: 10, label: "终端", labelEn: "Terminal", View });
  assert.deepEqual(slots.getSnapshot().sessionSidebarItems.map(item => item.id), ["terminal", "files", "tmux", "future"], "terminal and Files lead the guide regardless of module load order; unranked future features follow tmux");
  assert.throws(() => slots.sessionSidebar({ id: "terminal", label: "重复", View }), /Duplicate Session sidebar item/u);
  await slots.batch(async () => { terminal(); slots.sessionSidebar({ id: "terminal", order: 10, label: "新终端", labelEn: "New terminal", View }); });
  assert.deepEqual(slots.getSnapshot().sessionSidebarItems.map(item => item.id), ["terminal", "files", "tmux", "future"], "a replacement keeps the explicit feature order");
  files(); tmux(); future();
  assert.deepEqual(slots.getSnapshot().sessionSidebarItems.map(item => item.id), ["terminal"]);
});
test("conversation cards are ordered, replaceable UI contributions", async () => {
  const slots = new UiSlots(), View = () => null;
  const todo = slots.conversationCard({ id: "todo", order: 20, View });
  const goal = slots.conversationCard({ id: "goal", order: 10, View });
  assert.deepEqual(slots.getSnapshot().conversationCards.map(item => item.id), ["goal", "todo"]);
  assert.throws(() => slots.conversationCard({ id: "todo", View }), /Duplicate conversation card/u);
  await slots.batch(async () => { todo(); slots.conversationCard({ id: "todo", order: 20, View }); });
  assert.deepEqual(slots.getSnapshot().conversationCards.map(item => item.id), ["goal", "todo"]);
  goal();
});
test("Todo owns a conditional conversation card instead of a workspace panel", async () => {
  const root = new Context(), slots = new UiSlots();
  const run = new MutableStore({ runId: null, events: [] });
  const sessions = Object.assign(new MutableStore({ selectedId: "session-one", runs: [] }), { run });
  let refreshes = 0;
  const features = Object.assign(new MutableStore({ sessionId: "session-one", available: true, pending: false, views: [{ key: "todo", title: "当前轮 Todo · 1/3", text: "", token: {}, actions: [], data: { schemaVersion: 1, sessionId: "session-one", runId: "run-one", userTurnId: "turn-one", revision: 1, openedAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:01.000Z", items: [{ id: "done", content: "完成项", status: "completed" }, { id: "doing", content: "进行项", status: "in_progress" }, { id: "later", content: "待办项", status: "pending" }] } }] }), { refresh: async () => { refreshes++; } });
  root.provide("wishUiSlots", slots);
  root.provide("wishSession", sessions);
  root.provide("wishFeatures", features);
  const plugin = await root.plugin(TodoClientUi);
  try {
    assert.equal(slots.getSnapshot().panels.some(panel => panel.id === "todo"), false);
    assert.deepEqual(slots.getSnapshot().conversationCards.map(item => ({ id: item.id, order: item.order })), [{ id: "todo", order: 20 }]);
    const View = slots.getSnapshot().conversationCards[0].View;
    const todoView = features.getSnapshot().views[0];
    const markup = renderToStaticMarkup(createElement(View, { sessionId: "session-one" }));
    assert.match(markup, /class="conversation-card todo-card"/u);
    assert.match(markup, />任务单</u);
    assert.match(markup, /data-status="completed"/u);
    assert.match(markup, /data-status="in_progress"/u);
    assert.match(markup, /data-status="pending"/u);
    assert.match(markup, /已完成：/u);
    assert.match(markup, /进行中：/u);
    assert.match(markup, /待处理：/u);
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "another-session" })), "", "a card from another session reserves no UI");
    features.update({ views: [] });
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "session-one" })), "", "an empty Todo reserves no UI");
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "runtime.transition", payload: { type: "user_turn.started" } }] });
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "runtime.transition", payload: { type: "user_turn.started" } }, { sequence: 2, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "todo_write" } } }] });
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "runtime.transition", payload: { type: "user_turn.started" } }, { sequence: 2, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "todo_write" } } }, { sequence: 3, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "read" } } }] });
    assert.equal(refreshes, 2, "Todo refreshes on a new UserTurn and a completed todo_write, not unrelated tools");
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "runtime.transition", payload: { type: "user_turn.started" } }, { sequence: 2, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "todo_write" } } }, { sequence: 3, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "read" } } }, { sequence: 4, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "spawn_agent" } } }] });
    assert.equal(refreshes, 3, "Todo refreshes when a linked child starts");
    features.update({ views: [todoView] });
    run.update({ runId: "run-one", terminal: true, events: [{ sequence: 5, type: "runtime.transition", payload: { type: "run.aborted" } }] });
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "session-one" })), "", "a terminal Run hides its own stale Todo before feature cleanup finishes");
    assert.equal(refreshes, 4, "a terminal Run requests the authoritative Todo state");
    run.update({ runId: "run-two", terminal: false, events: [] });
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "session-one" })), "", "a new Run cannot display the previous Run's Todo");
    features.update({ views: [{ ...todoView, data: { ...todoView.data, runId: "run-two" } }] });
    assert.match(renderToStaticMarkup(createElement(View, { sessionId: "session-one" })), /class="conversation-card todo-card"/u);
    sessions.update({ runs: [{ runId: "run-two", status: "aborted" }] });
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "session-one" })), "", "terminal Host status hides stale Todo when the event stream was unavailable");
  } finally { await plugin.dispose(); await root.fiber.dispose(); }
  assert.deepEqual(slots.getSnapshot().conversationCards, []);
});
test("Goal owns a conditional actionable conversation card instead of a workspace panel", async () => {
  const root = new Context(), slots = new UiSlots(), run = new MutableStore({ runId: null, events: [] });
  let refreshes = 0;
  const goal = { schemaVersion: 1, id: "goal-one", sessionId: "session-one", revision: 4, version: 4, objective: "完成 Goal 会话卡片", phase: "blocked", activation: "disarmed", roundsStarted: 2, maxGoalRounds: 6, blockedReason: { code: "dependency", message: "等待外部依赖" }, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:01.000Z" };
  const view = { key: "goal", title: "目标 · blocked", text: "", token: { goalId: "goal-one", revision: 4 }, actions: [{ name: "resume", label: "恢复", labelEn: "Resume" }, { name: "complete", label: "标记完成", labelEn: "Mark complete" }, { name: "clear", label: "清除", labelEn: "Clear" }], data: goal };
  const features = Object.assign(new MutableStore({ sessionId: "session-one", available: true, pending: false, error: null, views: [view] }), { refresh: async () => { refreshes++; }, act: async () => {} });
  root.provide("wishUiSlots", slots); root.provide("wishSession", { run }); root.provide("wishFeatures", features);
  const plugin = await root.plugin(GoalClientUi);
  try {
    assert.equal(slots.getSnapshot().panels.some(panel => panel.id === "goal"), false);
    assert.deepEqual(slots.getSnapshot().conversationCards.map(item => ({ id: item.id, order: item.order })), [{ id: "goal", order: 10 }]);
    const View = slots.getSnapshot().conversationCards[0].View;
    const markup = renderToStaticMarkup(createElement(View, { sessionId: "session-one" }));
    assert.match(markup, /class="conversation-card goal-card"/u);
    assert.match(markup, /完成 Goal 会话卡片/u);
    assert.match(markup, /data-phase="blocked">已阻塞/u);
    assert.match(markup, /等待外部依赖/u);
    assert.match(markup, />恢复</u); assert.match(markup, />标记完成</u); assert.match(markup, />清除</u);
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "another-session" })), "", "a Goal from another session reserves no UI");
    features.update({ views: [] });
    assert.equal(renderToStaticMarkup(createElement(View, { sessionId: "session-one" })), "", "a missing Goal reserves no UI");
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "create_goal" } } }] });
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "create_goal" } } }, { sequence: 2, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "update_goal" } } }] });
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "create_goal" } } }, { sequence: 2, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "update_goal" } } }, { sequence: 3, type: "runtime.transition", payload: { type: "user_turn.completed" } }] });
    run.update({ runId: "run-one", events: [{ sequence: 1, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "create_goal" } } }, { sequence: 2, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "update_goal" } } }, { sequence: 3, type: "runtime.transition", payload: { type: "user_turn.completed" } }, { sequence: 4, type: "tool.lifecycle", payload: { type: "tool.completed", call: { name: "read" } } }] });
    assert.equal(refreshes, 3, "Goal refreshes on its tools and round boundaries, not unrelated tools");
  } finally { await plugin.dispose(); await root.fiber.dispose(); }
  assert.deepEqual(slots.getSnapshot().conversationCards, []);
});
test("tmux owns a session-sidebar feature instead of a workspace page", async () => {
  const root = new Context(), slots = new UiSlots();
  root.provide("wishUiSlots", slots);
  const target = (sessionId, active) => ({ target: { sessionId, session: `wish-${sessionId}`, window: "main", pane: "%0", target: `wish-${sessionId}:main.0`, attachCommand: `tmux attach-session -t wish-${sessionId}`, captureCommand: `tmux capture-pane -p -t wish-${sessionId}:main.0` }, metadata: { workspaceRoot: "/workspace", label: sessionId }, createdAt: "2026-10-11T00:00:00.000Z", active, ...(active ? { currentCommand: "node", panePid: 42 } : { exitCode: 0 }) });
  const feature = { key: "tmux", title: "tmux", text: "", token: {}, actions: [{ name: "capture", label: "同步", feedback: true }, { name: "delete", label: "删除", feedback: true }], data: { kind: "tmux-observation", observedAt: "2026-10-11T00:00:00.000Z", sessions: [target("live", true), target("finished", false)], captures: [{ sessionId: "live", observedAt: "2026-10-11T00:00:00.000Z", output: "running", active: true }, { sessionId: "finished", observedAt: "2026-10-11T00:00:00.000Z", output: "done", active: false }] } };
  root.provide("wishFeatures", new SnapshotStore({ sessionId: "session-one", views: [feature], error: null, available: true, pending: false }));
  const tmux = await root.plugin(TmuxClientUi);
  try {
    assert.equal(slots.getSnapshot().panels.some(panel => panel.id === "tmux"), false);
    assert.deepEqual(slots.getSnapshot().sessionSidebarItems.map(item => ({ id: item.id, order: item.order, label: item.label, icon: item.icon, description: item.description })), [{ id: "tmux", order: 30, label: "tmux", icon: "tmux", description: "观察当前 Workspace 中由 Wish 管理的 tmux 会话" }]);
    const terminalIcon = renderToStaticMarkup(createElement(Icon, { name: "terminal" }));
    const tmuxIcon = renderToStaticMarkup(createElement(Icon, { name: "tmux" }));
    assert.notEqual(tmuxIcon, terminalIcon, "tmux uses a split-session icon instead of the interactive terminal prompt");
    assert.match(tmuxIcon, /viewBox="0 0 16 16"[^>]*fill="currentColor"/u, "tmux keeps the solid cut-square Codicon geometry");
    assert.match(terminalIcon, /viewBox="0 0 24 24"[^>]*fill="none"[^>]*stroke="currentColor"/u, "the interactive terminal remains a line icon");
    const View = slots.getSnapshot().sessionSidebarItems[0].View;
    assert.equal(typeof View, "function");
    const markup = renderToStaticMarkup(createElement(View, { sessionId: "session-one", tab: { id: "tab-tmux", kind: "tmux", contentId: "page:tmux", title: "tmux", visible: true }, actions: { openTab() {}, openResource() {}, update() {}, close() {} } }));
    assert.match(markup, /class="tmux-sidebar-view"/u);
    assert.match(markup, /aria-label="刷新 tmux 列表"/u);
    assert.match(markup, /自动同步 · /u);
    assert.equal((markup.match(/role="status"/gu) ?? []).length, 1, "tmux renders exactly one top-level status line");
    assert.match(markup, /class="tmux-delete-trigger"[^>]*title="停止并删除 live"/u);
    assert.match(markup, /运行中 · 自动同步/u);
    assert.match(markup, /已退出 · 画面已保留/u);
    assert.match(markup, /停止并删除 live/u);
    assert.match(markup, /aria-label="删除 finished"/u);
    assert.doesNotMatch(markup, /settings-page|page-heading/u, "the sidebar contribution must not retain full-page chrome");
  } finally { await tmux.dispose(); await root.fiber.dispose(); }
  assert.deepEqual(slots.getSnapshot().sessionSidebarItems, []);
});
test("tmux live capture follows the dock's effective visibility", () => {
  assert.equal(tmuxLiveSyncEnabled(true, true, 1), true);
  assert.equal(tmuxLiveSyncEnabled(false, true, 1), false, "a hidden retained tab must not poll");
  assert.equal(tmuxLiveSyncEnabled(true, false, 1), false);
  assert.equal(tmuxLiveSyncEnabled(true, true, 0), false);
});
test("right sidebar icons mirror the left sidebar geometry", () => {
  const open = renderToStaticMarkup(createElement(Icon, { name: "panel-right-open" }));
  const close = renderToStaticMarkup(createElement(Icon, { name: "panel-right-close" }));
  assert.match(open, /M15 4v16M11 9l-3 3 3 3/u, "open mirrors the left-side open icon");
  assert.match(close, /M15 4v16M8 9l3 3-3 3/u, "close mirrors the left-side close icon");
});
test("sidebar resizing follows the DSH constrained column model", () => {
  assert.equal(resizeSidebarWidth(280, -999, "left", LEFT_SIDEBAR_MIN_WIDTH, LEFT_SIDEBAR_MAX_WIDTH), 264);
  assert.equal(resizeSidebarWidth(280, 999, "left", LEFT_SIDEBAR_MIN_WIDTH, LEFT_SIDEBAR_MAX_WIDTH), 420);
  assert.equal(resizeSidebarWidth(450, -40, "right", RIGHT_SIDEBAR_MIN_WIDTH, 600), 490, "moving the right divider left widens the panel");
  assert.equal(resizeSidebarWidth(450, 999, "right", RIGHT_SIDEBAR_MIN_WIDTH, 600), 300);
  assert.equal(rightSidebarMaxWidth(1000), 600, "the center keeps 400px before the 70% ceiling is considered");
  assert.equal(rightSidebarMaxWidth(650), 0, "a normal right track is unavailable when its minimum and the center minimum cannot fit");
  assert.equal(defaultRightSidebarWidth(1000), 450);
  const markup = renderToStaticMarkup(createElement(SidebarResizeHandle, { side: "left", width: 280, min: 264, max: 420, label: "调整左侧栏宽度", controls: "wish-sidebar", onChange() {} }));
  assert.match(markup, /role="separator"/u);
  assert.match(markup, /aria-valuemin="264" aria-valuemax="420" aria-valuenow="280"/u);
  assert.match(markup, /aria-controls="wish-sidebar"/u);
});
test("session dock keeps work tabs while switching to Start and adding windows", () => {
  const initial = createSessionDockLayout(["tmux", "tasks"]);
  assert.deepEqual(initial.panes.map(pane => pane.activeTabId), [null], "a new dock opens on Start");
  assert.equal(splitSessionDockPane(initial, initial.activePaneId), initial, "the narrow sidebar cannot split before fullscreen");
  const withTmux = openSessionDockTab(initial, initial.activePaneId, { kind: "tmux", contentId: "page:tmux", title: "tmux" });
  const tmuxId = withTmux.panes[0].activeTabId;
  assert.ok(tmuxId);
  const deduplicated = openSessionDockTab(withTmux, withTmux.activePaneId, { kind: "tmux", contentId: "page:tmux", title: "tmux" });
  assert.equal(deduplicated, withTmux, "opening a singleton resource selects its existing tab");
  const firstTerminal = openSessionDockTab(withTmux, withTmux.activePaneId, { kind: "terminal", contentId: "terminal:first", title: "bash", multiple: true });
  const secondTerminal = openSessionDockTab(firstTerminal, firstTerminal.activePaneId, { kind: "terminal", contentId: "terminal:second", title: "bash", multiple: true });
  assert.equal(secondTerminal.panes[0].tabIds.length, 3, "multiple terminal resources remain independent tabs");
  const updated = updateSessionDockTab(secondTerminal, secondTerminal.panes[0].activeTabId, { terminalId: "pty-2" }, "bash · 2");
  assert.equal(updated.tabs[updated.panes[0].activeTabId].params.terminalId, "pty-2");
  const fullscreen = toggleSessionDockFullscreen(selectSessionDockTab(updated, updated.activePaneId, tmuxId));
  assert.equal(fullscreen.fullscreen, true);
  const firstFiles = openSessionDockTab(fullscreen, fullscreen.activePaneId, { kind: "files", contentId: "files:first", title: "文件", multiple: true });
  const secondFiles = openSessionDockTab(firstFiles, firstFiles.activePaneId, { kind: "files", contentId: "files:second", title: "文件", multiple: true });
  assert.equal(secondFiles.panes[0].tabIds.length, 5, "adding Files twice preserves the existing tabs and opens two independent work windows");
  const start = openSessionDockGuide(secondFiles, secondFiles.activePaneId);
  assert.equal(start.panes[0].activeTabId, null, "the plus control switches to Start");
  assert.deepEqual(start.panes[0].tabIds, secondFiles.panes[0].tabIds, "Start keeps every existing work tab in the top strip");
  assert.equal(Object.keys(start.tabs).length, 5, "switching to Start does not discard work windows");
  assert.equal(selectSessionDockTab(start, start.activePaneId, tmuxId).panes[0].activeTabId, tmuxId, "existing tabs stay selectable from Start");
  const split = splitSessionDockPane(selectSessionDockTab(secondFiles, secondFiles.activePaneId, tmuxId), secondFiles.activePaneId);
  assert.equal(split.panes.length, 2);
  assert.equal(split.activePaneId, split.panes[1].id);
  assert.deepEqual(split.panes.map(pane => pane.activeTabId), [tmuxId, null], "a new pane opens on Start without replacing the source window");
  const selected = openSessionDockTab(split, split.panes[1].id, { kind: "tasks", contentId: "page:tasks", title: "Tasks" });
  assert.deepEqual(selected.panes.map(pane => pane.activeTabId !== null && selected.tabs[pane.activeTabId].kind), ["tmux", "tasks"]);
  const collapsed = toggleSessionDockFullscreen(selected);
  assert.equal(collapsed.fullscreen, false);
  assert.equal(collapsed.panes.length, 2, "exiting fullscreen does not destroy a resource pane");
  const reconciled = reconcileSessionDockLayout(selected, ["tmux"]);
  assert.deepEqual(reconciled.panes.map(pane => pane.activeTabId !== null && reconciled.tabs[pane.activeTabId].kind), ["tmux", "tasks"], "temporarily unloaded resource kinds retain their tabs for recovery");
  const recovered = reconcileSessionDockLayout({ panes: "broken", tabs: null }, ["tmux"]);
  assert.deepEqual(recovered, initial, "corrupt persisted layout falls back to Start instead of breaking the conversation");
  assert.deepEqual(closeSessionDockPane(reconciled, reconciled.panes[0].id).panes.map(pane => pane.id), [reconciled.panes[1].id]);
  assert.equal(closeSessionDockTab(withTmux, tmuxId).panes[0].activeTabId, null);
  let capped = createSessionDockLayout(["files"]);
  for (let index = 0; index < 100; index++) capped = openSessionDockTab(capped, capped.activePaneId, { kind: "files", contentId: `files:${index}`, title: "文件", multiple: true });
  assert.equal(openSessionDockTab(capped, capped.activePaneId, { kind: "files", contentId: "files:overflow", title: "文件", multiple: true }), capped, "appending beyond the valid tab limit cannot discard existing windows on reconcile");
});
test("theme adapter follows the Host settings snapshot and releases its subscription", () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const model = new Probe({ sections: [], writable: true, error: null, pending: false });
  const attributes = new Map([["data-theme", "dark"]]), root = { setAttribute(name, value) { attributes.set(name, value); } };
  const stop = bindTheme(model, root);
  assert.equal(selectedTheme(model), "light"); assert.equal(attributes.get("data-theme"), "dark", "Host-projected theme survives the empty client snapshot");
  model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { theme: "dark" } }] });
  assert.equal(selectedTheme(model), "dark"); assert.equal(attributes.get("data-theme"), "dark");
  stop(); model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { theme: "light" } }] });
  assert.equal(attributes.get("data-theme"), "dark");
});
test("appearance adapter applies language and font size live, then preserves the last state after disposal", () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const model = new Probe({ sections: [], writable: true, error: null, pending: false });
  const attributes = new Map([["data-theme", "dark"], ["lang", "en-US"], ["data-font-size", "extra-large"]]);
  const root = { setAttribute(name, value) { attributes.set(name, value); } };
  const stop = bindAppearance(model, root);
  assert.equal(attributes.get("lang"), "en-US", "Host-projected language survives the empty client snapshot");
  assert.equal(attributes.get("data-font-size"), "extra-large", "Host-projected font size survives the empty client snapshot");
  model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { theme: "light", language: "zh-CN", "font-size": "standard" } }] });
  assert.equal(selectedLanguage(model), "zh-CN");
  assert.equal(selectedFontSize(model), "standard");
  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(attributes.get("lang"), "zh-CN");
  assert.equal(attributes.get("data-font-size"), "standard");
  stop();
  model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { language: "en-US", "font-size": "extra-large" } }] });
  assert.equal(attributes.get("lang"), "zh-CN");
  assert.equal(attributes.get("data-font-size"), "standard");
});
test("Browser Cordis disposes UI seats on effective capability loss and recreates on Host generation change", async () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const root = new Context(), slots = new UiSlots();
  const management = new Probe({ data: { inspection: { entries: [] } } });
  const connection = new Probe({ online: true, instanceId: "root-one" });
  root.provide("wishManagement", management); root.provide("wishConnection", connection); root.provide("wishUiSlots", slots);
  let opened = 0, closed = 0;
  const Sidebar = () => null, onOpen = () => {};
  const stop = bindCapabilityUi(root, { name: "probe-ui", inject: ["wishUiSlots"], apply(ctx) {
    opened++; ctx.effect(() => ctx.wishUiSlots.panel({ id: "probe", label: "Probe", area: "workspace", navigation: "rail", Sidebar, onOpen, View() {}, Icon() {} }));
    ctx.effect(() => () => { closed++; });
  } }, ["include:probe"]);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    management.update({ data: { inspection: { entries: [{ id: "include:probe", enabled: true, phase: "active" }] } } }); await settle();
    assert.equal(slots.getSnapshot().panels.length, 1); assert.equal(opened, 1);
    assert.equal(slots.getSnapshot().panels[0].navigation, "rail", "global navigation is an owned panel contribution");
    assert.equal(slots.getSnapshot().panels[0].Sidebar, Sidebar);
    assert.equal(slots.getSnapshot().panels[0].onOpen, onOpen);
    connection.update({ online: true, instanceId: "root-two" }); await settle();
    assert.equal(opened, 2); assert.equal(closed, 1);
    management.update({ data: { inspection: { entries: [{ id: "include:probe", enabled: true, phase: "pending" }] } } }); await settle();
    assert.equal(slots.getSnapshot().panels.length, 0); assert.equal(closed, 2);
  } finally { await stop(); await root.fiber.dispose(); }
});
test("Skills and Models own their global-rail and settings-area seats", async () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } async refresh() {} async act() {} }
  const root = new Context(), slots = new UiSlots();
  root.provide("wishUiSlots", slots);
  root.provide("wishFeatures", new Probe({ sessionId: null, views: [], error: null, available: false, pending: false }));
  root.provide("wishSettings", new Probe({ sections: [], writable: true, error: null, pending: false }));
  root.provide("wishSession", new Probe({ selectedId: null }));
  root.provide("wishNewSession", new NewSessionClientModel({ startCreate() {}, async create() { return "new"; }, async send() {} }, new ComposerDrafts()));
  const connection = new Probe({ online: true, instanceId: "root", businessAvailable: true, error: null });
  connection.onInvalidation = () => () => {};
  connection.request = async () => ({ value: { schemaVersion: 1, workspace: { root: "/workspace", fingerprint: "workspace", revision: "one" },
    catalogDigest: "empty", skills: [], issues: [] } });
  root.provide("wishConnection", connection);
  const skills = await root.plugin(SkillsClientUi), models = await root.plugin(ModelsClientUi);
  try {
    const panels = slots.getSnapshot().panels;
    const skillsPanel = panels.find(panel => panel.id === "skills");
    assert.equal(skillsPanel.label, "Skills"); assert.equal(skillsPanel.area, "workspace"); assert.equal(skillsPanel.navigation, "rail");
    assert.equal(typeof skillsPanel.Icon, "function"); assert.equal(typeof skillsPanel.View, "function");
    assert.equal(typeof skillsPanel.Sidebar, "function"); assert.equal(typeof skillsPanel.onOpen, "function");
    assert.equal(panels.find(panel => panel.id === "models").area, "settings");
    assert.equal(panels.find(panel => panel.id === "models").navigation, undefined);
    assert.deepEqual(slots.getSnapshot().composerItems.map(item => item.id), ["model-reasoning"]);
    assert.deepEqual(slots.getSnapshot().newSessionComposerItems.map(item => item.id), ["model-reasoning"]);
    await skills.dispose();
    assert.equal(slots.getSnapshot().panels.some(panel => panel.id === "skills"), false);
    assert.equal(slots.getSnapshot().panels.some(panel => panel.id === "models"), true);
  } finally { await models.dispose(); assert.deepEqual(slots.getSnapshot().composerItems, []); assert.deepEqual(slots.getSnapshot().newSessionComposerItems, []); await root.fiber.dispose(); }
});
test("Skills client reads a global catalog and selects without a Session feature port", async () => {
  const entry = { packageId: "package", name: "inspect", description: "Inspect first", source: "workspace", digest: "digest", modelInvocable: true };
  const data = { schemaVersion: 1, workspace: { root: "/workspace", fingerprint: "workspace", revision: "one" }, catalogDigest: "catalog", skills: [entry], issues: [] };
  class ConnectionProbe extends SnapshotStore {
    calls = [];
    onInvalidation() { return () => {}; }
    async request(path, body) {
      this.calls.push({ path, body });
      return { value: body ? { schemaVersion: 1, entry, content: "Complete instructions" } : data };
    }
  }
  const connection = new ConnectionProbe({ online: true, businessAvailable: true, instanceId: "root", error: null });
  const model = new SkillsClientModel(connection);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().skills[0].name, "inspect");
    assert.equal(parseSkillFeatureData({ ...data, selectionChanged: false, skills: [{ ...entry, source: "remote" }] }), undefined);
    await model.select("inspect");
    assert.deepEqual(connection.calls.at(-1), { path: "/api/queries/skills/default",
      body: { name: "inspect", expectedDigest: "digest", expectedPackageId: "package" } });
    assert.equal(model.getSnapshot().selected.content, "Complete instructions");
  } finally { model.close(); }
});
test("Models client projects safe metadata and applies direct model, capacity and credential changes", async () => {
  class SettingsProbe extends SnapshotStore {
    async save(view, user) {
      const next = { ...view, revision: `${view.revision}-next`, user: { ...user }, value: { ...view.base, ...user } };
      this.publish({ ...this.getSnapshot(), sections: [next] });
      return next;
    }
  }
  class ConnectionProbe extends SnapshotStore {
    secret;
    async request(path, body) {
      if (path.endsWith("/describe")) return { credentials: body.references.map(reference => ({ reference, configured: false, source: "missing", writable: true })) };
      if (path.endsWith("/set")) { this.secret = body.value; return { credential: { reference: body.reference, configured: true, source: "stored", writable: true } }; }
      if (path.endsWith("/delete")) return { credential: { reference: body.reference, configured: false, source: "missing", writable: true } };
      throw Error("unexpected route");
    }
  }
  const section = { namespace: "models", title: "默认模型", applies: "next-request", revision: "one",
    base: { "default-model": "fixture/one", "context-window-overrides": "{}", "max-output-token-overrides": "{}" }, user: {},
    value: { "default-model": "fixture/one", "context-window-overrides": "{}", "max-output-token-overrides": "{}" }, fields: [{ key: "default-model", label: "模型", type: "enum", default: "fixture/one", options: [
      { value: "fixture/one", label: "One", attributes: { provider: "fixture", model: "one", contextWindowTokens: 128000, maxOutputTokens: 2048, defaultMaxOutputTokens: 1024, apiKeyEnv: "FIXTURE_API_KEY" } },
      { value: "fixture/two", label: "Two", attributes: { provider: "fixture", model: "two", contextWindowTokens: 256000, apiKeyEnv: "FIXTURE_API_KEY" } },
    ] }, { key: "context-window-overrides", label: "窗口", type: "string", default: "{}", maxLength: 4096, hidden: true },
    { key: "max-output-token-overrides", label: "最大输出", type: "string", default: "{}", maxLength: 4096, hidden: true }] };
  const settings = new SettingsProbe({ sections: [section], writable: true, error: null, pending: false });
  const connection = new ConnectionProbe({ online: true, instanceId: "root", businessAvailable: true, error: null });
  const model = new ModelsSettingsClientModel(settings, connection);
  try {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().choices[1].contextWindowTokens, 256000);
    assert.equal(model.getSnapshot().credentials.FIXTURE_API_KEY.source, "missing");
    await model.selectModel("fixture/two");
    assert.equal(model.getSnapshot().selectedModel, "fixture/two");
    await model.setContextWindow("fixture/two", parseCapacity("320K"));
    assert.equal(JSON.parse(model.getSnapshot().section.value["context-window-overrides"])["fixture/two"], 320000);
    assert.equal(model.getSnapshot().choices[0].defaultMaxOutputTokens, 1024);
    await model.setMaxOutputTokens("fixture/one", parseCapacity("1.5K"));
    assert.equal(JSON.parse(model.getSnapshot().section.value["max-output-token-overrides"])["fixture/one"], 1500);
    await assert.rejects(model.setMaxOutputTokens("fixture/one", 3000), /不能超过模型支持的上限/u);
    await model.setMaxOutputTokens("fixture/one", undefined);
    assert.equal(model.getSnapshot().section.value["max-output-token-overrides"], "{}");
    await model.setCredential("FIXTURE_API_KEY", "private-key");
    assert.equal(connection.secret, "private-key");
    assert.equal(JSON.stringify(model.getSnapshot()).includes("private-key"), false);
  } finally { model.close(); }
});
test("Models client shows the effective Flash for a saved retired DeepSeek selection", () => {
  const old = "deepseek/deepseek-v4-flash-vision-exp", current = "deepseek/deepseek-flash";
  const section = { namespace: "models", title: "默认模型", applies: "next-request", revision: "one",
    base: { "default-model": current }, user: { "default-model": old }, value: { "default-model": old },
    fields: [{ key: "default-model", type: "enum", options: [
      { value: current, label: "DeepSeek V4.1 Flash" }, { value: old, label: "已退役兼容名" },
    ] }] };
  const settings = new SnapshotStore({ sections: [section], writable: true, error: null, pending: false });
  const connection = new SnapshotStore({ online: false, instanceId: "root", businessAvailable: false, error: null });
  const model = new ModelsSettingsClientModel(settings, connection);
  try {
    assert.equal(model.getSnapshot().selectedModel, current);
    assert.equal(model.getSnapshot().section.user["default-model"], old, "migration projection does not silently rewrite persisted settings");
  } finally { model.close(); }
});
test("immutable store keeps snapshot identity until publication and unsubscribes", () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const initial = Object.freeze({ value: 1 }), store = new Probe(initial);
  let calls = 0; const stop = store.subscribe(() => { calls++; });
  assert.equal(store.getSnapshot(), initial); store.update(initial); assert.equal(calls, 0);
  store.update({ value: 2 }); assert.equal(calls, 1); assert.ok(Object.isFrozen(store.getSnapshot()));
  stop(); store.update({ value: 3 }); assert.equal(calls, 1);
});
test("invalidation during read is folded, stale result is discarded, close prevents late commit", async () => {
  const entered = deferred(), release = deferred(); let reads = 0; const results = [];
  const queue = new RefreshQueue(async current => { const read = ++reads; if (read === 1) { entered.resolve(); await release.promise; } if (current()) results.push(read); });
  const first = queue.request(); await entered.promise;
  const second = queue.request(), third = queue.request();
  release.resolve(); await Promise.all([first, second, third]);
  assert.equal(reads, 2); assert.deepEqual(results, [2]);
  queue.close(); await queue.request(); assert.equal(reads, 2);
});
test("connection owns CSRF token, rejects API errors, closes SSE and inflight requests", async () => {
  const sent = [], events = { addEventListener() {}, close() { this.closed = true; } };
  const fetcher = async (path, options) => {
    sent.push({ path, options });
    return { ok: path !== "/api/fail", status: 409, json: async () => path === "/api/management/bootstrap" ? { token: "a".repeat(64), instanceId: "root", businessAvailable: false } : { error: { code: "conflict", message: "请先完成或清除当前 Goal。" } } };
  };
  const connection = new ClientConnection(fetcher, () => events);
  await connection.start(); await connection.request("/api/action", { test: true });
  assert.equal(sent[1].options.headers["X-Wish-Management-Token"], "a".repeat(64));
  assert.equal(connection.getSnapshot().businessAvailable, false);
  await assert.rejects(connection.request("/api/fail"), { code: "conflict", message: "请先完成或清除当前 Goal。" });
  connection.close(); assert.equal(events.closed, true);
  await assert.rejects(connection.request("/api/action"), { code: "connection_closed" });
});
test("settings mirror does not optimistically commit failed saves", async () => {
  let invalidate;
  const view = { namespace: "ui", revision: "one", user: {}, value: { mode: "queue" } };
  const connection = { onInvalidation(fn) { invalidate = fn; return () => { invalidate = undefined; }; }, getSnapshot: () => ({ online: true }),
    async request(path) { if (path.endsWith("/replace")) throw Error("settings_revision_conflict"); return { writable: true, sections: [view] }; } };
  const model = new SettingsClientModel(connection); await model.refresh();
  await assert.rejects(model.save(view, { mode: "steer" }), /settings_revision_conflict/);
  assert.equal(model.getSnapshot().sections[0].value.mode, "queue");
  model.close(); assert.equal(invalidate, undefined);
  await assert.rejects(model.save(view, { mode: "steer" }), /设置当前不可写/);
});
test("UI-owned drafts survive panel/session switches without clearing newer input on a late receipt", () => {
  const drafts = new ComposerDrafts(), first = drafts.forSession("one"); first.set("submitted");
  drafts.forSession("two").set("independent");
  assert.equal(drafts.forSession("one"), first);
  first.set("newer input"); first.accepted("submitted"); assert.equal(first.getSnapshot(), "newer input");
  first.accepted("newer input"); assert.equal(first.getSnapshot(), "");
  assert.equal(drafts.forSession("two").getSnapshot(), "independent"); drafts.close();
});
test("wire snapshots deeply freeze nested JSON without freezing services", () => {
  const value = freezeWire({ events: [{ payload: { text: "fact" } }] });
  assert.throws(() => { value.events[0].payload.text = "changed"; });
  assert.throws(() => value.events.push({}));
});
test("plugin confirmation uses the displayed generation/revision and cannot submit after model disposal", async () => {
  let writes = 0;
  const connection = { onInvalidation() { return () => {}; }, getSnapshot: () => ({ online: true }), async request(path) {
    if (path.endsWith("/change")) writes++;
    return { inspection: { instanceId: "new-root", entries: [] }, revision: "new-version", status: "ready", writable: true };
  } };
  const model = new PluginManagementModel(connection); await model.refresh();
  await assert.rejects(model.change(["include:feature"], "disabled", { instanceId: "old-root", revision: "new-version" }), /management_revision_conflict/);
  await assert.rejects(model.change(["include:feature"], "disabled", { instanceId: "new-root", revision: "old-version" }), /management_revision_conflict/);
  model.close(); await assert.rejects(model.change(["include:feature"], "disabled", { instanceId: "new-root", revision: "new-version" }), /管理状态不可用/);
  assert.equal(writes, 0);
});
test("plugin change follows the accepted durable operation before reading its receipt", async () => {
  const operationId = "operation-id";
  let receipt = null, polls = 0, submittedRequestId;
  const data = () => ({ owners: [], requests: [], operations: [], codeReload: null, protocols: [],
    inspection: { instanceId: "root", entries: [], fibers: [] }, revision: "revision", preferences: {}, controls: {},
    pending: null, status: "ready", writable: true, operation: null, lastReceipt: receipt,
    configuration: { watching: true, phase: "idle", digest: "digest", code: null } });
  const connection = { onInvalidation() { return () => {}; }, getSnapshot: () => ({ online: true }), async request(path, body) {
    if (path === "/api/management/plugins") return data();
    if (path.endsWith("/change")) {
      submittedRequestId = body.requestId;
      return { operation: { id: operationId, kind: "disable", source: "management",
        requestId: body.requestId, entryIds: body.selection.entryIds, fingerprint: "a".repeat(64), submittedRevision: body.revision,
        phase: "queued", code: null, cancellable: true } };
    }
    if (path.endsWith(`/operations/${operationId}`)) {
      polls++;
      receipt = { requestId: submittedRequestId, fingerprint: "a".repeat(64), status: "succeeded", code: "management_saved" };
      return { operation: { id: operationId, kind: "disable", source: "management", requestId: submittedRequestId,
        entryIds: ["include:feature"], fingerprint: "a".repeat(64), submittedRevision: "revision",
        phase: "succeeded", code: null, cancellable: false }, receipt };
    }
    throw Error(`unexpected path ${path}`);
  } };
  const model = new PluginManagementModel(connection); await model.refresh();
  const result = await model.change(["include:feature"], "disabled", { instanceId: "root", revision: "revision" });
  assert.equal(result.status, "succeeded"); assert.equal(polls, 1);
  model.close();
});
test("historical Tool availability comes from known Host entries, never from missing renderers", async () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const root = new Context(), slots = new UiSlots();
  const management = new Probe({ data: { inspection: { instanceId: "root", entries: [{ id: "include:tool", enabled: true, phase: "active" }] } } });
  const connection = new Probe({ online: true, instanceId: "root" });
  root.provide("wishManagement", management); root.provide("wishConnection", connection); root.provide("wishUiSlots", slots);
  const stop = bindToolAvailability(root, ["known_tool"], ["include:tool"]);
  assert.equal(slots.getSnapshot().toolViews.length, 0);
  assert.equal(slots.getSnapshot().toolAvailability[0].state, "available");
  management.update({ data: { inspection: { instanceId: "root", entries: [{ id: "include:tool", enabled: false, phase: "absent" }] } } });
  assert.equal(slots.getSnapshot().toolAvailability[0].state, "unavailable");
  connection.update({ online: false, instanceId: "root" });
  assert.equal(slots.getSnapshot().toolAvailability[0].state, "unknown");
  stop(); await root.fiber.dispose();
});
