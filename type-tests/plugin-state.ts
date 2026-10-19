import type { Context } from "@deepseek-ai/cordis";
import type { PluginStateDefinition, PluginStateHandle, PluginStateSnapshot } from "../src/plugin-state/index.js";

declare const ctx: Context;
declare const saved: PluginStateSnapshot;
declare const handle: PluginStateHandle;
// @ts-expect-error snapshots preserve immutable artifact identity
saved.writer.artifactDigest = "changed";
// @ts-expect-error state is immutable JSON at the contract boundary
saved.value = undefined;
const definition: PluginStateDefinition = {
  identity: { pluginId: "fixture", pluginVersion: "2.0.0", schemaVersion: 2 }, readableVersions: [2], migratableVersions: [1],
  validate(value) { if (typeof value !== "number") throw Error("invalid state"); },
  snapshot: () => 1, restore: () => {}, migrate: input => input.value,
};
const opened: Promise<PluginStateHandle> = ctx.root.pluginState.open(ctx, definition);
const result: Promise<number> = handle.run(() => 7);
const checkpoint: Promise<PluginStateSnapshot> = handle.flush();
void [opened, result, checkpoint];
