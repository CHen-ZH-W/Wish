import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { installPluginInspection } from "../../dist/boot/plugin-control/inspection.js";
import { PluginManagementClassifier } from "../../dist/boot/plugin-control/classification.js";
import { installPluginLifecycle } from "../../dist/boot/plugin-control/lifecycle.js";
import { registerPluginOwner } from "../../dist/boot/plugin-control/owner-registry.js";
import { PluginWorkOwner } from "../../dist/boot/plugin-control/work-owner.js";
import { ManagedPluginStore } from "../../dist/boot/plugin-control/managed-store.js";
import { ManagedPluginControl } from "../../dist/boot/plugin-control/managed-control.js";
import { ManagedProfileSource, managedProfilePlugin } from "../../dist/boot/plugin-control/managed-profile.js";
const [directory, mode] = process.argv.slice(2);
const root = new Context();
await root.plugin(Loader);
const classifications = new PluginManagementClassifier({ "cordis:profile": "kernel", "cordis:feature": "managed" });
const inspection = installPluginInspection(root, classifications); installPluginLifecycle(root, inspection);
const store = await ManagedPluginStore.open(join(directory, "plugins.json"));
const control = new ManagedPluginControl(root, inspection, store);
let activations = 0;
root.loader.builtins.feature = { async apply(ctx) {
  activations++; await appendFile(join(directory, "effects.log"), "activated\n");
  if (mode === "fencing") {
    let fenced = false;
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: async () => {
        if (fenced) await new Promise(() => {});
        return { disposition: "direct", code: "crash_fixture_idle" };
      },
      prepare: () => {
        fenced = true;
        process.send({ phase: "fencing" });
        return { drained: Promise.resolve(), deactivate: async () => {}, release: () => { fenced = false; } };
      },
    });
  } else {
    new PluginWorkOwner(ctx, { code: "crash_fixture", codeReload: true, close: async () => {
      await appendFile(join(directory, "effects.log"), "cleanup-started\n");
      if (mode === "draining") {
        process.send({ phase: "draining" });
        await new Promise(() => {});
      }
      await appendFile(join(directory, "effects.log"), "cleanup-finished\n");
    } });
  }
} };
root.loader.builtins.profile = managedProfilePlugin(new ManagedProfileSource(join(directory, "cordis.json"), "include", store.snapshot(), undefined, classifications), profile => control.attach(profile), classifications);
await root.loader.create({ id: "include", name: "cordis:profile" }); await root.loader.await();
control.setRecoveryAvailable(true);
if (mode !== "recover") {
  if (mode === "switching") {
    const reserve = control.reserve.bind(control);
    control.reserve = impact => {
      const reservation = reserve(impact);
      return { ...reservation, apply: async () => {
        process.send({ phase: "switching" });
        await new Promise(() => {});
      } };
    };
  }
  const keepAlive = setInterval(() => {}, 1000);
  await control.change({ requestId: "crash-stop", revision: store.snapshot().revision, preference: "disabled",
    selection: { instanceId: inspection.inspect().instanceId, entryIds: ["include:feature"] } });
  clearInterval(keepAlive);
} else {
  const before = control.snapshot();
  const operationBefore = before.operations.find(operation => operation.requestId === "crash-stop");
  await control.recoverDisabled(before.revision);
  process.send({ phase: "recovered", activations, before: before.status, pendingBefore: before.pending.requestId,
    operationBefore: operationBefore?.phase, operationCodeBefore: operationBefore?.code,
    preference: control.snapshot().preferences["include:feature"].preference, code: control.snapshot().lastReceipt.code,
    enabled: inspection.inspect().entries.find(entry => entry.id === "include:feature").enabled });
  await control.close(); await root.fiber.dispose(); process.disconnect();
}
