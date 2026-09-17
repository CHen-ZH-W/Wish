import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 7000;
  while (!await check()) { if (Date.now() > deadline) throw Error("Managed code reload timed out"); await delay(10); }
}
const modelConfig = { schemaVersion: 1, defaultModel: "fixture/model", maxRetries: 0, fallbackModels: [], providers: [{
  id: "fixture", protocol: "managed-hmr-fixture", baseUrl: "https://unused.invalid", auth: { type: "none" },
  models: [{ id: "model", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false },
    reasoning: false, toolCalling: true, developerRole: true }],
}] };

async function fixture(stage, run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-hmr-"));
  const key = `wish-managed-hmr:${directory}`;
  const probe = { requests: [], receipts: [], signals: [], executions: 0, entered: Promise.withResolvers(), proceed: Promise.withResolvers() };
  const target = join(directory, "target.txt");
  probe.model = { async *stream(request, signal) {
    probe.requests.push(request); probe.signals.push(signal);
    const management = f.booted.pluginManagement.snapshot();
    probe.receipts.push({ pending: management.pending, code: management.lastReceipt?.code });
    const ordinal = probe.requests.length;
    yield { type: "start", model: request.model };
    yield { type: "text_delta", text: `request-${ordinal}` };
    if (ordinal === 1 && stage === "model") { probe.entered.resolve(); await probe.proceed.promise; }
    if (ordinal <= 2) {
      yield { type: "tool_call", call: { id: `read-${ordinal}`, name: "read", argumentsJson: JSON.stringify({ path: target }) } };
      yield { type: "done", finishReason: "tool_calls" };
    } else yield { type: "done", finishReason: "stop" };
  } };
  probe.read = async () => {
    probe.executions++;
    if (stage === "tool" && probe.executions === 1) { probe.entered.resolve(); await probe.proceed.promise; }
  };
  globalThis[key] = probe;
  const f = { directory, probe };
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(target, "real Read Tool output\n");
    const adapter = join(directory, "dist/model-fixture.mjs");
    await writeFile(adapter, `export default { inject: ['models'], apply(ctx) { ctx.models.register('managed-hmr-fixture', () => globalThis[${JSON.stringify(key)}].model); } };`);
    const profile = join(directory, "dist/config/cordis.yml");
    let config = await readFile(profile, "utf8");
    if (stage === "addressed") config = config.replace("name: 'cordis:hmr'",
      `name: '${pathToFileURL(join(repository, "node_modules/@deepseek-ai/cordis-plugin-hmr/lib/index.js")).href}'`);
    config = config.replace("    - id: models\n", `    - id: model-fixture\n      name: '${pathToFileURL(adapter).href}'\n\n    - id: models\n`);
    await writeFile(profile, config);
    f.readPath = join(directory, "dist/filesystem/consumers/model-tools/read.js");
    f.readSource = (await readFile(f.readPath, "utf8")).replace("async execute(input, context, grant, signal) {",
      `async execute(input, context, grant, signal) { await globalThis[${JSON.stringify(key)}].read();`);
    assert.match(f.readSource, /globalThis\[/);
    await writeFile(f.readPath, f.readSource);
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    const { managedWebUi } = await import(pathToFileURL(join(directory, "dist/apps/webui/host/composition.js")));
    f.boot = async () => {
      f.booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
        environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory,
          WISH_MODELS_JSON: JSON.stringify(modelConfig) },
        management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
      f.ctx = f.booted.surfaceContext;
      f.base = f.booted.context.webManagementHost.url;
      f.authorization = await (await fetch(f.base + "/api/management/bootstrap")).json();
      assert.equal(f.authorization.businessAvailable, true);
      assert.equal(f.booted.context.launch.environment.CORDIS_HMR, undefined, "the product WebUI defaults to guarded code HMR without an opt-in flag");
      assert.equal(f.booted.context.get("hmr").config.watchConfig, false);
      assert.equal((await f.snapshot()).configuration.watching, true);
    };
    f.get = async path => (await fetch(f.base + path)).json();
    f.snapshot = () => f.get("/api/management/plugins");
    f.post = async (path, value) => {
      const response = await fetch(f.base + path, { method: "POST", headers: {
        "Content-Type": "application/json", "X-Wish-Management-Token": f.authorization.token,
      }, body: JSON.stringify(value) });
      return { status: response.status, value: await response.json() };
    };
    f.change = async preference => f.post("/api/management/plugins/change", {
      requestId: randomUUID(), revision: (await f.snapshot()).revision, preference,
      selection: { instanceId: f.authorization.instanceId, entryIds: ["include:tool-read"] },
    });
    f.edit = () => writeFile(f.readPath, f.readSource.replace("Read a UTF-8 text file", "Read managed version two UTF-8 file"));
    f.start = async () => {
      assert.equal((await f.post("/api/sessions", { sessionId: "session", workspaceRoot: directory })).status, 201);
      const result = await f.post("/api/sessions/session/runs", { text: "Read across managed HMR" });
      assert.equal(result.status, 202, JSON.stringify(result));
      f.runId = result.value.run.runId;
      await until(() => probe.requests.length > 0);
      await probe.entered.promise;
    };
    f.complete = async () => {
      let view;
      await until(async () => { view = (await f.get(`/api/runs/${f.runId}`)).run; return view.status !== "running"; });
      return view;
    };
    f.reconfigure = () => writeFile(profile, config + "\n# changed deployment while code batch is pending\n");
    await f.boot();
    await run(f);
  } catch (error) { throw Error(`${error.message}\nReload: ${JSON.stringify(f.booted?.codeReload.snapshot())}`, { cause: error }); }
  finally {
    probe.proceed.resolve();
    if (f.runId) await f.complete().catch(() => {});
    await f.booted?.dispose(); delete globalThis[key]; await rm(directory, { recursive: true, force: true });
  }
}

test("managed WebUI disable survives native code/config edits and re-enable uses new Read code", { timeout: 20000 }, () => fixture("idle", async f => {
  const oldFiber = f.booted.context.loader.resolve("include:tool-read").fiber;
  const disabled = await f.change("disabled");
  assert.equal(disabled.status, 200); assert.equal(disabled.value.status, "succeeded", JSON.stringify(disabled));
  assert.equal(f.ctx.get("tools").registry.list().some(tool => tool.name === "read"), false);
  await f.edit(); await until(() => f.booted.codeReload.snapshot().phase === "succeeded");
  assert.deepEqual(f.booted.codeReload.snapshot().entryIds, []);
  const before = await f.snapshot(); await f.reconfigure();
  await until(async () => (await f.snapshot()).configuration.digest !== before.configuration.digest);
  assert.equal((await f.snapshot()).preferences["include:tool-read"].preference, "disabled");
  assert.equal(f.booted.context.loader.resolve("include:tool-read").fiber, undefined);
  const enabled = await f.change("enabled");
  assert.equal(enabled.value.status, "succeeded", JSON.stringify(enabled));
  assert.notEqual(f.booted.context.loader.resolve("include:tool-read").fiber, oldFiber);
  assert.match(f.ctx.get("tools").registry.list().find(tool => tool.name === "read").description, /managed version two/);
}));

test("managed WebUI Run drains a Step, rejects racing disable, notifies SSE and resumes new code after durable receipt", { timeout: 20000 }, () => fixture("model", async f => {
  const stable = new Map(["runtime", "sessions", "models", "application", "tools", "webui"].map(id => [id, f.booted.context.loader.resolve(`include:${id}`).fiber]));
  const pid = process.pid;
  const stream = await fetch(f.base + "/api/management/events"), reader = stream.body.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: reset/);
    await f.start();
    const initial = await f.snapshot(), registryVersion = f.ctx.get("tools").registry.version;
    await f.edit(); await until(() => f.booted.codeReload.snapshot().phase === "draining");
    const draining = await f.snapshot();
    assert.equal(draining.status, "working"); assert.equal(draining.pending, null);
    assert.equal(f.ctx.get("tools").registry.version, registryVersion);
    assert.deepEqual(draining.codeReload.entryIds, ["include:tool-read"]);
    const racing = await f.change("disabled"); assert.equal(racing.status, 409);
    assert.match(JSON.stringify(racing.value), /management_busy/);
    await f.reconfigure(); await delay(250);
    assert.equal((await f.snapshot()).configuration.digest, initial.configuration.digest);
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: invalidated/);
    f.probe.proceed.resolve();
    const completed = await f.complete(); assert.equal(completed.status, "completed", JSON.stringify(completed));
    await until(async () => (await f.snapshot()).configuration.digest !== initial.configuration.digest);
    const after = await f.snapshot();
    assert.equal(after.codeReload.phase, "succeeded"); assert.equal(after.pending, null);
    assert.equal(after.lastReceipt.code, "management_code_reload_applied");
    assert.deepEqual(after.preferences, initial.preferences);
    assert.equal(process.pid, pid);
    assert.equal(completed.runId, f.runId); assert.equal(f.probe.executions, 2);
    assert.ok(f.probe.signals.every(signal => !signal.aborted));
    assert.doesNotMatch(f.probe.requests[0].tools.find(tool => tool.name === "read").description, /managed version two/);
    assert.match(f.probe.requests[1].tools.find(tool => tool.name === "read").description, /managed version two/);
    assert.deepEqual(f.probe.receipts[1], { pending: null, code: "management_code_reload_applied" });
    for (const [id, fiber] of stable) assert.ok(f.booted.context.loader.resolve(`include:${id}`).fiber === fiber, `${id} was replaced`);
    const history = await f.get("/api/sessions/session/history");
    assert.equal(history.history.records.filter(record => record.message.role === "tool").length, 2);
    assert.equal(JSON.stringify(after.codeReload).includes(f.directory), false);
    assert.equal((await f.change("disabled")).value.status, "succeeded");
    assert.equal(f.ctx.get("tools").registry.list().some(tool => tool.name === "read"), false);
  } finally { await reader.cancel(); }
}));

test("a directly addressed native HMR entry still cannot bypass the managed configuration owner", { timeout: 20000 }, () => fixture("addressed", async f => {
  const before = await f.snapshot();
  await f.reconfigure();
  await until(async () => (await f.snapshot()).configuration.digest !== before.configuration.digest);
  await f.edit(); await until(() => f.booted.codeReload.snapshot().phase === "succeeded");
  assert.equal((await f.snapshot()).lastReceipt.code, "management_code_reload_applied");
}));

test("managed native import failure keeps old owner and exposes only a safe code; corrected source can retry", { timeout: 20000 }, () => fixture("idle", async f => {
  const owner = f.booted.context.loader.resolve("include:tool-read").fiber;
  const before = await f.snapshot();
  await writeFile(f.readPath, f.readSource + '\nthrow Error("PRIVATE_SOURCE_SENTINEL");\n');
  await until(() => f.booted.codeReload.snapshot().phase === "rejected");
  const failed = await f.snapshot();
  assert.equal(failed.codeReload.code, "code_reload_import_failed");
  assert.equal(failed.pending, null); assert.deepEqual(failed.preferences, before.preferences);
  assert.equal(JSON.stringify(failed).includes("PRIVATE_SOURCE_SENTINEL"), false);
  assert.ok(f.booted.context.loader.resolve("include:tool-read").fiber === owner);
  await f.edit(); await until(() => f.booted.codeReload.snapshot().phase === "succeeded");
  assert.equal((await f.snapshot()).lastReceipt.code, "management_code_reload_applied");
}));

test("Read owns in-flight stop refusal; a later accepted WebUI disable really revokes the Tool", { timeout: 20000 }, () => fixture("tool", async f => {
  await f.start();
  const refused = await f.change("disabled");
  assert.equal(refused.status, 200); assert.equal(refused.value.status, "rejected", JSON.stringify(refused));
  assert.equal((await f.snapshot()).preferences["include:tool-read"], undefined);
  assert.equal(f.ctx.get("tools").registry.list().some(tool => tool.name === "read"), true);
  f.probe.proceed.resolve(); assert.equal((await f.complete()).status, "completed");
  assert.equal((await f.change("disabled")).value.status, "succeeded");
  assert.equal(f.ctx.get("tools").registry.list().some(tool => tool.name === "read"), false);
}));

test("managed receipt failure fences the next Step and restart quarantines the real owner until explicit HTTP recovery", { timeout: 25000 }, () => fixture("model", async f => {
  await f.start();
  const store = f.booted.pluginManagement.store, commit = store.commit.bind(store);
  store.commit = async (revision, state) => {
    if (state.pending === null && state.receipts.at(-1)?.code === "management_code_reload_applied") throw Error("PRIVATE_SAVE_SENTINEL");
    return commit(revision, state);
  };
  try {
    await f.edit(); await until(() => f.booted.codeReload.snapshot().phase === "draining");
    f.probe.proceed.resolve(); assert.equal((await f.complete()).status, "failed");
    const failed = await f.snapshot();
    assert.equal(failed.status, "recovery-required"); assert.equal(failed.codeReload.phase, "recovery-required");
    assert.match(failed.pending.requestId, /^code-reload:/); assert.equal(f.probe.executions, 1);
    assert.equal(JSON.stringify(failed).includes("PRIVATE_SAVE_SENTINEL"), false);
    assert.equal((await fetch(f.base + "/api/management/bootstrap")).status, 200);
    const refused = await f.post("/api/management/plugins/recover-disabled", { revision: failed.revision });
    assert.equal(refused.status, 503); assert.match(JSON.stringify(refused.value), /management_restart_required/);
    store.commit = commit;
    const instanceId = f.authorization.instanceId;
    f.runId = undefined; await f.booted.dispose(); f.booted = undefined;
    await f.boot(); assert.notEqual(f.authorization.instanceId, instanceId);
    assert.equal(f.ctx.get("tools").registry.list().some(tool => tool.name === "read"), false);
    const quarantined = await f.snapshot(); assert.equal(quarantined.status, "recovery-required");
    const recovered = await f.post("/api/management/plugins/recover-disabled", { revision: quarantined.revision });
    assert.equal(recovered.status, 200); assert.equal(recovered.value.pending, null);
    assert.equal(recovered.value.preferences["include:tool-read"].preference, "disabled");
    assert.equal(f.probe.executions, 1); // No replay of a dispatched Tool.
    assert.equal((await f.change("enabled")).value.status, "succeeded");
    assert.match(f.ctx.get("tools").registry.list().find(tool => tool.name === "read").description, /managed version two/);
  } finally { store.commit = commit; }
}));
