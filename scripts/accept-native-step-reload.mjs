import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 6000;
  while (!check()) { if (Date.now() > deadline) throw Error("Native Step reload timed out"); await delay(10); }
}
const modelConfig = { schemaVersion: 1, defaultModel: "fixture/model", maxRetries: 0, fallbackModels: [], providers: [{
  id: "fixture", protocol: "native-hmr-fixture", baseUrl: "https://unused.invalid", auth: { type: "none" },
  models: [{ id: "model", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false },
    reasoning: false, toolCalling: true, developerRole: true }],
}] };
const plugin = (key, version, fails = false) => `export default { inject: ["tools"], async apply(ctx) {
  const p = globalThis[${JSON.stringify(key)}];
  ctx.root.get("codeReload").register(ctx);
  ctx.tools.register({ name: "versioned", description: "Version ${version}", executionMode: "sequential",
    inputSchemaJson: '{"type":"object","properties":{"version":{"const":${version}}},"required":["version"]}',
    parse(input) { p.parsers.push(${version}); return input.version === ${version} ? {ok:true,input} : {ok:false,message:"wrong version"}; },
    resolveCapabilities() { return {requirements:[{capability:"filesystem.write",paths:[p.target]}]}; },
    async execute(_input, _context, _grant, signal) {
      p.executions.push(${version}); p.signals.push(signal);
      if (p.stage === "tool" && p.executions.length === 1) { p.entered.resolve(); await p.proceed.promise; }
      if (p.stage === "self" && p.executions.length === 1) {
        p.entered.resolve(); await p.proceed.promise; await p.submit();
        return {status:"update accepted"};
      }
      return {version:${version}};
    }
  });
  ${fails ? 'await Promise.resolve(); throw Error("new plugin initialization failed");' : ""}
} };`;

async function fixture(stage, run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-native-step-"));
  const key = `wish-native-step:${directory}`;
  const probe = { stage, target: join(directory, "target.txt"), executions: [], parsers: [], signals: [],
    entered: Promise.withResolvers(), proceed: Promise.withResolvers() };
  globalThis[key] = probe;
  let booted, handle;
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await writeFile(probe.target, "real Read Tool output\n");
    const filename = join(directory, "dist/hmr-fixture.mjs"); await writeFile(filename, plugin(key, 1));
    const profile = join(directory, "dist/config/cordis.yml");
    const config = await readFile(profile, "utf8");
    await writeFile(profile, config.replace("    - id: tools\n", `    - id: hmr-fixture\n      name: '${pathToFileURL(filename).href}'\n\n    - id: tools\n`));
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "1", WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: JSON.stringify(modelConfig) } });
    const ctx = booted.surfaceContext, requests = [];
    ctx.get("models").registry.register("native-hmr-fixture", () => ({ async *stream(request, signal) {
      requests.push(request); probe.signals.push(signal);
      const ordinal = requests.length;
      yield { type: "start", model: request.model }; yield { type: "text_delta", text: `request-${ordinal}` };
      if (ordinal === 1 && stage === "model") { probe.entered.resolve(); await probe.proceed.promise; }
      if (ordinal <= 2) {
        const version = Number(request.tools.find(tool => tool.name === "versioned").description.slice(-1));
        yield { type: "tool_call", call: { id: `version-${ordinal}`, name: "versioned", argumentsJson: JSON.stringify({ version }) } };
        yield { type: "tool_call", call: { id: `read-${ordinal}`, name: "read", argumentsJson: JSON.stringify({ path: probe.target }) } };
        yield { type: "done", finishReason: "tool_calls" };
      } else yield { type: "done", finishReason: "stop" };
    } }));
    let approvals = 0;
    ctx.get("approval").register({ async requestApproval() {
      if (++approvals === 1 && stage === "approval") { probe.entered.resolve(); await probe.proceed.promise; }
      return { status: "approved", scope: "once" };
    } }, { id: "cli-surface", replace: true });
    const app = await ctx.get("application").open();
    await app.createSession({ sessionId: "session", workspaceRoot: directory });
    handle = await app.startRun({ sessionId: "session", payload: { text: "Run across native HMR" } });
    await Promise.race([probe.entered.promise, handle.completion.then(value => { throw Error(`Run ended early: ${JSON.stringify(value)}`); })]);
    await run({ ctx, app, handle, booted, requests, probe, directory, async edit(fails = false) {
      const readFilePath = join(directory, "dist/filesystem/consumers/model-tools/read.js");
      const loopFile = join(directory, "dist/composition/agent-loop-service.js");
      const [read, loop] = await Promise.all([readFile(readFilePath, "utf8"), readFile(loopFile, "utf8")]);
      await Promise.all([writeFile(filename, plugin(key, 2, fails)),
        writeFile(readFilePath, read.replace("Read a UTF-8 text file", "Read native version two UTF-8 file")),
        writeFile(loopFile, loop.replace("this.maxParallelCalls = config.maxParallelCalls;", "this.maxParallelCalls = config.maxParallelCalls ?? 1;"))]);
    } });
  } catch (error) { throw Error(`${error.message}\nReload: ${JSON.stringify(booted?.codeReload.snapshot())}`, { cause: error }); }
  finally {
    probe.proceed.resolve(); if (handle) await handle.completion;
    await booted?.dispose(); delete globalThis[key]; await rm(directory, { recursive: true, force: true });
  }
}

for (const stage of ["model", "approval", "tool"]) test(`native file HMR preserves the same production Run during ${stage}`, { timeout: 18000 }, () => fixture(stage, async f => {
  const stable = new Map(["runtime", "sessions", "models", "application", "tools", "agents"].map(id => [id, f.booted.context.loader.resolve(`include:${id}`).fiber]));
  const generation = f.app.runGeneration, pid = process.pid;
  const registryVersion = f.ctx.get("tools").registry.version;
  await f.edit(); await until(() => f.booted.codeReload.snapshot().phase === "draining" || f.booted.codeReload.snapshot().phase === "rejected");
  assert.equal(f.booted.codeReload.snapshot().phase, "draining", JSON.stringify(f.booted.codeReload.snapshot()));
  assert.equal(f.ctx.get("tools").registry.version, registryVersion);
  assert.equal(generation.snapshot().activeRuns[0].abortRequested, false);
  f.probe.proceed.resolve();
  const completion = await f.handle.completion;
  assert.equal(completion.status, "completed", JSON.stringify(completion));
  assert.equal(f.booted.codeReload.snapshot().phase, "succeeded");
  assert.equal(process.pid, pid); assert.equal(completion.snapshot.runId, f.handle.runId);
  assert.deepEqual(f.probe.executions, [1, 2]); assert.deepEqual(f.probe.parsers, [1, 2]);
  assert.ok(f.probe.signals.every(signal => !signal.aborted));
  assert.equal(f.requests.length, 3);
  assert.doesNotMatch(f.requests[0].tools.find(tool => tool.name === "read").description, /native version two/);
  assert.match(f.requests[1].tools.find(tool => tool.name === "read").description, /native version two/);
  assert.equal(f.ctx.get("agentLoop").maxParallelCalls, 1);
  for (const [id, fiber] of stable) assert.ok(f.booted.context.loader.resolve(`include:${id}`).fiber === fiber, `${id} was replaced`);
  const history = await f.app.readSessionHistory({ sessionId: "session" });
  assert.equal(history.records.filter(record => record.message.role === "tool").length, 4);
}));

test("native activation failure fences the Runtime without replaying the old Tool", { timeout: 18000 }, () => fixture("model", async f => {
  await f.edit(true); await until(() => f.booted.codeReload.snapshot().phase === "draining" || f.booted.codeReload.snapshot().phase === "rejected");
  assert.equal(f.booted.codeReload.snapshot().phase, "draining");
  f.probe.proceed.resolve(); const completion = await f.handle.completion;
  assert.equal(completion.status, "failed"); assert.deepEqual(f.probe.executions, [1]);
  assert.equal(f.booted.codeReload.snapshot().phase, "recovery-required");
  assert.equal(f.ctx.get("runEngine").execution.snapshot().phase, "failed");
}));

test("a Tool can submit its own code edit and return acceptance without waiting for its Step replacement", { timeout: 18000 }, () => fixture("self", async f => {
  f.probe.submit = async () => {
    await f.edit();
    await until(() => f.booted.codeReload.snapshot().phase === "draining" || f.booted.codeReload.snapshot().phase === "rejected");
    assert.equal(f.booted.codeReload.snapshot().phase, "draining");
    // Acceptance is not completion. Awaiting succeeded here would deadlock.
  };
  f.probe.proceed.resolve();
  assert.equal((await f.handle.completion).status, "completed");
  assert.deepEqual(f.probe.executions, [1, 2]);
  assert.equal(f.booted.codeReload.snapshot().phase, "succeeded");
}));

test("a stable Runtime owner code edit is rejected before disposal and the original Run continues", { timeout: 18000 }, () => fixture("model", async f => {
  const runtime = f.booted.context.loader.resolve("include:runtime").fiber;
  const filename = join(f.directory, "dist/composition/runtime-service.js");
  await writeFile(filename, await readFile(filename, "utf8") + "\n// unsupported stable owner edit\n");
  await until(() => f.booted.codeReload.snapshot().phase === "rejected");
  assert.equal(f.booted.codeReload.snapshot().code, "code_reload_owner_unsupported");
  assert.ok(f.booted.context.loader.resolve("include:runtime").fiber === runtime);
  f.probe.proceed.resolve();
  assert.equal((await f.handle.completion).status, "completed");
  assert.deepEqual(f.probe.executions, [1, 1]);
  assert.ok(f.probe.signals.every(signal => !signal.aborted));
}));
