import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { canonical, digest, validateDefinition, validateSnapshot } from "../dist/agent-profiles/validation.js";
import { verifyCode } from "../dist/agent-profiles/composition.js";
import { parseWishCliArguments } from "../dist/apps/cli/args.js";
import { summarize } from "../dist/experiments/metrics.js";

export const definition = (id = "coder", version = 1) => ({ schemaVersion: 1, id, version, model: "fixture/a", tools: ["read"], permissionProfile: "read-only", memory: "none", instructions: "Use the selected Profile.", compaction: { keepRecentTokens: 128 } });
export function models(baseUrl = "http://127.0.0.1:1/v1") {
  return { schemaVersion: 1, defaultModel: "fixture/a", maxRetries: 0, providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl, auth: { type: "none" }, developerRoleMode: "native", request: { streamUsage: false, supportsTemperature: true, maxTokensField: "max_tokens", extraBody: {} }, models: ["a", "b", "hang"].map(id => ({ id, status: "active", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true })) }] };
}
export async function boot(directory, environment = {}, management = false) {
  return bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data"), WISH_EXPERIMENTS_DIR: join(directory, "jobs"), WISH_MODELS_JSON: JSON.stringify(models()), WISH_PERMISSION_PROFILE: "workspace-write", CORDIS_HMR: "0", ...environment },
    ...(management ? { management: { directory: join(directory, "management"), async start(_root, control) { control.setRecoveryAvailable(true); return async () => control.setRecoveryAvailable(false); } } } : {}),
  });
}
function response(content = "A") {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

test("Profile parsers pin versions and lossless canonical values", () => {
  assert.equal(digest({ b: 2, a: [1] }), digest({ a: [1], b: 2 }));
  assert.throws(() => canonical({ value: undefined }), { code: "profile_non_json" });
  assert.throws(() => canonical([, 1]), { code: "profile_non_json" });
  assert.throws(() => validateDefinition({ ...definition(), version: 0 }));
  assert.throws(() => validateDefinition({ ...definition(), accidental: true }), { code: "profile_unknown_field" });
  assert.throws(() => validateDefinition({ ...definition(), tools: ["read", "read"] }));
  assert.equal(parseWishCliArguments(["run", "--agent-profile", "coder@2", "hi"]).agentProfile, "coder@2");
});

test("a live owner survives another Host; an actual process crash is interrupted without replay", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-crash-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/agent-profile-crash.mjs", import.meta.url)), directory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const closed = new Promise(accept => child.once("close", accept));
  let booted;
  try {
    const started = Date.now();
    while (true) {
      try { await readFile(join(directory, "ready.json")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.equal(child.exitCode, null, output); assert.ok(Date.now() - started < 15_000, output);
      await new Promise(accept => setTimeout(accept, 20));
    }
    booted = await boot(directory);
    assert.equal((await booted.surfaceContext.get("experiments").get("crash-experiment")).status, "running");
    assert.equal((await booted.surfaceContext.get("agentProfiles").listBindings())[0].status, "admitted");
    await booted.dispose(); booted = undefined;
    child.kill("SIGKILL"); await closed;
    booted = await boot(directory);
    const result = await booted.surfaceContext.get("experiments").get("crash-experiment");
    assert.equal(result.status, "interrupted"); assert.equal(result.results.length, 0);
    assert.equal((await booted.surfaceContext.get("agentProfiles").listBindings())[0].status, "interrupted");
  } finally { child.kill("SIGKILL"); await closed; await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("the real CLI registers and captures Profiles independently of the run parser", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-cli-"));
  try {
    const filename = join(directory, "profile.json"); await writeFile(filename, JSON.stringify(definition()));
    const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WISH_") && key !== "CORDIS_CONFIG")), HOME: directory,
      WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: JSON.stringify(models()), WISH_PERMISSION_PROFILE: "workspace-write", CORDIS_HMR: "0" };
    const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/apps/cli/main.js", import.meta.url)), ...args], { cwd: directory, env: environment, maxBuffer: 4 * 1024 * 1024 })).stdout);
    assert.equal((await cli("profile", "register", filename)).id, "coder");
    const snapshot = await cli("profile", "capture", "coder@1");
    assert.equal((await cli("profile", "inspect", snapshot.digest)).digest, snapshot.digest);
    assert.equal((await cli("profile", "list")).length, 1);
    assert.deepEqual(await cli("profile", "bindings"), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real Loader binds model, Prompt, Tool ceiling and durable snapshot across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-binding-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return response(); };
  let booted;
  try {
    booted = await boot(directory);
    let ctx = booted.surfaceContext;
    await ctx.get("agentProfiles").register(definition());
    await assert.rejects(ctx.get("agentProfiles").register({ ...definition(), instructions: "Changed without a version bump" }), { code: "profile_immutable_conflict" });
    await assert.rejects(ctx.get("agentProfiles").capture("coder", await ctx.get("application").resolve()), { code: "profile_explicit_version_required" });
    const snapshot = await ctx.get("agentProfiles").capture("coder@1", await ctx.get("application").resolve());
    assert.equal(snapshot.digest, (await ctx.get("agentProfiles").capture("coder@1", await ctx.get("application").resolve())).digest);
    assert.ok(Object.isFrozen(snapshot.permissions.availableTools));
    assert.throws(() => validateSnapshot({ ...snapshot, model: { provider: "fixture", model: "b" } }), { code: "profile_snapshot_digest_mismatch" });
    const app = await ctx.get("application").open({ agentProfile: snapshot.digest });
    const session = await app.createSession({ workspaceRoot: directory });
    await assert.rejects(app.startRun({ sessionId: session.sessionId, payload: { text: "hi", model: { provider: "fixture", model: "b" } } }), { code: "profile_selection_locked" });
    const handle = await app.startRun({ sessionId: session.sessionId, inputSource: "user", payload: { text: "hi" } });
    assert.equal((await handle.completion).status, "completed");
    assert.equal(requests.at(-1).model, "a");
    assert.deepEqual(requests.at(-1).tools.map(tool => tool.function.name), ["read"]);
    assert.ok(requests.at(-1).messages.some(message => message.content?.includes("Use the selected Profile.")));
    assert.equal((await ctx.get("agentProfiles").listBindings())[0].snapshotDigest, snapshot.digest);
    assert.equal((await ctx.get("agentProfiles").listBindings())[0].status, "completed");
    await app.runGeneration.retire();
    await booted.dispose();
    booted = await boot(directory); ctx = booted.surfaceContext;
    assert.equal((await ctx.get("agentProfiles").get(snapshot.digest)).digest, snapshot.digest);
    assert.equal((await ctx.get("agentProfiles").listBindings())[0].status, "completed");
    const resumed = await ctx.get("application").open({ agentProfile: snapshot.digest });
    assert.equal(resumed.executionProfile.digest, snapshot.digest);
    await resumed.runGeneration.retire();
  } finally { globalThis.fetch = originalFetch; await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("Profiles narrow authority, reject missing strategies and detect changed runtime contributions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-guards-")); let booted;
  try {
    booted = await boot(directory); const ctx = booted.surfaceContext;
    await ctx.get("agentProfiles").register({ ...definition("unsafe"), permissionProfile: "full-access" });
    await assert.rejects(ctx.get("agentProfiles").capture("unsafe@1", await ctx.get("application").resolve()), { code: "profile_permission_escalation" });
    await ctx.get("agentProfiles").register({ ...definition("missing"), compaction: { strategyId: "missing-v1" } });
    await assert.rejects(ctx.get("application").open({ agentProfile: "missing@1" }), /missing-v1.*unavailable/);
    await ctx.get("agentProfiles").register({ ...definition("private-memory"), memory: "isolated" });
    await assert.rejects(ctx.get("application").open({ agentProfile: "private-memory@1" }), { code: "profile_memory_requires_isolated_host" });
    await ctx.get("agentProfiles").register(definition());
    const app = await ctx.get("application").open({ agentProfile: "coder@1" });
    const session = await app.createSession({ workspaceRoot: directory });
    const addition = ctx.get("tools").register({ name: "profile_extra", description: "test", inputSchemaJson: '{"type":"object","additionalProperties":false}', executionMode: "parallel", recoveryPolicy: "retry-safe", parse: input => ({ ok: true, input }), resolveCapabilities: () => ({ requirements: [] }), execute: async () => "extra" });
    await assert.rejects(app.startRun({ sessionId: session.sessionId, payload: { text: "hi" } }), { code: "profile_contributions_changed" });
    addition.unregister();
    await app.runGeneration.retire();
    const path = join(directory, "implementation.js"); await writeFile(path, "first");
    const code = [{ path, sha256: createHash("sha256").update("first").digest("hex") }];
    await verifyCode(code); await writeFile(path, "second");
    await assert.rejects(verifyCode(code), { code: "profile_code_changed" });
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("unloading the Profile adapter aborts active Runs and releases its Scope", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-unload-"));
  const previous = globalThis.fetch; let booted, entered;
  const fetching = new Promise(accept => { entered = accept; });
  globalThis.fetch = async (_url, init) => { entered(); return new Promise((_accept, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); }); };
  try {
    booted = await boot(directory); const ctx = booted.surfaceContext;
    await ctx.get("agentProfiles").register(definition());
    const app = await ctx.get("application").open({ agentProfile: "coder@1" });
    const session = await app.createSession({ workspaceRoot: directory });
    const handle = await app.startRun({ sessionId: session.sessionId, payload: { text: "wait" } });
    await fetching;
    await booted.context.loader.resolve("include:agent-profile-application").update({ disabled: true });
    assert.equal((await handle.completion).status, "aborted");
    assert.equal(app.runGeneration.state, "retired");
    assert.equal((await ctx.get("agentProfiles").listBindings())[0].status, "aborted");
    await assert.rejects(app.startRun({ sessionId: session.sessionId, payload: { text: "old" } }));
    await booted.context.loader.resolve("include:agent-profile-application").update({ disabled: false });
    const replacement = await ctx.get("application").open({ agentProfile: "coder@1" });
    await replacement.runGeneration.retire();
  } finally { globalThis.fetch = previous; await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("an experimental Step limit stops a Tool loop before another model request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-steps-"));
  const previous = globalThis.fetch; let booted, calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `read-${calls}`, type: "function", function: { name: "read", arguments: '{"path":"seed.txt"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    await writeFile(join(directory, "seed.txt"), "seed");
    booted = await boot(directory); const ctx = booted.surfaceContext;
    await ctx.get("agentProfiles").register(definition());
    const app = await ctx.get("application").open({ agentProfile: "coder@1", maxRunSteps: 2 });
    const session = await app.createSession({ workspaceRoot: directory });
    const run = await app.startRun({ sessionId: session.sessionId, payload: { text: "read repeatedly" } });
    const completion = await run.completion;
    assert.equal(completion.status, "failed");
    assert.match(completion.snapshot.error.message, /run_step_limit_exceeded/);
    assert.equal(calls, 2);
    assert.equal((await ctx.get("agentProfiles").listBindings())[0].status, "failed");
    await app.runGeneration.retire();
  } finally { globalThis.fetch = previous; await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("unloading Profile state drains its dependent active execution before releasing Storage", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-profile-state-unload-"));
  const previous = globalThis.fetch; let booted, entered;
  const fetching = new Promise(accept => { entered = accept; });
  globalThis.fetch = async (_url, init) => { entered(); return new Promise((_accept, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); }); };
  try {
    booted = await boot(directory); let ctx = booted.surfaceContext;
    await ctx.get("agentProfiles").register(definition());
    const app = await ctx.get("application").open({ agentProfile: "coder@1" });
    const session = await app.createSession({ workspaceRoot: directory });
    const handle = await app.startRun({ sessionId: session.sessionId, payload: { text: "wait" } });
    void handle.completion.catch(() => {});
    await fetching;
    await booted.context.loader.resolve("include:agent-profiles").update({ disabled: true });
    assert.equal(app.runGeneration.state, "retired");
    await booted.context.loader.resolve("include:agent-profiles").update({ disabled: false });
    ctx = booted.surfaceContext;
    assert.ok(["aborted", "interrupted"].includes((await ctx.get("agentProfiles").listBindings())[0].status));
  } finally { globalThis.fetch = previous; await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("experiment facts persist partial results, reject bad datasets, cancel and recover without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-experiment-state-")); let booted;
  try {
    booted = await boot(directory); let ctx = booted.surfaceContext;
    await ctx.get("agentProfiles").register(definition());
    const snapshot = await ctx.get("agentProfiles").capture("coder@1", await ctx.get("application").resolve());
    await assert.rejects(ctx.get("experiments").registerDataset({ schemaVersion: 1, id: "bad", version: 1, cases: [{ id: "case", prompt: "hi", files: { "../escape": "bad" }, assertion: { kind: "exact", expected: "A" } }] }), { code: "experiment_invalid_file" });
    const dataset = await ctx.get("experiments").registerDataset({ schemaVersion: 1, id: "small", version: 1, cases: [{ id: "one", prompt: "hi", files: {}, assertion: { kind: "exact", expected: "A" } }] });
    await assert.rejects(ctx.get("experiments").registerDataset({ ...dataset.dataset, cases: [{ ...dataset.dataset.cases[0], prompt: "changed" }] }), { code: "experiment_dataset_version_conflict" });
    let calls = 0, closed = false;
    await booted.context.loader.resolve("include:experiment-process").update({ disabled: true });
    const release = ctx.get("experiments").registerExecutor({ async execute(_input, signal) { calls++; await new Promise(accept => signal.addEventListener("abort", accept, { once: true })); closed = true; return { status: "aborted", output: "", durationMs: 1, attempts: [] }; } });
    const plan = { datasetDigest: dataset.digest, variants: [{ label: "base", snapshotDigest: snapshot.digest }], baseline: "base", repetitions: 1, timeoutMs: 1000, maxSteps: 2 };
    const job = await ctx.get("experiments").start(plan);
    while (!calls) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await ctx.get("experiments").cancel(job.id)).status, "cancelled");
    assert.equal(closed, true);
    const planFile = join(directory, "plan.json"); await writeFile(planFile, JSON.stringify(plan));
    let cliOutput = "";
    const terminal = { async writeOutput(text) { cliOutput += text; }, async writeError() {} };
    const controller = new AbortController();
    const command = ctx.bail("cli/command", ["experiment", "run", planFile], terminal, controller.signal);
    while (calls < 2) await new Promise(resolve => setImmediate(resolve));
    await booted.context.loader.resolve("include:agent-profile-cli").update({ disabled: true });
    assert.equal(await command, 130);
    assert.equal(JSON.parse(cliOutput).status, "cancelled");
    release();
    await booted.dispose(); booted = await boot(directory); ctx = booted.surfaceContext;
    assert.equal((await ctx.get("experiments").get(job.id)).status, "cancelled");
    assert.equal((await ctx.get("experiments").listDatasets())[0].digest, dataset.digest);
    assert.equal(calls, 2);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("metrics include retry attempts and preserve unknown prices and usage", () => {
  const plan = { variants: [{ label: "base" }, { label: "candidate" }], baseline: "base" };
  const result = { label: "base", passed: true, durationMs: 10, attempts: [{ usage: { inputTokens: 5, outputTokens: 1 }, cost: { status: "unavailable" } }, {}] };
  const report = summarize(plan, [result, { label: "candidate", passed: false, durationMs: 20, attempts: [] }]);
  assert.equal(report.metrics.base.attempts, 2); assert.equal(report.metrics.base.inputTokens, null); assert.equal(report.metrics.base.costByCurrency, null);
  assert.equal(report.comparison.candidate.successRateDelta, -1);
  const partial = summarize(plan, [{ ...result, attemptsComplete: false }]);
  assert.equal(partial.metrics.base.attempts, null);
  assert.equal(partial.metrics.base.costByCurrency, null);
  assert.deepEqual(partial.comparison, {});
});

test("real experiment processes use frozen Profiles, isolated inputs, durable metrics and bounded execution", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-experiment-process-"));
  const requests = []; const held = new Set();
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const value = JSON.parse(body); requests.push(value);
    if (value.model === "hang") { held.add(response); response.on("close", () => held.delete(response)); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: value.model === "a" ? "A" : "B" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
  });
  let booted;
  try {
    await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
    booted = await boot(directory, { ...process.env, WISH_DATA_DIR: join(directory, "data"), WISH_EXPERIMENTS_DIR: join(directory, "jobs"), WISH_PERMISSION_PROFILE: "workspace-write", CORDIS_HMR: "0", WISH_MODELS_JSON: JSON.stringify(models(`http://127.0.0.1:${server.address().port}/v1`)) });
    const ctx = booted.surfaceContext, profiles = ctx.get("agentProfiles"), experiments = ctx.get("experiments");
    await profiles.register(definition());
    await profiles.register({ ...definition("candidate"), model: "fixture/b", memory: "isolated", compaction: { keepRecentTokens: 64 } });
    const host = await ctx.get("application").resolve();
    const baseline = await profiles.capture("coder@1", host), candidate = await profiles.capture("candidate@1", host);
    const dataset = await experiments.registerDataset({ schemaVersion: 1, id: "pair", version: 1, cases: [{ id: "answer", prompt: "Answer with one letter.", files: { "seed.txt": "same input" }, assertion: { kind: "exact", expected: "A" } }] });
    const plan = { datasetDigest: dataset.digest, variants: [{ label: "base", snapshotDigest: baseline.digest }, { label: "candidate", snapshotDigest: candidate.digest }], baseline: "base", repetitions: 1, timeoutMs: 15_000, maxSteps: 3 };
    const job = await experiments.start(plan);
    const result = await job.completion;
    for (const item of result.results) if (item.status !== "completed") {
      const log = await readFile(join(directory, "jobs", job.id, item.key, "worker.log"), "utf8");
      assert.fail(`${JSON.stringify(item)}\n${log}`);
    }
    assert.equal(result.status, "completed");
    assert.deepEqual(result.results.map(item => item.output), ["A", "B"]);
    assert.equal(result.metrics.base.successRate, 1); assert.equal(result.metrics.candidate.successRate, 0);
    assert.equal(result.metrics.base.inputTokens, 10); assert.equal(result.comparison.candidate.successRateDelta, -1);
    assert.deepEqual(requests.map(item => item.model), ["a", "b"]);
    assert.deepEqual(requests.map(item => item.tools.map(tool => tool.function.name)), [["read"], ["read"]]);
    for (const item of result.results) assert.equal(await readFile(join(directory, "jobs", job.id, item.key, "workspace", "seed.txt"), "utf8"), "same input");
    assert.notEqual(result.results[0].sessionId, result.results[1].sessionId);
    const persistedId = job.id;
    await booted.dispose(); booted = await boot(directory);
    assert.deepEqual(await booted.surfaceContext.get("experiments").get(persistedId), result);
    await booted.dispose();
    booted = await boot(directory, { ...process.env, WISH_DATA_DIR: join(directory, "data"), WISH_EXPERIMENTS_DIR: join(directory, "jobs"), WISH_PERMISSION_PROFILE: "workspace-write", CORDIS_HMR: "0", WISH_MODELS_JSON: JSON.stringify(models(`http://127.0.0.1:${server.address().port}/v1`)) });
    const current = booted.surfaceContext;
    await current.get("agentProfiles").register({ ...definition("hanging"), model: "fixture/hang" });
    const slow = await current.get("agentProfiles").capture("hanging@1", await current.get("application").resolve());
    const timed = await current.get("experiments").start({ ...plan, variants: [{ label: "base", snapshotDigest: slow.digest }], timeoutMs: 3_000 });
    const timeout = await timed.completion;
    assert.equal(timeout.results[0].status, "timed-out");
    assert.equal(timeout.results[0].passed, false);
    assert.equal(timeout.metrics.base.inputTokens, null);
    assert.equal(timeout.metrics.base.attempts, null);
    const fileDataset = await current.get("experiments").registerDataset({ schemaVersion: 1, id: "files", version: 1, cases: [{ id: "seed", prompt: "Reply A.", files: { "seed.txt": "same" }, assertion: { kind: "file-equals", path: "seed.txt", expected: "same" } }] });
    // Recapture against the current deployment after the restart.
    const active = await current.get("agentProfiles").capture("coder@1", await current.get("application").resolve());
    const fileJob = await current.get("experiments").start({ ...plan, datasetDigest: fileDataset.digest, variants: [{ label: "base", snapshotDigest: active.digest }] });
    assert.equal((await fileJob.completion).results[0].passed, true);
    const cancellation = await current.get("experiments").start({ ...plan, variants: [{ label: "base", snapshotDigest: slow.digest }] });
    while (!held.size) await new Promise(accept => setTimeout(accept, 20));
    assert.equal((await current.get("experiments").cancel(cancellation.id)).status, "cancelled");
  } finally {
    await booted?.dispose(); for (const response of held) response.destroy(); server.closeAllConnections();
    await new Promise(accept => server.close(accept)); await rm(directory, { recursive: true, force: true });
  }
});
