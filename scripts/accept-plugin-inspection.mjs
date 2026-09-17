import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { setImmediate as nextTick } from "node:timers/promises";
import Group from "@deepseek-ai/cordis-plugin-group";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader from "@deepseek-ai/cordis-plugin-loader";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";

const modules = {
  "provider.mjs": `export function apply(ctx, config) {
    ctx.provide("inspectionSource", Object.freeze({ value: config.value }));
  }`,
  "consumer.mjs": `export const inject = ["inspectionSource"];
  export function apply(ctx) {
    ctx.provide("inspectionResult", ctx.inspectionSource.value);
  }`,
  "nested.mjs": `export function apply(ctx) {
    ctx.inject(["inspectionSource"], scope => {
      scope.provide("inspectionResult", scope.inspectionSource.value);
    });
  }`,
  "leaf.mjs": `export const inject = ["inspectionResult"];
  export function apply(ctx) { ctx.provide("inspectionLeaf", ctx.inspectionResult); }`,
  "noop.mjs": "export function apply() {}",
  "failure.mjs": "export function apply() { throw new Error('private-activation-error'); }",
  "closing.mjs": `export const inject = ["inspectionSource"];
  export function apply(ctx) {
    const close = ctx.get("inspectionClose");
    ctx.effect(() => close);
  }`,
};

const chain = `- id: provider
  name: ./provider.mjs
  config: { value: first, privateCredential: do-not-expose-config }
- id: consumer
  name: ./consumer.mjs
- id: leaf
  name: ./leaf.mjs
- id: dormant
  name: ./noop.mjs
  disabled: true
`;

async function fixture(profile, run, prepare) {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-inspection-"));
  const root = new Context();
  let inspection;
  try {
    root.baseUrl = pathToFileURL(directory).href + "/";
    for (const [name, source] of Object.entries(modules)) {
      await writeFile(join(directory, name), source);
    }
    await writeFile(join(directory, "cordis.yml"), profile);
    await root.plugin(Loader);
    root.loader.builtins.include = Include;
    root.loader.builtins.group = Group;
    inspection = installPluginInspection(root);
    await prepare?.(root);
    await root.loader.create({ id: "include", name: "cordis:include", config: { path: "./cordis.yml" } });
    await root.loader.await();
    await run({ root, inspection, directory, entry: id => root.loader.resolve(`include:${id}`) });
  } finally {
    await root.fiber.dispose();
    if (inspection !== undefined) assert.throws(() => inspection.inspect(), /closed/);
    await rm(directory, { recursive: true, force: true });
  }
}

const row = (snapshot, id) => {
  const entry = snapshot.entries.find(item => item.id === `include:${id}`);
  assert.ok(entry, `missing ${id}`);
  return entry;
};
const affectedEntries = impact => [...new Set(impact.affected.map(({ fiberId }) =>
  impact.snapshot.fibers.find(fiber => fiber.id === fiberId)?.entryId))].sort();

test("inspection returns immutable config-free Loader facts and Root infrastructure", async () => {
  await fixture(chain, async ({ root, inspection }) => {
    const snapshot = inspection.inspect();
    assert.equal(row(snapshot, "provider").phase, "active");
    assert.equal(row(snapshot, "consumer").gate, "default");
    assert.equal(row(snapshot, "dormant").enabled, false);
    assert.equal(row(snapshot, "dormant").phase, "absent");
    assert.equal(row(snapshot, "provider").parentId, "include");
    assert.ok(snapshot.fibers.some(fiber => fiber.entryId === null && fiber.id !== 0));
    assert.doesNotMatch(JSON.stringify(snapshot), /do-not-expose-config|privateCredential|"config"|"ctx"/);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    assert.throws(() => snapshot.entries.push({}), TypeError);
    assert.throws(() => { snapshot.entries[0].enabled = false; }, TypeError);
    assert.throws(() => snapshot.fibers[0].dependencies.push({}), TypeError);
    assert.throws(() => installPluginInspection(root), /already installed/);
    assert.throws(() => inspection.previewDisable("provider"), /Unknown plugin entry/);
    assert.throws(() => inspection.previewDisable("include:unknown"), /Unknown plugin entry/);
  });
});

test("dependency preview is non-mutating and does not pretend to approve a shutdown", async () => {
  await fixture(chain, async ({ root, directory, inspection }) => {
    const before = inspection.inspect();
    const config = await readFile(join(directory, "cordis.yml"), "utf8");
    const impact = inspection.previewDisable("include:provider");
    assert.equal(impact.coverage, "observed-fibers");
    assert.equal(impact.safety, "not-assessed");
    assert.deepEqual(affectedEntries(impact), ["include:consumer", "include:leaf", "include:provider"]);
    assert.deepEqual(inspection.inspect(), before);
    assert.equal(root.get("inspectionLeaf"), "first");
    assert.equal(await readFile(join(directory, "cordis.yml"), "utf8"), config);
    assert.throws(() => { impact.affected[0].cause.kind = "changed"; }, TypeError);
    assert.equal("disable" in inspection, false);
    assert.equal("update" in inspection, false);
  });
});

test("disabled Provider and enabled-but-pending Consumers remain distinct, then reactivate", async () => {
  await fixture(chain, async ({ root, inspection, entry }) => {
    const before = inspection.inspect();
    await entry("provider").update({ disabled: true });
    await root.loader.await();
    const stopped = inspection.inspect();
    assert.equal(row(stopped, "provider").gate, "disabled");
    assert.equal(row(stopped, "provider").phase, "absent");
    assert.equal(row(stopped, "consumer").enabled, true);
    assert.equal(row(stopped, "consumer").phase, "pending");
    assert.equal(row(stopped, "leaf").phase, "pending");
    assert.equal(root.get("inspectionResult"), undefined);
    assert.equal(root.get("inspectionLeaf"), undefined);
    const consumer = stopped.fibers.find(fiber => fiber.id === row(stopped, "consumer").fiberId);
    assert.deepEqual(consumer.dependencies, [{ service: "inspectionSource", providerFiberId: null, binding: "unobserved" }]);
    await entry("provider").update({ disabled: false, config: { value: "second" } });
    await root.loader.await();
    const restored = inspection.inspect();
    assert.equal(restored.instanceId, before.instanceId);
    assert.notEqual(row(restored, "provider").fiberId, row(before, "provider").fiberId);
    assert.equal(row(restored, "consumer").phase, "active");
    assert.equal(root.get("inspectionLeaf"), "second");
    assert.equal(row(before, "provider").phase, "active");
  });
});

test("nested injection loss affects its child fiber without marking the whole plugin stopped", async () => {
  await fixture(chain.replace("./consumer.mjs", "./nested.mjs"), async ({ root, inspection, entry }) => {
    const impact = inspection.previewDisable("include:provider");
    const consumer = row(impact.snapshot, "consumer");
    assert.equal(impact.affected.some(item => item.fiberId === consumer.fiberId), false);
    const nested = impact.snapshot.fibers.find(fiber => fiber.entryId === consumer.id &&
      !fiber.entryRoot && fiber.dependencies.some(item => item.service === "inspectionSource"));
    assert.ok(nested);
    assert.equal(impact.affected.some(item => item.fiberId === nested.id), true);
    assert.equal(impact.affected.some(item => item.fiberId === row(impact.snapshot, "leaf").fiberId), true);
    await entry("provider").update({ disabled: true });
    await root.loader.await();
    assert.equal(row(inspection.inspect(), "consumer").phase, "active");
    assert.equal(row(inspection.inspect(), "leaf").phase, "pending");
  });
});

test("same-named services in separate isolation realms have different dependency edges", async () => {
  const group = name => `- id: ${name}
  name: cordis:group
  group: true
  isolate: { inspectionSource: true, inspectionResult: true }
  config:
    - id: ${name}-provider
      name: ./provider.mjs
      config: { value: ${name} }
    - id: ${name}-consumer
      name: ./consumer.mjs
`;
  await fixture(group("alpha") + group("beta"), async ({ root, inspection, entry }) => {
    assert.deepEqual(affectedEntries(inspection.previewDisable("include:alpha-provider")), ["include:alpha-consumer", "include:alpha-provider"]);
    const impact = inspection.previewDisable("include:alpha");
    assert.deepEqual(affectedEntries(impact), ["include:alpha-consumer", "include:alpha-provider"]);
    assert.equal(row(impact.snapshot, "alpha-provider").parentId, "include:alpha");
    await entry("alpha").update({ disabled: true });
    await root.loader.await();
    const stopped = inspection.inspect();
    assert.equal(row(stopped, "alpha").gate, "disabled");
    assert.equal(row(stopped, "alpha").phase, "active");
    assert.equal(row(stopped, "alpha-provider").enabled, false);
    assert.equal(row(stopped, "alpha-consumer").phase, "absent");
    assert.equal(row(stopped, "beta-consumer").phase, "active");
    await entry("alpha").update({ disabled: false });
    await root.loader.await();
    assert.equal(row(inspection.inspect(), "alpha-consumer").phase, "active");
  });
});

test("conditional evaluation failure is unknown, with no expression or error disclosure", async () => {
  let fail = false;
  await fixture(`- id: conditional
  name: ./noop.mjs
  disabled: !!js ctx.get('inspectionGate')()
`, async ({ inspection }) => {
    assert.equal(row(inspection.inspect(), "conditional").gate, "conditional");
    assert.equal(row(inspection.inspect(), "conditional").enabled, true);
    fail = true;
    const snapshot = inspection.inspect();
    assert.equal(row(snapshot, "conditional").enabled, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-error-token|ctx.get|inspectionGate/);
  }, root => root.provide("inspectionGate", () => {
    if (fail) throw new Error("private-error-token");
    return false;
  }));
});

test("pending and failed fibers are observable without reading config or raw errors", async () => {
  await fixture(`- id: pending
  name: ./noop.mjs
  inject: [neverProvided]
- id: broken
  name: ./failure.mjs
  inject: [triggerFailure]
`, async ({ root, inspection }) => {
    assert.equal(row(inspection.inspect(), "pending").phase, "pending");
    root.provide("triggerFailure", true);
    await assert.rejects(root.loader.await(), /private-activation-error/);
    const snapshot = inspection.inspect();
    assert.equal(row(snapshot, "broken").phase, "failed");
    assert.doesNotMatch(JSON.stringify(snapshot), /private-activation-error/);
  });
});

test("a rolled-back failed creation is absent, not a fabricated failed inventory row", async () => {
  await fixture("[]", async ({ root, inspection }) => {
    await assert.rejects(root.loader.create({ id: "rejected", name: "./failure.mjs" }), /private-activation-error/);
    assert.equal(inspection.inspect().entries.some(entry => entry.id === "rejected"), false);
  });
});

test("in-flight consumer cleanup remains unloading rather than a completed stop", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await fixture(chain.replace("./consumer.mjs", "./closing.mjs"), async ({ root, inspection, entry }) => {
    let update;
    try {
      update = entry("provider").update({ disabled: true });
      await nextTick();
      const snapshot = inspection.inspect();
      assert.equal(row(snapshot, "provider").phase, "absent");
      assert.equal(row(snapshot, "consumer").phase, "unloading");
      assert.equal(inspection.previewDisable("include:provider").safety, "not-assessed");
    } finally {
      release();
      await update;
    }
    await root.loader.await();
    assert.equal(row(inspection.inspect(), "consumer").phase, "pending");
  }, root => root.provide("inspectionClose", () => held));
});

test("bootstrap exposes inspection while a real Skills Provider is stopped and restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-inspection-boot-"));
  let app;
  try {
    const skillsRoot = join(directory, "skills");
    await mkdir(join(skillsRoot, "inspect"), { recursive: true });
    await writeFile(join(skillsRoot, "inspect", "SKILL.md"), "---\nname: inspect\ndescription: Inspect first\n---\nRead the source.\n");
    await writeFile(join(directory, "surface.mjs"), "export function apply() {}\n");
    await writeFile(join(directory, "cordis.yml"), `- id: skills-local
  name: cordis:skills-local
  config: { userRoot: ${JSON.stringify(skillsRoot)} }
- id: tools
  name: cordis:tools
- id: skills-tools
  name: cordis:skills-tools
- id: cli
  name: ./surface.mjs
`);
    app = await bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, environment: {}, configurationFile: "cordis.yml" });
    const snapshot = app.plugins.inspect();
    assert.deepEqual(app.context.pluginInspection.inspect(), snapshot);
    const registry = app.context.get("tools").registry;
    assert.equal(registry.has("read_skill"), true);
    assert.deepEqual(affectedEntries(app.plugins.previewDisable("include:skills-tools")), ["include:skills-tools"]);
    await app.context.loader.resolve("include:skills-tools").update({ disabled: true });
    await app.context.loader.await();
    assert.equal(registry.has("read_skill"), false);
    assert.equal(row(app.plugins.inspect(), "skills-local").phase, "active");
    await app.context.loader.resolve("include:skills-tools").update({ disabled: false });
    await app.context.loader.await();
    assert.equal((await app.surfaceContext.get("skills").list({ cwd: directory })).skills.length, 1);
    await app.context.loader.resolve("include:skills-local").update({ disabled: true });
    await app.context.loader.await();
    assert.equal(app.surfaceContext.get("skills"), undefined);
    assert.equal(registry.has("read_skill"), false);
    assert.equal(row(app.plugins.inspect(), "skills-tools").phase, "pending");
    assert.equal(row(app.plugins.inspect(), "skills-local").enabled, false);
    await app.context.loader.resolve("include:skills-local").update({ disabled: false });
    await app.context.loader.await();
    assert.equal(registry.has("read_skill"), true);
    assert.equal((await app.surfaceContext.get("skills").list({ cwd: directory })).skills.length, 1);
    await app.dispose();
    assert.throws(() => app.plugins.inspect(), /closed/);
    app = await bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, environment: {}, configurationFile: "cordis.yml" });
    assert.notEqual(app.plugins.inspect().instanceId, snapshot.instanceId);
  } finally {
    await app?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real Storage Provider retires with a lease while Root inspection stays available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-inspection-storage-"));
  let app;
  let lease;
  let stopping;
  try {
    await writeFile(join(directory, "surface.mjs"), "export function apply() {}\n");
    await writeFile(join(directory, "cordis.yml"), `- id: storage
  name: cordis:storage
- id: storage-file
  name: cordis:storage-file
  config: { rootDirectory: ./data }
- id: cli
  name: ./surface.mjs
`);
    app = await bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, environment: {}, configurationFile: "cordis.yml" });
    const storage = app.context.get("storage");
    const entry = app.context.loader.resolve("include:storage-file");
    lease = storage.acquire("file");
    await lease.resolve("file", "kv").put({ namespace: "inspection", key: "retained", value: new TextEncoder().encode("kept"), precondition: { kind: "absent" } });
    assert.deepEqual(affectedEntries(app.plugins.previewDisable(entry.id)), [entry.id]);
    let settled = false;
    stopping = entry.update({ disabled: true }).then(() => { settled = true; });
    await nextTick();
    assert.equal(storage.has("file"), false);
    assert.throws(() => storage.acquire("file"), { code: "storage_backend_not_found" });
    assert.equal(settled, false);
    assert.equal(row(app.plugins.inspect(), "storage-file").enabled, false);
    assert.equal(app.plugins.previewDisable(entry.id).safety, "not-assessed");
    lease.release();
    await stopping;
    await entry.update({ disabled: false });
    await app.context.loader.await();
    const restored = await storage.resolve("file", "kv").get({ namespace: "inspection", key: "retained" });
    assert.equal(new TextDecoder().decode(restored.value), "kept");
  } finally {
    lease?.release();
    await stopping;
    await app?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection protocol is browser-safe and its Host adapter imports no feature implementation", async () => {
  const types = await readFile(new URL("../src/boot/plugin-control/types.ts", import.meta.url), "utf8");
  const adapter = await readFile(new URL("../src/boot/plugin-control/inspection.ts", import.meta.url), "utf8");
  assert.doesNotMatch(types, /^import\s/m);
  assert.doesNotMatch(adapter, /from ["'][^"']*(?:apps|tools|skills|memory|workflow|subagents|storage|plan|composition)\//u);
});
