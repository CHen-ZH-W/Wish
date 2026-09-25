import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Tools from "../dist/tools/service.js";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { PluginManagementClassifier } from "../dist/boot/plugin-control/classification.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";
import { ManagedPluginControl } from "../dist/boot/plugin-control/managed-control.js";
import { ManagedProfileSource, managedProfilePlugin } from "../dist/boot/plugin-control/managed-profile.js";
import { parseWishPluginManifest, readWishPluginManifest } from "../dist/boot/plugin-control/manifest.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const example = join(repository, "examples/plugins/greeting");
const provider = join(example, "provider.mjs"), consumer = join(example, "tool.mjs");
const providerManifest = join(example, "provider.wish-plugin.json"), consumerManifest = join(example, "tool.wish-plugin.json");
const state = Object.freeze({ schemaVersion: 2, revision: "initial", preferences: {}, pending: null, receipts: [], operations: [] });

function entries(prefix = "Hello") {
  return [
    { id: "provider", name: pathToFileURL(provider).href, management: { manifest: providerManifest }, config: { prefix } },
    { id: "tool", name: pathToFileURL(consumer).href, management: { manifest: consumerManifest } },
  ];
}

test("v1 manifest is fail-closed and class-only unknown code remains noncompliant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-manifest-"));
  try {
    const loaded = readWishPluginManifest(providerManifest, join(repository, "cordis.yml"), pathToFileURL(provider).href, { prefix: "Hello" });
    assert.deepEqual(loaded.view, {
      apiVersion: "wish.plugin/v1", id: "example.greeting-provider", displayName: "Greeting Provider", replacement: "drain",
      capabilities: [], isolation: "trusted-in-process", state: { mode: "stateless" },
    });
    assert.throws(() => readWishPluginManifest(providerManifest, join(repository, "cordis.yml"), pathToFileURL(provider).href, { prefix: 1 }),
      { code: "plugin_config_invalid" });
    const raw = JSON.parse(await readFile(providerManifest, "utf8"));
    assert.throws(() => parseWishPluginManifest({ ...raw, apiVersion: "wish.plugin/v2" }), { code: "plugin_manifest_api_unsupported" });
    assert.throws(() => parseWishPluginManifest({ ...raw, permissions: { capabilities: ["network.connect"] } }),
      { code: "plugin_manifest_sandbox_inconsistent" });
    await writeFile(join(directory, "plugin.mjs"), "export function apply() {}\n");
    const profile = join(directory, "cordis.json");
    await writeFile(profile, JSON.stringify([{ id: "plugin", name: "./plugin.mjs", management: { class: "managed" } }]));
    const classifier = new PluginManagementClassifier();
    const classOnly = new ManagedProfileSource(profile, "include", state, undefined, classifier);
    assert.equal(classOnly.managementClasses().size, 0, "unknown code cannot self-promote with class: managed");
    await writeFile(join(directory, "plugin.wish-plugin.json"), JSON.stringify({ ...raw, id: "fixture.plugin", entry: "./plugin.mjs" }));
    await writeFile(profile, JSON.stringify([{ id: "plugin", name: "./plugin.mjs", management: { manifest: "./plugin.wish-plugin.json" }, config: { prefix: "Hi" } }]));
    const declared = new ManagedProfileSource(profile, "include", state, undefined, classifier);
    assert.equal(declared.managementClasses().get("include:plugin").manifest.id, "fixture.plugin");
    assert.deepEqual(new Set(declared.files), new Set([profile, join(directory, "plugin.wish-plugin.json")]));
    const versioned = version => ({ mode: "versioned", schemaVersion: version, readableVersions: version === 1 ? [1] : [version - 1, version] });
    await writeFile(join(directory, "plugin.wish-plugin.json"), JSON.stringify({ ...raw, id: "fixture.plugin", entry: "./plugin.mjs", state: versioned(1) }));
    assert.throws(() => new ManagedProfileSource(profile, "include", state, declared, classifier), { code: "plugin_manifest_state_incompatible" });
    const v1 = new ManagedProfileSource(profile, "include", state, undefined, classifier);
    await writeFile(join(directory, "plugin.wish-plugin.json"), JSON.stringify({ ...raw, id: "fixture.plugin", entry: "./plugin.mjs", state: versioned(2) }));
    const v2 = new ManagedProfileSource(profile, "include", state, v1, classifier);
    assert.equal(v2.managementClasses().get("include:plugin").manifest.state.schemaVersion, 2);
    await writeFile(join(directory, "plugin.wish-plugin.json"), JSON.stringify({ ...raw, id: "fixture.plugin", entry: "./plugin.mjs", state: { mode: "versioned", schemaVersion: 3, readableVersions: [3] } }));
    assert.throws(() => new ManagedProfileSource(profile, "include", state, v2, classifier), { code: "plugin_manifest_state_incompatible" });
    await writeFile(join(directory, "plugin.wish-plugin.json"), JSON.stringify({ ...raw, id: "fixture.plugin", entry: "./plugin.mjs" }));
    await writeFile(profile, JSON.stringify([{ id: "plugin", name: "./plugin.mjs", management: { manifest: "./plugin.wish-plugin.json" }, config: { prefix: 1 } }]));
    assert.throws(() => new ManagedProfileSource(profile, "include", state, undefined, classifier), { code: "plugin_config_invalid" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("manifest-managed Provider and Consumer reconfigure, cascade and reject mismatched replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-external-plugin-"));
  const root = new Context(); let control;
  try {
    await root.plugin(Loader);
    const classifier = new PluginManagementClassifier({ "cordis:profile": "kernel" });
    const inspection = installPluginInspection(root, classifier);
    installPluginLifecycle(root, inspection);
    await root.plugin(Tools);
    const registry = root.tools.registry, register = registry.register.bind(registry); let tool;
    registry.register = definition => { tool = definition; return register(definition); };
    const store = await ManagedPluginStore.open(join(directory, "plugins.json"));
    control = new ManagedPluginControl(root, inspection, store);
    const filename = join(directory, "cordis.json");
    await writeFile(filename, JSON.stringify(entries()));
    const source = new ManagedProfileSource(filename, "include", store.snapshot(), undefined, classifier);
    root.loader.builtins.profile = managedProfilePlugin(source, profile => control.attach(profile), classifier);
    await root.loader.create({ id: "include", name: "cordis:profile" }); await root.loader.await();
    control.setRecoveryAvailable(true);
    const before = control.snapshot();
    const providerView = before.inspection.entries.find(item => item.id === "include:provider");
    assert.equal(providerView.managementClass, "managed");
    assert.equal(providerView.manifest.id, "example.greeting-provider");
    assert.deepEqual(before.protocols.filter(item => item.entryId === "include:provider" || item.entryId === "include:tool"), [
      { entryId: "include:provider", conformance: "online", stop: "online", codeUpdate: "online" },
      { entryId: "include:tool", conformance: "online", stop: "online", codeUpdate: "online" },
    ]);
    assert.deepEqual(before.controls["include:provider"], {
      managementClass: "managed", canEnable: false, canDisable: true, canReplace: true,
    });
    const first = tool, service = root.get("exampleGreeting");
    assert.equal(await tool.execute({ text: "Wish" }, {}, {}), "Hello, Wish");
    const change = preference => {
      const snapshot = control.snapshot();
      return control.change({ requestId: randomUUID(), revision: snapshot.revision, preference,
        selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:provider"] } });
    };
    assert.equal((await change("disabled")).status, "succeeded");
    assert.equal(registry.has("example_greet"), false);
    await assert.rejects(first.execute({ text: "old" }, {}, {}), /closed/);
    await assert.rejects(service.greet("old"), /closed/);
    assert.equal(control.snapshot().controls["include:provider"].canEnable, true);
    assert.equal((await change("enabled")).status, "succeeded");
    assert.equal(await tool.execute({ text: "Wish" }, {}, {}), "Hello, Wish");
    assert.equal(registry.list().filter(item => item.name === "example_greet").length, 1);
    assert.notEqual(tool, first);

    await writeFile(filename, JSON.stringify(entries("Welcome")));
    await control.reloadConfiguration();
    assert.equal(await tool.execute({ text: "Wish" }, {}, {}), "Welcome, Wish");
    assert.equal(registry.list().filter(item => item.name === "example_greet").length, 1);

    const managedToolUrl = new URL("../dist/tools/managed.js", import.meta.url).href;
    await writeFile(join(directory, "capability.mjs"), `import { ManagedToolOwner } from ${JSON.stringify(managedToolUrl)};
export const inject = ['tools'];
export function apply(ctx) {
  const owner = new ManagedToolOwner(ctx, { code: 'capability_fixture', codeReload: true });
  owner.register({ name: 'manifest_capability_fixture', description: 'fixture', inputSchemaJson: '{"type":"object","properties":{},"additionalProperties":false}', executionMode: 'parallel',
    parse: () => ({ ok: true, input: {} }), resolveCapabilities: () => ({ requirements: [{ capability: 'network.connect', hosts: ['example.com'] }] }), execute: () => 'ok' });
}\n`);
    const baseManifest = JSON.parse(await readFile(providerManifest, "utf8"));
    await writeFile(join(directory, "capability.wish-plugin.json"), JSON.stringify({ ...baseManifest, id: "fixture.capability", displayName: "Capability", entry: "./capability.mjs",
      configSchema: { type: "object", properties: {}, additionalProperties: false } }));
    const capabilityEntry = { id: "capability", name: "./capability.mjs", management: { manifest: "./capability.wish-plugin.json" } };
    await writeFile(filename, JSON.stringify([...entries("Welcome"), capabilityEntry]));
    await control.reloadConfiguration();
    const call = registry.parseCall({ id: "fixture-call", name: "manifest_capability_fixture", argumentsJson: "{}" });
    assert.equal(call.ok, true);
    await assert.rejects(registry.resolveCapabilities(call.call, {}), /plugin_manifest_capability_undeclared/u);

    const ownerUrl = new URL("../dist/boot/plugin-control/work-owner.js", import.meta.url).href;
    await writeFile(join(directory, "mismatch.mjs"), `import { PluginWorkOwner } from ${JSON.stringify(ownerUrl)};\nexport function apply(ctx) { new PluginWorkOwner(ctx, { code: 'mismatch', codeReload: true }); }\n`);
    await writeFile(join(directory, "mismatch.wish-plugin.json"), JSON.stringify({ ...baseManifest, id: "fixture.mismatch", displayName: "Mismatch", entry: "./mismatch.mjs", replacement: "generation",
      configSchema: { type: "object", properties: {}, additionalProperties: false } }));
    await writeFile(filename, JSON.stringify([...entries("Welcome"), capabilityEntry, { id: "mismatch", name: "./mismatch.mjs", management: { manifest: "./mismatch.wish-plugin.json" } }]));
    await assert.rejects(control.reloadConfiguration(), { code: "management_configuration_rolled_back" });
    assert.equal(control.snapshot().inspection.entries.some(item => item.id === "include:mismatch"), false);
  } finally {
    await control?.close(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
