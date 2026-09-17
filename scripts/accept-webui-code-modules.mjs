import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { UiModuleLoader } from "../dist/apps/webui/client/module-loader.js";
import { parseUiModuleManifest } from "../dist/apps/webui/client/module-manifest.js";
import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const core = "/assets/core/client-AAAAAAAA.js";
const entry = (id = "Probe", hash = "AAAAAAAA") => ({ id, url: `/assets/modules/${id}-${hash}.js`, exportName: id, entryIds: [`include:${id}`] });
function fixture(importer) {
  class Probe extends SnapshotStore { update(value) { this.publish(value); } }
  const root = new Context(), slots = new UiSlots();
  const connection = new Probe({ online: true, instanceId: "host" });
  const management = new Probe({ data: { inspection: { instanceId: "host", entries: [] } } });
  root.provide("wishConnection", connection); root.provide("wishManagement", management); root.provide("wishUiSlots", slots);
  let manifest = { schemaVersion: 1, core, modules: [entry()] }, reads = 0;
  const loader = new UiModuleLoader(root, core, { pollMs: 100000, importer, fetcher: async () => { reads++; return new Response(JSON.stringify(manifest)); } });
  const enabled = (ids = ["Probe"], instanceId = "host") => management.update({ data: { inspection: { instanceId, entries: ids.map(id => ({ id: `include:${id}`, enabled: true, phase: "active" })) } } });
  const update = async value => { manifest = value; await loader.refresh(); await settle(); };
  loader.start();
  return { root, slots, connection, management, loader, enabled, update, reads: () => reads, async close() { await loader.close(); await root.fiber.dispose(); } };
}
function plugin(label, hooks = {}) {
  return { name: `ui-${label}`, inject: ["wishUiSlots"], apply(ctx) {
    hooks.open?.();
    ctx.effect(() => ctx.wishUiSlots.panel({ id: "probe", label, area: "workspace", View() {} }));
    ctx.effect(() => () => hooks.close?.());
    hooks.applied?.();
  } };
}

test("UI manifests reject remote URLs, traversal, duplicate IDs and empty authority gates", () => {
  const valid = { schemaVersion: 1, core, modules: [entry()] };
  assert.equal(Object.isFrozen(parseUiModuleManifest(valid).modules[0].entryIds), true);
  for (const url of ["https://evil.test/module.js", "//evil.test/a", "/assets/modules/../core/client-AAAAAAAA.js", "/assets/modules/X-AAAAAAAA.js?run=1"]) {
    assert.throws(() => parseUiModuleManifest({ ...valid, modules: [{ ...entry(), url }] }), /invalid_ui_manifest/);
  }
  assert.throws(() => parseUiModuleManifest({ ...valid, modules: [entry(), entry()] }));
  assert.throws(() => parseUiModuleManifest({ ...valid, modules: [{ ...entry(), entryIds: [] }] }));
});

test("UI replacement publishes one complete slot snapshot and keeps unrelated seats", async () => {
  let opened = 0, closed = 0;
  const f = fixture(async url => ({ Probe: plugin(url.includes("BBBBBBBB") ? "new" : "old", { open() { opened++; }, close() { closed++; } }) }));
  const stable = { id: "stable", label: "Stable", area: "settings", View() {} };
  f.slots.panel(stable);
  try {
    f.enabled(); await settle(); assert.equal(opened, 1);
    const stableSeat = f.slots.getSnapshot().panels.find(item => item.id === "stable"), snapshots = [];
    const stop = f.slots.subscribe(() => snapshots.push(f.slots.getSnapshot()));
    await f.update({ schemaVersion: 1, core, modules: [entry("Probe", "BBBBBBBB")] });
    stop(); assert.equal(opened, 2); assert.equal(closed, 1);
    assert.equal(snapshots.length, 1); assert.equal(snapshots[0].panels.find(item => item.id === "probe").label, "new");
    assert.equal(snapshots[0].panels.find(item => item.id === "stable"), stableSeat);
  } finally { await f.close(); }
  assert.equal(closed, 2);
});

test("a disabled Host capability removes old seats without waiting for a late module download", async () => {
  const download = deferred(); let imports = 0, newApplies = 0;
  const f = fixture(async url => { imports++; return url.includes("BBBBBBBB") ? download.promise : { Probe: plugin("old") }; });
  try {
    await settle(); assert.equal(imports, 0, "disabled modules are not imported");
    f.enabled(); await settle(); assert.equal(imports, 1);
    await f.update({ schemaVersion: 1, core, modules: [entry("Probe", "BBBBBBBB")] });
    f.enabled([]); await settle(); assert.equal(f.slots.getSnapshot().panels.length, 0);
    download.resolve({ Probe: plugin("new", { open() { newApplies++; } }) }); await settle();
    assert.equal(newApplies, 0); assert.equal(f.slots.getSnapshot().panels.length, 0);
    f.enabled(); await settle(); assert.equal(newApplies, 1);
  } finally { await f.close(); }
});

test("failed import and failed activation retain valid old presentation; fixed code replaces it", async () => {
  const f = fixture(async url => {
    if (url.includes("BBBBBBBB")) throw Error("bad download");
    if (url.includes("CCCCCCCC")) return { Probe: plugin("bad", { applied() { throw Error("bad apply"); } }) };
    return { Probe: plugin(url.includes("DDDDDDDD") ? "fixed" : "old") };
  });
  try {
    f.enabled(); await settle();
    for (const hash of ["BBBBBBBB", "CCCCCCCC"]) {
      await f.update({ schemaVersion: 1, core, modules: [entry("Probe", hash)] });
      assert.equal(f.slots.getSnapshot().panels[0].label, "old"); assert.equal(f.loader.getSnapshot().errors.length, 1);
    }
    await f.update({ schemaVersion: 1, core, modules: [entry("Probe", "DDDDDDDD")] });
    assert.equal(f.slots.getSnapshot().panels[0].label, "fixed"); assert.equal(f.loader.getSnapshot().errors.length, 0);
  } finally { await f.close(); }
});

test("core change asks for refresh without mixing runtimes; Host revocation still applies", async () => {
  let imports = 0;
  const f = fixture(async () => { imports++; return { Probe: plugin("old") }; });
  try {
    f.enabled(); await settle();
    await f.update({ schemaVersion: 1, core: "/assets/core/client-ZZZZZZZZ.js", modules: [entry("Probe", "BBBBBBBB")] });
    assert.equal(f.loader.getSnapshot().refreshRequired, true); assert.equal(imports, 1);
    f.enabled([]); await settle(); assert.equal(f.slots.getSnapshot().panels.length, 0);
    f.connection.update({ online: true, instanceId: "other-host" }); f.enabled(); await settle();
    assert.equal(imports, 1, "stale inspection cannot enable a new Host instance");
  } finally { await f.close(); }
});

test("missing Browser dependency fails visibly; manifest removal and close discard late work", async () => {
  const download = deferred();
  const f = fixture(async url => url.includes("BBBBBBBB") ? download.promise : { Probe: { ...plugin("pending"), inject: ["missingService"] } });
  try {
    f.enabled(); await settle(); assert.equal(f.loader.getSnapshot().errors.length, 1);
    await f.update({ schemaVersion: 1, core, modules: [entry("Probe", "BBBBBBBB")] });
    await f.update({ schemaVersion: 1, core, modules: [] });
    download.resolve({ Probe: plugin("late") }); await settle();
    assert.equal(f.slots.getSnapshot().panels.length, 0);
    await f.loader.close(); const reads = f.reads(); await f.loader.refresh(); assert.equal(f.reads(), reads);
  } finally { await f.close(); }
});
