import { Context } from "@deepseek-ai/cordis";
import { PluginStateRegistry, FilePluginStatePersistence } from "../../dist/plugin-state/index.js";
const registry = new PluginStateRegistry(() => FilePluginStatePersistence.open(process.argv[2]));
const root = new Context();
const definition = (version, state) => ({ identity: { pluginId: "counter", pluginVersion: String(version), artifactDigest: String(version).repeat(64), schemaVersion: version },
  readableVersions: [version], ...(version === 2 ? { migratableVersions: [1], migrate: saved => ({ total: saved.value }) } : {}),
  validate() {}, snapshot: () => state.value, restore: saved => { state.value = saved.value; } });
const first = { value: 13 }, a = await root.plugin({ name: "old", apply() {} });
const old = await registry.open(a.ctx, definition(1, first), "slot");
await registry.begin("crashed-upgrade", ["slot"]); await old.close();
const next = { value: {} }, b = await root.plugin({ name: "next", apply() {} });
await registry.open(b.ctx, definition(2, next), "slot");
process.send("staged"); setInterval(() => {}, 1000);
