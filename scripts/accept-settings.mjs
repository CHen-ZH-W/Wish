import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Settings } from "../dist/settings/settings.js";
import { FileSettingsStore } from "../dist/settings/providers/file.js";
import { SettingsService } from "../dist/settings/service.js";
import { ComposerPreferences } from "../dist/apps/webui/host/preferences.js";

const definition = {
  namespace: "composer", title: "消息输入", applies: "next-request",
  fields: [{ key: "busy-delivery", label: "运行中发送方式", type: "enum", options: ["queue", "steer"], default: "queue" },
    { key: "show-time", label: "显示时间", type: "boolean", default: true }],
  base: { "show-time": false },
};
const change = (scope, user) => ({ namespace: "composer", revision: scope.view().revision, user });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-settings-"));
  try { await run(join(directory, "settings.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test("defaults/base/user resolve, reset re-inherits, document survives reopen", () => fixture(async file => {
  const settings = new Settings(await FileSettingsStore.open(file));
  const scope = settings.register(definition);
  try {
    assert.deepEqual(scope.get(), { "busy-delivery": "queue", "show-time": false });
    const next = await settings.replace(change(scope, { "busy-delivery": "steer" }));
    assert.equal(next.value["busy-delivery"], "steer");
    assert.equal(next.value["show-time"], false);
    await settings.replace(change(scope, {}));
    assert.equal(scope.get()["busy-delivery"], "queue");
    await settings.replace(change(scope, { "show-time": true }));
  } finally { await settings.close(); }
  const restored = new Settings(await FileSettingsStore.open(file));
  try { assert.equal(restored.register(definition).get()["show-time"], true); }
  finally { await restored.close(); }
}));
test("WebUI language and text size remain selected after Settings reopens", () => fixture(async file => {
  const definitions = [];
  ComposerPreferences.apply({ settings: { register(_owner, definition) { definitions.push(definition); } } });
  const appearance = definitions.find(definition => definition.namespace === "webui-appearance");
  const settings = new Settings(await FileSettingsStore.open(file));
  const scope = settings.register(appearance);
  try {
    assert.equal(scope.get().language, "zh-CN");
    assert.equal(scope.get()["font-size"], "standard");
    await settings.replace({ namespace: appearance.namespace, revision: scope.view().revision, user: { language: "en-US", "font-size": "extra-large" } });
  } finally { await settings.close(); }
  const restored = new Settings(await FileSettingsStore.open(file));
  try {
    const value = restored.register(appearance).get();
    assert.equal(value.language, "en-US");
    assert.equal(value["font-size"], "extra-large");
  } finally { await restored.close(); }
}));
test("concurrent editors are CAS checked at dispatch, only commits notify", () => fixture(async file => {
  const settings = new Settings(await FileSettingsStore.open(file));
  const scope = settings.register(definition), events = [];
  settings.subscribe(event => events.push(event));
  settings.subscribe(() => { throw Error("observer cannot undo commit"); });
  settings.subscribe(async () => { throw Error("async observer cannot undo commit"); });
  try {
    const request = change(scope, { "busy-delivery": "steer" });
    const first = settings.replace(request);
    const second = settings.replace(request);
    request.user["busy-delivery"] = "queue";
    await first;
    await assert.rejects(second, { code: "settings_revision_conflict" });
    assert.equal(scope.get()["busy-delivery"], "steer");
    assert.deepEqual(events.map(event => event.kind), ["committed"]);
    assert.throws(() => { scope.get()["show-time"] = false; });
  } finally { await settings.close(); }
}));
test("unknown/prototype/invalid fields and cross-field violations never persist", () => fixture(async file => {
  const settings = new Settings(await FileSettingsStore.open(file));
  const scope = settings.register({ ...definition, validate: value => { if (value["busy-delivery"] === "steer" && value["show-time"]) throw Error("invalid combination"); } });
  try {
    for (const user of [{ unknown: true }, { "show-time": "true" }, { "busy-delivery": "execute" },
      { "busy-delivery": "steer", "show-time": true }, JSON.parse('{"__proto__":true}')]) {
      await assert.rejects(settings.replace(change(scope, user)));
    }
    await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.throws(() => settings.register({ ...definition, namespace: "other", fields: [{ key: "value", label: "test", type: "string", maxLength: 5000, default: "" }] }));
  } finally { await settings.close(); }
}));
test("save failure does not publish success or change the effective value", async () => {
  const store = { writable: true, read: () => ({ version: 1, revision: "x", sections: {} }), save: async () => { throw Error("disk full"); }, close: async () => {} };
  const settings = new Settings(store), scope = settings.register(definition), events = [];
  settings.subscribe(event => events.push(event));
  await assert.rejects(settings.replace(change(scope, { "busy-delivery": "steer" })), /disk full/);
  assert.equal(scope.get()["busy-delivery"], "queue"); assert.equal(events.length, 0);
  await settings.close();
});
test("owner disposal during persistence excludes replacement until the committed write settles", async () => {
  let saved, enter; const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { saved = resolve; });
  let document = { version: 1, revision: "x", sections: {} };
  const store = { writable: true, read: () => document, save: async (_revision, sections) => { enter(); await gate; return document = { version: 1, revision: "y", sections }; }, close: async () => {} };
  const settings = new Settings(store), scope = settings.register(definition);
  const writing = settings.replace(change(scope, { "busy-delivery": "steer" }));
  await entered; scope.dispose();
  assert.equal(settings.describe().sections.length, 0);
  assert.throws(() => settings.register(definition), { code: "settings_owner_exists" });
  assert.throws(() => scope.get(), { code: "settings_owner_closed" });
  saved(); await assert.rejects(writing, { code: "settings_saved_owner_closed" });
  assert.equal(settings.register(definition).get()["busy-delivery"], "steer");
  await settings.close();
});
test("file writer exclusivity, external revision conflict, corrupt storage fail closed", () => fixture(async file => {
  const store = await FileSettingsStore.open(file);
  try {
    await assert.rejects(FileSettingsStore.open(file), { code: "settings_store_locked" });
    await writeFile(file, JSON.stringify({ version: 1, revision: "external", sections: {} }));
    await assert.rejects(store.save("initial", {}), { code: "settings_revision_conflict" });
  } finally { await store.close(); }
  await writeFile(file, '{"version":1,"revision":"x","sections":{"constructor":{}}}');
  await assert.rejects(FileSettingsStore.open(file), { code: "settings_store_corrupt" });
}));
test("Cordis owner unload removes descriptor and invalidates captured scope", () => fixture(async file => {
  const ctx = new Context();
  new SettingsService(ctx, await FileSettingsStore.open(file));
  let scope;
  const fiber = ctx.plugin({ name: "settings-consumer", inject: ["settings"], apply: owner => { scope = owner.settings.register(owner, definition); } });
  try {
    await fiber;
    assert.equal(ctx.settings.port.describe().sections.length, 1);
    await fiber.dispose();
    assert.equal(ctx.settings.port.describe().sections.length, 0);
    assert.throws(() => scope.get(), { code: "settings_owner_closed" });
  } finally { await ctx.fiber.dispose(); }
}));
test("large model choices are valid and a removed stored choice stays visible but cannot be saved again", async () => {
  let document = { version: 1, revision: "stored", sections: { models: { "default-model": "fixture/removed" } } };
  const store = { writable: true, read: () => document, save: async (_revision, sections) => document = { version: 1, revision: "saved", sections }, close: async () => {} };
  const settings = new Settings(store);
  const options = Array.from({ length: 803 }, (_, index) => `fixture/model-${index}`);
  const scope = settings.register({ namespace: "models", title: "默认模型", applies: "next-request", fields: [{ key: "default-model", label: "新运行使用的模型", type: "enum", options, default: options[0], allowStale: true }] });
  try {
    assert.equal(scope.get()["default-model"], "fixture/removed");
    await assert.rejects(settings.replace({ namespace: "models", revision: scope.view().revision, user: { "default-model": "fixture/removed" } }), { code: "settings_validation_failed" });
    const repaired = await settings.replace({ namespace: "models", revision: scope.view().revision, user: { "default-model": options.at(-1) } });
    assert.equal(repaired.value["default-model"], options.at(-1));
  } finally { await settings.close(); }
});
