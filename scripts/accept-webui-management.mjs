import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { PluginManagementClassifier } from "../dist/boot/plugin-control/classification.js";
import { installPluginLifecycle } from "../dist/boot/plugin-control/lifecycle.js";
import { registerPluginOwner } from "../dist/boot/plugin-control/owner-registry.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";
import { ManagedProfileSource, managedProfilePlugin } from "../dist/boot/plugin-control/managed-profile.js";
import { ManagedPluginControl } from "../dist/boot/plugin-control/managed-control.js";
import { Settings } from "../dist/settings/settings.js";
import { FileSettingsStore } from "../dist/settings/providers/file.js";
import { Credentials } from "../dist/credentials/credentials.js";
import { FileCredentialStore } from "../dist/credentials/providers/file.js";
import { startWebManagementHost } from "../dist/apps/webui/host/management.js";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-management-http-")), root = new Context();
  let host, settings, credentials, control;
  try {
    await root.plugin(Loader);
    const classifications = new PluginManagementClassifier({ "cordis:profile": "kernel", "cordis:sample": "managed" });
    const inspection = installPluginInspection(root, classifications), lifecycle = installPluginLifecycle(root, inspection);
    const store = await ManagedPluginStore.open(join(directory, "managed.json"));
    control = new ManagedPluginControl(root, inspection, store);
    settings = new Settings(await FileSettingsStore.open(join(directory, "settings.json")));
    credentials = new Credentials(await FileCredentialStore.open(join(directory, "credentials.json")), {});
    const scope = settings.register({ namespace: "composer", title: "消息输入", applies: "next-request", fields: [
      { key: "delivery", label: "运行中发送", type: "enum", options: ["queue", "steer"], default: "queue" },
    ] });
    await writeFile(join(directory, "cordis.yml"), '- id: sample\n  name: cordis:sample\n  management:\n    class: managed\n');
    root.loader.builtins.sample = { apply(ctx) { registerPluginOwner(ctx, { status: () => ({ disposition: "direct", code: "idle" }), replacement: "drain",
      prepare: () => ({ drained: Promise.resolve(), deactivate: async () => {}, release() {} }) }); } };
    root.loader.builtins.profile = managedProfilePlugin(new ManagedProfileSource(join(directory, "cordis.yml"), "include", store.snapshot(), undefined, classifications), profile => control.attach(profile), classifications);
    await root.loader.create({ id: "include", name: "cordis:profile" }); await root.loader.await();
    host = await startWebManagementHost({ root, control, settings, credentials, lifecycle, port: 0 });
    const fetchJson = async (path, options) => { const response = await fetch(host.url + path, options); return { status: response.status, value: await response.json() }; };
    const { value: bootstrap } = await fetchJson("/api/management/bootstrap");
    const post = (path, value, headers = {}) => fetchJson(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Wish-Management-Token": bootstrap.token, ...headers }, body: JSON.stringify(value) });
    await run({ root, control, settings, credentials, host, scope, fetchJson, post, bootstrap });
  } finally { await host?.close(); await control?.close(); await settings?.close(); await credentials?.close(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
}
test("Root HTTP and SSE survive business detachment; real mutation saves and changes Loader", () => fixture(async f => {
  const registration = f.host.register(async (_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"business":true}'); });
  assert.equal((await f.fetchJson("/api/example")).status, 200);
  registration.release();
  assert.equal((await f.fetchJson("/api/example")).status, 503);
  assert.equal((await f.fetchJson("/api/management/bootstrap")).value.businessAvailable, false);
  const stream = await fetch(f.host.url + "/api/management/events"), reader = stream.body.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: reset/);
    const snapshot = (await f.fetchJson("/api/management/plugins")).value;
    const preview = await f.post("/api/management/plugins/preview", { instanceId: snapshot.inspection.instanceId, entryIds: ["include:sample"] });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.value.impact.gatedEntryIds, ["include:sample"]);
    assert.equal(preview.value.impact.affected.length, 1);
    const result = await f.post("/api/management/plugins/change", { requestId: "http-disable", revision: snapshot.revision,
      selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:sample"] }, preference: "disabled" });
    assert.equal(result.status, 202); assert.equal(result.value.operation.requestId, "http-disable");
    let operation = result.value.operation;
    while (!["succeeded", "rejected", "recovery-required"].includes(operation.phase)) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const queried = await f.fetchJson(`/api/management/plugins/operations/${encodeURIComponent(operation.id)}`);
      assert.equal(queried.status, 200); operation = queried.value.operation;
    }
    assert.equal(operation.phase, "succeeded");
    assert.equal((await f.fetchJson("/api/management/plugins/operations/missing")).status, 404);
    assert.equal(f.root.loader.resolve("include:sample").disabled, true);
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: invalidated/);
    const settings = (await f.fetchJson("/api/management/settings")).value.sections[0];
    const saved = await f.post("/api/management/settings/replace", { namespace: settings.namespace, revision: settings.revision, user: { delivery: "steer" } });
    assert.equal(saved.status, 200); assert.equal(f.scope.get().delivery, "steer");
    assert.equal((await f.post("/api/management/settings/replace", { namespace: settings.namespace, revision: settings.revision, user: {} })).status, 409);
    const missing = await f.post("/api/management/credentials/describe", { references: ["FIXTURE_API_KEY"] });
    assert.deepEqual(missing.value.credentials, [{ reference: "FIXTURE_API_KEY", configured: false, source: "missing", writable: true }]);
    const secret = "management-secret";
    const written = await f.post("/api/management/credentials/set", { reference: "FIXTURE_API_KEY", value: secret });
    assert.equal(written.status, 200); assert.equal(JSON.stringify(written.value).includes(secret), false);
  } finally { await reader.cancel(); }
}));
test("management rejects cross-origin, rebound Host, missing token and arbitrary config operations", () => fixture(async f => {
  assert.equal((await f.fetchJson("/api/management/bootstrap", { headers: { Origin: "https://evil.example" } })).status, 403);
  // fetch normalizes Host; use an actual raw HTTP request for DNS-rebinding evidence.
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.host.url + "/api/management/bootstrap", { headers: { Host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await f.fetchJson("/api/management/bootstrap", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await f.fetchJson("/api/management/settings/replace", { method: "POST", body: "{}" })).status, 403);
  assert.equal((await f.post("/api/management/settings/replace", {}, { "X-Wish-Management-Token": "z".repeat(64) })).status, 403);
  assert.equal((await f.post("/api/management/plugins/change", { eval: "process.exit()" })).status, 400);
  assert.equal((await f.post("/api/management/settings/replace", { namespace: "composer", revision: f.scope.view().revision, user: {}, config: { secret: "not a supported field" } })).status, 400);
  assert.equal((await f.post("/api/management/arbitrary-rpc", {})).status, 404);
  assert.equal(f.root.loader.resolve("include:sample").disabled, false);
}));
