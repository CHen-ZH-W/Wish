import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

for (const [flag, enabled] of [[undefined, true], ["0", false], ["1", true], ["false", false]]) {
  test(`default WebUI profile code HMR: ${flag ?? "unset"} => ${enabled}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "wish-managed-hmr-default-"));
    let booted, fiber;
    try {
      booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
        environment: { WISH_DATA_DIR: join(directory, "data"), ...(flag === undefined ? {} : { CORDIS_HMR: flag }) },
        management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
      const entry = booted.context.loader.resolve("include:hmr"); fiber = entry.fiber;
      assert.equal(entry.disabled, !enabled);
      assert.equal(!!booted.context.get("hmr"), enabled);
      if (enabled) { assert.equal(fiber.state, 2); assert.equal(booted.context.get("hmr").config.watchConfig, false); }
      const base = booted.context.get("webManagementHost").url;
      const snapshot = await (await fetch(base + "/api/management/plugins")).json();
      const hmr = snapshot.inspection.entries.find(item => item.id === "include:hmr");
      assert.equal(hmr.enabled, enabled);
      assert.equal(hmr.managementClass, "kernel");
      assert.equal(snapshot.inspection.entries.find(item => item.id === "include:timer").managementClass, "kernel");
      await assert.rejects(booted.pluginManagement.change({ requestId: `kernel-${flag ?? "unset"}`, revision: snapshot.revision,
        preference: enabled ? "disabled" : "enabled", selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:hmr"] } }),
      { code: "management_target_read_only" });
      assert.equal(booted.context.loader.resolve("include:hmr").disabled, !enabled);
      assert.equal(snapshot.configuration.watching, true, "turning off code HMR does not turn off controlled config watch");
      assert.equal((await fetch(base + "/")).status, 200);
    } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
    if (enabled) { assert.equal(fiber.state, 4); assert.deepEqual(fiber.getEffects(), []); }
  });
}

test("default CLI profile does not start a code watcher without explicit opt-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cli-hmr-default-"));
  let booted;
  try {
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data") } });
    assert.equal(await booted.completion, 0);
    assert.equal(booted.context.loader.resolve("include:hmr").disabled, true);
    assert.equal(booted.context.get("hmr"), undefined);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("managed bootstrap keeps Root management and static resources through business disable, restart and restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-boot-"));
  const workOwner = new URL("../dist/boot/plugin-control/work-owner.js", import.meta.url).href;
  const profile = "- id: application\n  name: ./application.mjs\n  management:\n    manifest: ./application.wish-plugin.json\n- id: webui\n  name: ./surface.mjs\n  management:\n    manifest: ./surface.wish-plugin.json\n";
  const manifest = (id, entry) => JSON.stringify({ apiVersion: "wish.plugin/v1", id, entry, managementClass: "managed", replacement: "drain",
    configSchema: { type: "object", properties: {}, additionalProperties: false }, permissions: { capabilities: [] },
    sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" }, state: { mode: "stateless" } });
  let booted;
  const boot = () => bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory, environment: {}, configurationFile: join(directory, "cordis.yml"), management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
  try {
    await writeFile(join(directory, "application.mjs"), `import { PluginWorkOwner } from ${JSON.stringify(workOwner)};
export function apply(ctx) { new PluginWorkOwner(ctx,{code:'demo_application',codeReload:true}); ctx.provide('demoBusiness', {}); }\n`);
    await writeFile(join(directory, "surface.mjs"), `import { PluginWorkOwner } from ${JSON.stringify(workOwner)};
export const inject = ['demoBusiness','webManagementHost'];
export function apply(ctx) {
 const registration = ctx.webManagementHost.register(async(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"business":true}');});
 const close = async()=>registration.release();
 new PluginWorkOwner(ctx,{code:'demo_surface',codeReload:true,close});
}\n`);
    await writeFile(join(directory, "application.wish-plugin.json"), manifest("demo.application", "./application.mjs"));
    await writeFile(join(directory, "surface.wish-plugin.json"), manifest("demo.surface", "./surface.mjs"));
    await writeFile(join(directory, "cordis.yml"), profile);
    booted = await boot();
    const original = booted.pluginManagement.snapshot().inspection.instanceId;
    const url = booted.context.webManagementHost.url;
    assert.equal((await fetch(url + "/api/demo")).status, 200);
    const snapshot = booted.pluginManagement.snapshot();
    const result = await booted.pluginManagement.change({ requestId: "disable-app", revision: snapshot.revision, preference: "disabled", selection: { instanceId: original, entryIds: ["include:application"] } });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal((await fetch(url + "/api/demo")).status, 503);
    assert.equal((await fetch(url + "/api/management/plugins")).status, 200);
    assert.equal((await fetch(url + "/")).status, 200);
    assert.equal(await readFile(join(directory, "cordis.yml"), "utf8"), profile);
    await booted.dispose(); booted = await boot();
    const restored = booted.pluginManagement.snapshot();
    assert.notEqual(restored.inspection.instanceId, original);
    assert.equal(restored.preferences["include:application"].preference, "disabled");
    const resumedUrl = booted.context.webManagementHost.url;
    assert.equal((await fetch(resumedUrl + "/api/demo")).status, 503);
    assert.equal((await fetch(resumedUrl + "/api/management/settings")).status, 200);
    const enabled = await booted.pluginManagement.change({ requestId: "enable-app", revision: restored.revision, preference: "enabled", selection: { instanceId: restored.inspection.instanceId, entryIds: ["include:application"] } });
    assert.equal(enabled.status, "succeeded");
    assert.equal((await fetch(resumedUrl + "/api/demo")).status, 200);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
