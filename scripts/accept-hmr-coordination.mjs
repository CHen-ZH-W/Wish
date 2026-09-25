import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";

const deferred = () => Promise.withResolvers();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw Error("HMR observation timed out"); await delay(10); }
}
const source = (version, fails = false) => `export default { async apply(ctx) {
  const p = ctx.get("probe"); p.activated.push(${version});
  ctx.effect(() => async () => { p.disposing.push(${version}); await p.cleanup; p.disposed.push(${version}); });
  ${fails ? 'await Promise.resolve(); throw Error("activation failure");' : ""}
} };`;

async function fixture(run, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-hmr-guard-")), root = new Context();
  const probe = { activated: [], disposing: [], disposed: [], cleanup: undefined }, failures = [], successes = [];
  root.logger.exporter({ export() {} });
  try {
    root.baseUrl = pathToFileURL(directory + "/").href;
    await root.plugin(Loader); await root.plugin(Timer); root.provide("probe", probe);
    const filename = join(directory, "plugin.mjs"); await writeFile(filename, source(1));
    await root.loader.create({ id: "target", name: pathToFileURL(filename).href }); await root.loader.await();
    root.on("hmr/reload-failed", (error, phase) => failures.push({ error, phase }));
    root.on("hmr/reload", batch => successes.push(batch));
    const hmr = await root.plugin(Hmr, { root: ["."], debounce: 20, ...config });
    await run({ root, probe, failures, successes, hmr, async change(version, fails = false) {
      await delay(120); await writeFile(filename, typeof version === "number" ? source(version, fails) : version);
    } });
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test("native middleware runs before disposal and success waits for asynchronous cleanup", { timeout: 8000 }, () => fixture(async f => {
  const prepare = deferred(), proceed = deferred(), cleanup = deferred();
  f.probe.cleanup = cleanup.promise;
  f.root.on("hmr/reload-prepare", async (_batch, _signal, next) => { prepare.resolve(); await proceed.promise; await next(); });
  try {
    await f.change(2); await prepare.promise;
    assert.deepEqual(f.probe.activated, [1]); assert.deepEqual(f.probe.disposing, []);
    proceed.resolve(); await until(() => f.probe.disposing.length);
    assert.deepEqual(f.probe.activated, [1]); assert.equal(f.successes.length, 0);
    cleanup.resolve(); await until(() => f.successes.length);
    assert.deepEqual(f.probe.disposed, [1]); assert.deepEqual(f.probe.activated, [1, 2]);
  } finally { proceed.resolve(); cleanup.resolve(); }
}));

test("edits during a draining batch are queued and not lost or applied concurrently", { timeout: 8000 }, () => fixture(async f => {
  const proceed = deferred(); let preparing = 0, active = 0, maximum = 0;
  f.root.on("hmr/reload-prepare", async (_batch, _signal, next) => {
    preparing++; maximum = Math.max(maximum, ++active);
    try { if (preparing === 1) await proceed.promise; await next(); } finally { active--; }
  });
  try {
    await f.change(2); await until(() => preparing === 1); await f.change(3); await delay(120);
    assert.equal(preparing, 1); proceed.resolve(); await until(() => f.successes.length === 2);
    assert.equal(maximum, 1); assert.deepEqual(f.probe.activated, [1, 2, 3]);
  } finally { proceed.resolve(); }
}));

test("import errors and pre-disposal veto keep the old instance; a later valid edit can recover", { timeout: 8000 }, () => fixture(async f => {
  await f.change("invalid JavaScript @"); await until(() => f.failures.length === 1);
  assert.equal(f.failures[0].phase, "import"); assert.deepEqual(f.probe.disposing, []);
  const veto = f.root.on("hmr/reload-prepare", async () => { throw Error("not safe"); });
  await f.change(2); await until(() => f.failures.length === 2);
  assert.equal(f.failures[1].phase, "prepare"); assert.deepEqual(f.probe.activated, [1]);
  veto(); await f.change(3); await until(() => f.successes.length === 1);
  assert.deepEqual(f.probe.activated, [1, 3]);
}));

test("asynchronous initialization failure restores the old callback and permits a later retry", { timeout: 8000 }, () => fixture(async f => {
  await f.change(2, true); await until(() => f.failures.length === 1);
  assert.equal(f.failures[0].phase, "restored"); assert.equal(f.successes.length, 0);
  assert.deepEqual(f.probe.activated, [1, 2, 1]);
  await f.change(3); await until(() => f.successes.length === 1);
  assert.deepEqual(f.probe.activated, [1, 2, 1, 3]);
}));

test("cleanup deadline is reported and late cleanup cannot activate the replacement", { timeout: 8000 }, () => fixture(async f => {
  const cleanup = deferred(); f.probe.cleanup = cleanup.promise;
  try {
    await f.change(2); await until(() => f.failures.length === 1);
    assert.equal(f.failures[0].phase, "apply"); assert.match(f.failures[0].error.message, /timeout/);
    assert.deepEqual(f.probe.activated, [1]);
    cleanup.resolve(); await until(() => f.probe.disposed.length); await delay(60);
    assert.deepEqual(f.probe.activated, [1]); assert.equal(f.successes.length, 0);
  } finally { cleanup.resolve(); }
}, { reloadTimeout: 60 }));

test("a user disable during preparation is never undone by a stale native batch", { timeout: 8000 }, () => fixture(async f => {
  const proceed = deferred(); let prepared = false;
  f.root.on("hmr/reload-prepare", async (_batch, _signal, next) => { prepared = true; await proceed.promise; await next(); });
  try {
    await f.change(2); await until(() => prepared);
    await f.root.loader.resolve("target").update({ disabled: true }, false, true);
    proceed.resolve(); await until(() => f.failures.length === 1);
    assert.equal(f.failures[0].phase, "prepare"); assert.equal(f.root.loader.resolve("target").disabled, true);
    assert.deepEqual(f.probe.activated, [1]);
  } finally { proceed.resolve(); }
}));

test("outer batch middleware holds module import and cache mutation, not only disposal", { timeout: 8000 }, () => fixture(async f => {
  const release = deferred(); let waiting = false;
  f.root.on("hmr/reload-batch", async (_signal, next) => { waiting = true; await release.promise; await next(); });
  try {
    await f.change("invalid JavaScript @"); await until(() => waiting); await delay(100);
    assert.equal(f.failures.length, 0); assert.deepEqual(f.probe.disposing, []);
    release.resolve(); await until(() => f.failures.length === 1);
    assert.equal(f.failures[0].phase, "import");
  } finally { release.resolve(); }
}));

for (const fails of [false, true]) test(`native reload waits for asynchronous dependent activation${fails ? " and reports its failure" : ""}`, { timeout: 8000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-hmr-dependent-")), root = new Context();
  const release = deferred(), probe = { next: false, loading: false }, successes = [], failures = [];
  root.logger.exporter({ export() {} });
  try {
    root.baseUrl = pathToFileURL(directory + "/").href;
    await root.plugin(Loader); await root.plugin(Timer); root.provide("probe", { ...probe, release: release.promise });
    const provider = join(directory, "provider.mjs"), consumer = join(directory, "consumer.mjs");
    const implementation = version => `export default { async apply(ctx) { await Promise.resolve(); ctx.provide('delayed', ${version}); } };`;
    await writeFile(provider, implementation(1));
    await writeFile(consumer, `export default { inject: ['delayed'], async apply(ctx) {
      if (ctx.delayed === 2) { ctx.get('probe').loading = true; await ctx.get('probe').release; ${fails ? 'throw Error("dependent failed");' : ''} }
    } };`);
    await root.loader.create({ id: "provider", name: pathToFileURL(provider).href });
    await root.loader.create({ id: "consumer", name: pathToFileURL(consumer).href }); await root.loader.await();
    root.on("hmr/reload", batch => successes.push(batch)); root.on("hmr/reload-failed", (error, phase) => failures.push({ error, phase }));
    await root.plugin(Hmr, { root: ["."], debounce: 20 });
    await delay(120); await writeFile(provider, implementation(2)); await until(() => root.get("probe").loading);
    await delay(30); assert.equal(successes.length, 0); assert.equal(failures.length, 0);
    release.resolve(); await until(() => successes.length + failures.length > 0);
    assert.equal(successes.length, fails ? 0 : 1); assert.equal(failures.length, fails ? 1 : 0);
    if (fails) {
      assert.equal(failures[0].phase, "restored");
      assert.equal(root.get("delayed"), 1);
    }
  } finally { release.resolve(); await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
