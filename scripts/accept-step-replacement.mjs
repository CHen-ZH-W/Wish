import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../dist/boot/bootstrap.js";

const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const modelConfig = { schemaVersion: 1, defaultModel: "fixture/model", maxRetries: 0, fallbackModels: [], providers: [{
  id: "fixture", protocol: "step-fixture", baseUrl: "https://unused.invalid", auth: { type: "none" },
  models: [{ id: "model", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false },
    reasoning: false, toolCalling: true, developerRole: true }],
}] };

async function fixture(stage, run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-step-replacement-"));
  const entered = deferred(), proceed = deferred(), requests = [], executions = [], parsers = [], signals = [];
  let booted, handle;
  try {
    const configurationFile = join(directory, "cordis.yml");
    await copyFile(new URL("../config/cordis.yml", import.meta.url), configurationFile);
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
      configurationFile,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: JSON.stringify(modelConfig) } });
    const ctx = booted.surfaceContext;
    ctx.get("models").registry.register("step-fixture", () => ({ async *stream(request, signal) {
      requests.push(request); signals.push(signal);
      const ordinal = requests.length, descriptor = request.tools.find(tool => tool.name === "versioned");
      yield { type: "start", model: request.model };
      yield { type: "text_delta", text: `request-${ordinal}` };
      if (ordinal === 1 && stage === "model") { entered.resolve(); await proceed.promise; }
      if (ordinal <= 2 && descriptor) {
        const version = Number(descriptor.description.slice(-1));
        yield { type: "tool_call", call: { id: `call-${ordinal}`, name: "versioned", argumentsJson: JSON.stringify({ version }) } };
        yield { type: "done", finishReason: "tool_calls" };
      } else yield { type: "done", finishReason: "stop" };
    } }));
    let approvals = 0;
    ctx.get("approval").register({ async requestApproval() {
      if (++approvals === 1 && stage === "approval") { entered.resolve(); await proceed.promise; }
      return { status: "approved", scope: "once" };
    } }, { id: "cli-surface", replace: true });
    const tool = version => ({ name: `versioned-${version}`, inject: ["tools"], apply(owner) {
      owner.tools.register({ name: "versioned", description: `Version ${version}`, executionMode: "sequential",
        inputSchemaJson: JSON.stringify({ type: "object", properties: { version: { const: version } }, required: ["version"] }),
        parse(input) { parsers.push(version); return input.version === version ? { ok: true, input } : { ok: false, message: "wrong version" }; },
        resolveCapabilities() { return { requirements: [{ capability: "filesystem.write", paths: [join(directory, "test-target.txt")] }] }; },
        async execute(input, context, grant, signal) {
          executions.push(version); signals.push(signal);
          if (executions.length === 1 && stage === "tool") { entered.resolve(); await proceed.promise; }
          return { version };
        },
      });
    } });
    let toolFiber = await ctx.plugin(tool(1));
    const app = await ctx.get("application").open();
    await app.createSession({ sessionId: "session", workspaceRoot: directory });
    handle = await app.startRun({ sessionId: "session", payload: { text: "execute two versions" } });
    await Promise.race([entered.promise, handle.completion.then(result => { throw Error(`Run ended before ${stage}: ${result.status}, ${result.error?.message ?? "no error"}`); })]);
    await run({ ctx, booted, app, handle, proceed, requests, executions, parsers, signals,
      async replaceTool() { await toolFiber.dispose(); toolFiber = await ctx.plugin(tool(2)); },
      async removeTool() { await toolFiber.dispose(); },
    });
  } finally {
    proceed.resolve();
    if (handle) await handle.completion;
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const stage of ["model", "approval", "tool"]) test(`production Run survives coordinated AgentLoop and Tool replacement during ${stage}`, { timeout: 15_000 }, () => fixture(stage, async f => {
  const runtime = f.ctx.get("runEngine"), generation = f.app.runGeneration, oldLoop = f.ctx.get("agentLoop");
  const stable = new Map(["runtime", "sessions", "models", "application", "agents"].map(id => [id, f.booted.context.loader.resolve(`include:${id}`).fiber]));
  const originalVersion = f.ctx.get("tools").registry.version;
  let updated = false;
  const replacement = runtime.execution.replace(async () => {
    assert.equal(f.executions.length, 1);
    await f.replaceTool();
    await f.booted.context.loader.update("include:agent-loop", { config: { maxParallelCalls: 1 } });
    await f.booted.context.loader.await();
    updated = true;
  });
  await tick(); assert.equal(updated, false); assert.equal(f.ctx.get("tools").registry.version, originalVersion);
  assert.equal(generation.snapshot().activeRuns[0].abortRequested, false);
  f.proceed.resolve(); await replacement;
  const completion = await f.handle.completion;
  assert.equal(completion.status, "completed", JSON.stringify(completion));
  assert.equal(completion.snapshot.runId, f.handle.runId);
  assert.equal(generation.state, "accepting");
  assert.deepEqual(f.executions, [1, 2]); assert.deepEqual(f.parsers, [1, 2]);
  assert.equal(f.requests.length, 3); assert.ok(f.signals.every(signal => !signal.aborted));
  assert.notEqual(oldLoop.maxParallelCalls, 1);
  assert.equal(f.ctx.get("agentLoop").maxParallelCalls, 1);
  for (const [id, fiber] of stable) assert.ok(f.booted.context.loader.resolve(`include:${id}`).fiber === fiber, `${id} must survive`);
  const history = await f.app.readSessionHistory({ sessionId: "session" });
  assert.equal(history.records.filter(item => item.message.role === "tool").length, 2);
  assert.deepEqual(runtime.execution.snapshot(), { phase: "ready", activeSteps: 0 });
}));

test("disabling a Tool while approval is pending revokes the old Step; no pinned lease bypasses Registry checks", { timeout: 15_000 }, () => fixture("approval", async f => {
  await f.removeTool(); f.proceed.resolve();
  const completion = await f.handle.completion;
  assert.equal(completion.status, "completed", JSON.stringify(completion));
  assert.deepEqual(f.executions, []);
  const history = await f.app.readSessionHistory({ sessionId: "session" });
  assert.match(JSON.stringify(history), /registry changed after this Step snapshot/);
}));

test("unrelated Registry edits still conservatively invalidate an old Step until registry-scoped coordination is added", { timeout: 15_000 }, () => fixture("approval", async f => {
  f.ctx.get("tools").registry.register({ name: "other", description: "Other", inputSchemaJson: '{"type":"object"}', executionMode: "sequential",
    parse: input => ({ ok: true, input }), resolveCapabilities: () => ({ requirements: [] }), execute() {} });
  f.proceed.resolve(); await f.handle.completion;
  assert.deepEqual(f.executions, [1], "the first stale call is denied; the next Step may call the still-enabled Tool");
  const history = await f.app.readSessionHistory({ sessionId: "session" });
  assert.match(JSON.stringify(history), /registry changed after this Step snapshot/);
}));

test("removing the permission authority during approval cannot let the old captured authority authorize a Tool", { timeout: 15_000 }, () => fixture("approval", async f => {
  await f.booted.context.loader.update("include:permissions-default", { disabled: true });
  f.proceed.resolve();
  assert.equal((await f.handle.completion).status, "failed");
  assert.deepEqual(f.executions, []);
  assert.throws(() => f.app.runGeneration.startRun({ id: "wish" }, { scope: "other", payload: { text: "denied" } }),
    { code: "step_execution_unavailable" });
}));
