import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RefreshQueue, SnapshotStore, freezeWire } from "../dist/apps/webui/client/model/store.js";
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

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
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
test("theme adapter follows the Host settings snapshot and releases its subscription", () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const model = new Probe({ sections: [], writable: true, error: null, pending: false });
  const attributes = new Map(), root = { setAttribute(name, value) { attributes.set(name, value); } };
  const stop = bindTheme(model, root);
  assert.equal(selectedTheme(model), "light"); assert.equal(attributes.get("data-theme"), "light");
  model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { theme: "dark" } }] });
  assert.equal(selectedTheme(model), "dark"); assert.equal(attributes.get("data-theme"), "dark");
  stop(); model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { theme: "light" } }] });
  assert.equal(attributes.get("data-theme"), "dark");
});
test("appearance adapter applies language and font size live, then preserves the last state after disposal", () => {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const model = new Probe({ sections: [], writable: true, error: null, pending: false });
  const attributes = new Map(), root = { setAttribute(name, value) { attributes.set(name, value); } };
  const stop = bindAppearance(model, root);
  assert.equal(attributes.get("lang"), "zh-CN");
  assert.equal(attributes.get("data-font-size"), "standard");
  model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { theme: "dark", language: "en-US", "font-size": "extra-large" } }] });
  assert.equal(selectedLanguage(model), "en-US");
  assert.equal(selectedFontSize(model), "extra-large");
  assert.equal(attributes.get("data-theme"), "dark");
  assert.equal(attributes.get("lang"), "en-US");
  assert.equal(attributes.get("data-font-size"), "extra-large");
  stop();
  model.update({ ...model.getSnapshot(), sections: [{ namespace: "webui-appearance", value: { language: "zh-CN", "font-size": "standard" } }] });
  assert.equal(attributes.get("lang"), "en-US");
  assert.equal(attributes.get("data-font-size"), "extra-large");
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
test("Skills client projects a module-owned catalog and selects through the generic feature port", async () => {
  const entry = { packageId: "package", name: "inspect", description: "Inspect first", source: "workspace", digest: "digest", modelInvocable: true };
  const data = { schemaVersion: 1, workspace: { fingerprint: "workspace", revision: "one" }, skills: [entry], issues: [], selectionChanged: false };
  class FeaturesProbe extends SnapshotStore {
    calls = [];
    async refresh() {}
    async act(sessionId, view, action, feedback) {
      this.calls.push({ sessionId, action, feedback });
      this.publish({ ...this.getSnapshot(), views: [{ ...view, data: { ...data, selected: { entry, content: "Complete instructions" } } }] });
    }
  }
  const feature = { key: "skills", title: "Skills", text: "", data, token: { reviewId: "one" }, actions: [{ name: "inspect", label: "查看", feedback: true }] };
  const features = new FeaturesProbe({ sessionId: "session", views: [feature], error: null, available: true, pending: false });
  const model = new SkillsClientModel(features);
  try {
    assert.equal(model.getSnapshot().skills[0].name, "inspect");
    assert.equal(parseSkillFeatureData({ ...data, skills: [{ ...entry, source: "remote" }] }), undefined);
    await model.select("inspect");
    assert.deepEqual(features.calls, [{ sessionId: "session", action: "inspect", feedback: "inspect" }]);
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
    return { ok: path !== "/api/fail", status: 409, json: async () => path === "/api/management/bootstrap" ? { token: "a".repeat(64), instanceId: "root", businessAvailable: false } : { error: { code: "conflict" } } };
  };
  const connection = new ClientConnection(fetcher, () => events);
  await connection.start(); await connection.request("/api/action", { test: true });
  assert.equal(sent[1].options.headers["X-Wish-Management-Token"], "a".repeat(64));
  assert.equal(connection.getSnapshot().businessAvailable, false);
  await assert.rejects(connection.request("/api/fail"), { code: "conflict" });
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
