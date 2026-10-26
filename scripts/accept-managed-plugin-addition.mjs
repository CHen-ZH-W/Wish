import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDist = resolve(process.env.WISH_TEST_DIST || join(repository, "dist"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const titleIds = ["session-title-model", "session-title-storage", "session-title-session-feature"];
const requiredIds = ["storage", "sessions", "models", "runtime", "agents", "application", "webui"];
const modelOrigin = "https://managed-addition-fixture.invalid";
const models = JSON.stringify({ schemaVersion: 1, defaultModel: "fixture/model", fallbackModels: [], maxRetries: 0,
  providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: modelOrigin + "/v1", auth: { type: "none" },
    developerRoleMode: "native", models: [{ id: "model", status: "active", contextWindowTokens: 32768,
      maxOutputTokens: 1024, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] });

// Keep the complete shipped business graph in every revision. The legacy
// revision reproduces the incident's app-wide title service isolation.
function profiles(text) {
  const group = /^    - id: session-title\n[\s\S]*?(?=^    - id: |$(?![\s\S]))/mu.exec(text)?.[0];
  assert.ok(group, "the shipped title feature must have a local Group");
  const rows = titleIds.map(id => {
    const row = new RegExp(`^        - id: ${id}\\n[\\s\\S]*?(?=^        - id: |$(?![\\s\\S]))`, "mu").exec(group)?.[0];
    assert.ok(row, `missing local title entry: ${id}`);
    return row.split("\n").map(line => line.startsWith("    ") ? line.slice(4) : line).join("\n");
  });
  const none = text.replace(group, "");
  const legacy = none.replace("  isolate:\n", "  isolate:\n    sessionTitle: true\n    sessionTitleGenerator: true\n")
    .replace("    - id: agent-loop\n", rows.join("") + "    - id: agent-loop\n");
  assert.notEqual(legacy, none);
  return { none, local: text, legacy };
}

async function fixture(run, { breakTitleActivation = false, breakExistingCleanup = false, before = "none", after = "local" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-addition-"));
  const originalFetch = globalThis.fetch;
  const probeKey = `wish-managed-addition:${directory}`;
  const probe = { cleanupCalls: 0, modelCalls: 0, requests: [] };
  globalThis[probeKey] = probe;
  let booted, base;
  const deniedRequests = [];
  try {
    await cp(sourceDist, join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const profile = join(directory, "dist/config/cordis.yml");
    const revisions = profiles(await readFile(profile, "utf8"));
    const next = revisions[after], previous = revisions[before];
    await writeFile(profile, previous);
    if (breakTitleActivation) {
      const filename = join(directory, "dist/session-title/providers/model.js");
      const source = await readFile(filename, "utf8");
      const broken = source.replace("super(ctx);", 'super(ctx); throw new Error("fixture_title_activation_failed");');
      assert.notEqual(broken, source, "fault injection must affect the new title provider");
      await writeFile(filename, broken);
    }
    if (breakExistingCleanup) {
      const filename = join(directory, "dist/filesystem/consumers/model-tools/read-entry.js");
      const source = await readFile(filename, "utf8");
      const broken = source.replace('code: "read_consumer", codeReload: true',
        `code: "read_consumer", codeReload: true, close: () => { globalThis[${JSON.stringify(probeKey)}].cleanupCalls++; throw new Error("fixture_read_cleanup_failed"); }`);
      assert.notEqual(broken, source, "fault injection must affect an existing owner's cleanup");
      await writeFile(filename, broken);
    }
    // No real model, discovery or external HTTP is permitted. Only this test's
    // ephemeral management origin and this in-memory model response are allowed.
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === modelOrigin && url.pathname === "/v1/chat/completions") {
        probe.modelCalls++;
        probe.requests.push(JSON.parse(options.body));
        await probe.modelGate?.promise;
        return new Response('data: {"choices":[{"delta":{"content":"Fixture complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } });
      }
      if (base && url.origin === base) return originalFetch(input, options);
      deniedRequests.push(url.origin + url.pathname);
      throw new Error("external_network_forbidden");
    };
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    const { managedWebUi } = await import(pathToFileURL(join(directory, "dist/apps/webui/host/composition.js")));
    const boot = async () => {
      booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
        environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory,
          WISH_MODELS_JSON: models }, configurationFile: profile,
        management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
      base = booted.context.webManagementHost.url;
      assert.equal(new URL(base).hostname, "127.0.0.1");
    };
    const json = async path => {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      return response.json();
    };
    const snapshot = () => json("/api/management/plugins");
    const post = async (path, input) => {
      const authorization = await json("/api/management/bootstrap");
      const response = await fetch(base + path, { method: "POST", headers: {
        "Content-Type": "application/json", "X-Wish-Management-Token": authorization.token,
      }, body: JSON.stringify(input) });
      const value = await response.json();
      assert.ok(response.status >= 200 && response.status < 300, `${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const diagnostics = async () => {
      const current = await snapshot(), stop = booted.pluginManagement.stops.current();
      const changes = booted.context.pluginChanges.snapshot();
      const operation = value => value && { ...value, entryIds: value.entryIds.length };
      return { management: { status: current.status, configuration: current.configuration,
        pending: current.pending && { ...current.pending, selection: { ...current.pending.selection,
          entryIds: current.pending.selection.entryIds.length }, configuration: current.pending.configuration && {
          ...current.pending.configuration, changes: current.pending.configuration.changes.length } },
        lastReceipt: current.lastReceipt },
        changes: { ...changes, active: operation(changes.active), queued: changes.queued.map(operation), last: operation(changes.last) },
        stop: stop && { id: stop.id, state: stop.state }, bootstrap: await json("/api/management/bootstrap") };
    };
    const until = async (check, label) => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await delay(25);
      }
      assert.fail(`${label}\n${JSON.stringify(await diagnostics())}`);
    };
    const businessAvailable = async () => {
      assert.equal((await json("/api/management/bootstrap")).businessAvailable, true);
      assert.equal((await fetch(base + "/api/health")).status, 200);
      return json("/api/sessions");
    };
    const active = (current, ids) => {
      for (const id of ids) assert.equal(current.inspection.entries.find(entry => entry.id === `include:${id}`)?.phase, "active", id);
    };
    const businessFibers = () => new Map(requiredIds.map(id => [id, booted.context.loader.resolve(`include:${id}`).fiber]));
    const sameBusiness = fibers => {
      for (const [id, fiber] of fibers) assert.equal(booted.context.loader.resolve(`include:${id}`).fiber, fiber, `${id} was unnecessarily rebuilt`);
    };
    const titleContext = () => booted.context.loader.resolve("include:session-title-storage").ctx;
    const profileContext = () => booted.context.loader.resolve("include:agent-profile-application").ctx;
    const runtimeEvents = runId => booted.context.loader.resolve("include:runtime-lifecycle-journal").ctx.get("runtimeLifecycle").readEvents(runId);
    const completeRun = async text => {
      const started = await post("/api/sessions/upgrade-survivor/runs", { text });
      const runId = started.run.runId;
      await until(async () => {
        const value = (await json(`/api/runs/${runId}`)).run;
        return value.status !== "running" && value;
      }, "the primary Run did not finish");
      assert.equal((await json(`/api/runs/${runId}`)).run.status, "completed");
      assert.equal((await runtimeEvents(runId)).filter(event => event.type === "run.completed").length, 1);
      return runId;
    };
    await boot();
    await businessAvailable();
    const initial = await snapshot();
    assert.equal(initial.configuration.watching, true);
    active(initial, requiredIds);
    if (before === "none") for (const id of titleIds) assert.equal(initial.inspection.entries.some(entry => entry.id === `include:${id}`), false);
    else active(initial, titleIds);
    const authorization = await json("/api/management/bootstrap");
    const response = await fetch(base + "/api/sessions", { method: "POST", headers: {
      "Content-Type": "application/json", "X-Wish-Management-Token": authorization.token,
    }, body: JSON.stringify({ sessionId: "upgrade-survivor", workspaceRoot: directory, title: "Preserved title" }) });
    assert.equal(response.status, 201, await response.text());
    await run({ directory, profile, previous, next, revisions, initial, booted, json, post, probe, snapshot, until, active,
      businessFibers, sameBusiness, titleContext, profileContext,
      businessAvailable, diagnostics, runtimeEvents, completeRun,
      restart: async () => { await booted.dispose(); await boot(); },
    });
    assert.deepEqual(deniedRequests, [], "the isolated upgrade must make no external request");
  } finally {
    probe.modelGate?.resolve();
    await booted?.dispose();
    globalThis.fetch = originalFetch;
    delete globalThis[probeKey];
    await rm(directory, { recursive: true, force: true });
  }
}

test("production WebUI adds a local title Group without rebuilding business owners", { timeout: 30_000 }, () => fixture(async f => {
  const business = f.businessFibers();
  await writeFile(f.profile, f.next);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "ready" && current.configuration.phase === "idle" && current.configuration.digest !== f.initial.configuration.digest;
  }, "the full production graph did not finish its title plugin upgrade");
  const current = await f.snapshot();
  assert.equal(current.pending, null);
  assert.equal(current.status, "ready");
  f.active(current, [...requiredIds, ...titleIds]);
  f.sameBusiness(business);
  for (const id of titleIds) assert.equal(current.inspection.entries.find(entry => entry.id === `include:${id}`).parentId, "include:session-title");
  assert.equal(f.booted.surfaceContext.get("sessionTitle"), undefined);
  assert.equal((await f.businessAvailable()).sessions.some(session => session.sessionId === "upgrade-survivor" && session.title === "Preserved title"), true);
  await f.completeRun("Execute after local title addition");
  assert.equal(f.probe.modelCalls, 1);
  await f.restart();
  const restarted = await f.snapshot();
  assert.equal(restarted.pending, null);
  f.active(restarted, [...requiredIds, ...titleIds]);
  assert.equal((await f.businessAvailable()).sessions.some(session => session.sessionId === "upgrade-survivor"), true);
}));

test("an active primary Step survives a local title Group addition", { timeout: 30_000 }, () => fixture(async f => {
  const business = f.businessFibers();
  f.probe.modelGate = Promise.withResolvers();
  const started = await f.post("/api/sessions/upgrade-survivor/runs", { text: "Keep the active Step through title addition" });
  const runId = started.run.runId;
  await f.until(() => f.probe.modelCalls === 1, "the original primary Step did not reach the fixture model");
  await writeFile(f.profile, f.next);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.configuration.phase === "applying" || current.configuration.digest !== f.initial.configuration.digest;
  }, "the watcher did not observe the new title Group while the Step was active");
  assert.equal((await f.json(`/api/runs/${runId}`)).run.status, "running");
  f.sameBusiness(business);
  f.probe.modelGate.resolve();
  await f.until(async () => (await f.json(`/api/runs/${runId}`)).run.status === "completed", "the original primary Run did not complete after the title upgrade");
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "ready" && current.configuration.phase === "idle" && current.configuration.digest !== f.initial.configuration.digest;
  }, "the local title addition did not finish after the primary Step completed");
  f.sameBusiness(business);
  f.active(await f.snapshot(), [...requiredIds, ...titleIds]);
  assert.equal(f.probe.modelCalls, 1);
  assert.equal((await f.runtimeEvents(runId)).filter(event => event.type === "run.completed").length, 1);
  await f.businessAvailable();
}));

test("the legacy app-wide title layout migrates to the local title Group with stable entry IDs", { timeout: 30_000 }, () => fixture(async f => {
  await writeFile(f.profile, f.next);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "ready" && current.configuration.phase === "idle" && current.configuration.digest !== f.initial.configuration.digest;
  }, "the legacy title scope did not migrate to its feature Group");
  const current = await f.snapshot();
  assert.equal(current.pending, null);
  f.active(current, [...requiredIds, ...titleIds]);
  for (const id of titleIds) assert.equal(current.inspection.entries.find(entry => entry.id === `include:${id}`).parentId, "include:session-title");
  assert.equal((await f.businessAvailable()).sessions.some(session => session.sessionId === "upgrade-survivor"), true);
  await f.restart();
  f.active(await f.snapshot(), [...requiredIds, ...titleIds]);
  await f.businessAvailable();
  await f.completeRun("Execute after legacy title migration");
}, { before: "legacy" }));

test("local title configuration and code reload preserve business and reject a failed candidate", { timeout: 30_000 }, () => fixture(async f => {
  const business = f.businessFibers();
  const input = { text: "Title input ".repeat(900), signal: new AbortController().signal };
  const generate = () => f.titleContext().get("sessionTitleGenerator").generate(input);
  await generate();
  const userBytes = () => Buffer.byteLength(f.probe.requests.at(-1).messages.find(message => message.role === "user").content);
  assert.ok(userBytes() > 2048);
  const reconfigured = f.next.replace("maxInputBytes: 4096", "maxInputBytes: 2048");
  assert.notEqual(reconfigured, f.next);
  await writeFile(f.profile, reconfigured);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "ready" && current.configuration.phase === "idle" && current.configuration.digest !== f.initial.configuration.digest;
  }, "title-only configuration did not apply");
  await generate();
  assert.ok(userBytes() <= 2048, "the updated title input limit must affect the next invocation");
  f.sameBusiness(business);
  const filename = join(f.directory, "dist/session-title/providers/model.js");
  const source = await readFile(filename, "utf8");
  const updated = source.replace("selection.reasoningOnly ? 2048 : 512", "selection.reasoningOnly ? 2048 : 257");
  assert.notEqual(updated, source, "the copied provider implementation must change");
  await writeFile(filename, updated);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "ready" && current.codeReload.phase === "succeeded";
  }, "title-only implementation did not hot reload");
  await generate();
  assert.equal(f.probe.requests.at(-1).max_tokens, 257);
  f.sameBusiness(business);
  const failed = updated.replace("super(ctx);", 'super(ctx); throw new Error("fixture_title_candidate_failed");');
  assert.notEqual(failed, updated);
  await writeFile(filename, failed);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "ready" && current.codeReload.phase === "rejected" && current.codeReload.code === "code_reload_candidate_rolled_back";
  }, "failed title implementation did not restore its previous active generation");
  await generate();
  assert.equal(f.probe.requests.at(-1).max_tokens, 257);
  f.sameBusiness(business);
  await f.businessAvailable();
  assert.equal((await f.snapshot()).pending, null);
  await f.completeRun("Execute after title code replacement and rollback");
}, { before: "local" }));

test("a failing newly added title provider restores the previous production WebUI graph", { timeout: 30_000 }, () => fixture(async f => {
  const business = f.businessFibers();
  await writeFile(f.profile, f.next);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.configuration.phase === "rejected" && current.status === "ready";
  },
    "a failed title activation did not roll back to the previous usable graph");
  const rolledBack = await f.snapshot();
  assert.equal(rolledBack.configuration.digest, f.initial.configuration.digest);
  assert.equal(rolledBack.configuration.code, "management_configuration_rolled_back");
  assert.equal(rolledBack.pending, null);
  assert.equal(rolledBack.status, "ready");
  f.active(rolledBack, requiredIds);
  f.sameBusiness(business);
  for (const id of titleIds) assert.equal(rolledBack.inspection.entries.some(entry => entry.id === `include:${id}`), false);
  assert.equal((await f.businessAvailable()).sessions.some(session => session.sessionId === "upgrade-survivor"), true);
  await f.completeRun("Execute after rejected title plugin addition");
}, { breakTitleActivation: true }));

test("legacy app-wide plugin addition retains failed cleanup diagnostics and explicitly recovers after restart", { timeout: 45_000 }, () => fixture(async f => {
  const started = await f.post("/api/sessions/upgrade-survivor/runs", { text: "Complete before the upgrade" });
  const runId = started.run.runId;
  await f.until(async () => (await f.json(`/api/runs/${runId}`)).run.status === "completed", "the pre-upgrade Run did not complete");
  assert.equal(f.probe.modelCalls, 1);
  const originalEvents = await f.runtimeEvents(runId);
  assert.equal(originalEvents.filter(event => event.type === "run.completed").length, 1);
  await writeFile(f.profile, f.next);
  await f.until(async () => {
    const current = await f.snapshot();
    return current.status === "recovery-required" && current.configuration.phase === "recovery-required" &&
      (await f.diagnostics()).changes.active === null;
  }, "the failed old-owner cleanup did not settle");
  const result = await f.diagnostics();
  const stop = result.stop;
  assert.equal(stop.state.phase, "failed", JSON.stringify(result));
  assert.equal(stop.state.code, "stop_cleanup_failed", JSON.stringify(result));
  assert.equal(stop.state.cleanup, "failed");
  assert.equal(result.management.status, "recovery-required", JSON.stringify(result));
  assert.equal(result.management.configuration.phase, "recovery-required");
  assert.notEqual(result.management.pending, null);
  assert.equal(result.changes.last.phase, "recovery-required");
  const failure = result.management.pending.failure;
  assert.deepEqual(failure, { stage: "stop", operationId: stop.id, code: "stop_cleanup_failed", runtime: "changed", cleanup: "failed" });
  assert.equal(f.probe.cleanupCalls, 1);
  await f.restart();
  const quarantined = await f.snapshot();
  assert.equal(quarantined.status, "recovery-required");
  assert.deepEqual(quarantined.pending.failure, failure, "restart must retain the original stop diagnosis");
  assert.equal((await f.json("/api/management/bootstrap")).businessAvailable, false);
  assert.equal(f.probe.cleanupCalls, 1, "restart must not replay the failed old cleanup");
  await f.post("/api/management/plugins/recover-disabled", { revision: quarantined.revision });
  const disabled = await f.snapshot();
  assert.equal(disabled.pending, null);
  assert.equal((await f.json("/api/management/bootstrap")).businessAvailable, false,
    "recover-disabled must leave quarantined business disabled until an explicit restoration");
  const oldActive = f.initial.inspection.entries.filter(entry => entry.kind === "plugin" && entry.managementClass === "managed" && entry.phase === "active").map(entry => entry.id);
  const accepted = await f.post("/api/management/plugins/change", { requestId: randomUUID(), revision: disabled.revision,
    preference: "inherit", selection: { instanceId: disabled.inspection.instanceId, entryIds: oldActive } });
  const completed = await f.until(async () => {
    const value = await f.json(`/api/management/plugins/operations/${accepted.operation.id}`);
    return ["succeeded", "rejected", "recovery-required"].includes(value.operation.phase) && value;
  }, "explicit restoration of the previous active production graph did not settle");
  assert.equal(completed.operation.phase, "succeeded", JSON.stringify(completed));
  await f.until(async () => (await f.snapshot()).status === "ready", "explicit restoration did not release the management transaction");
  const restored = await f.snapshot();
  assert.equal(restored.status, "ready", JSON.stringify(await f.diagnostics()));
  assert.equal(restored.pending, null);
  assert.equal(restored.lastReceipt.status, "succeeded", JSON.stringify(restored.lastReceipt));
  f.active(restored, requiredIds);
  assert.equal((await f.businessAvailable()).sessions.some(session => session.sessionId === "upgrade-survivor"), true);
  assert.deepEqual(await f.runtimeEvents(runId), originalEvents, "the completed Run's durable events must be unchanged after recovery");
  assert.equal(f.probe.modelCalls, 1, "explicit business restoration must not replay the completed Run");
  assert.equal(f.probe.cleanupCalls, 1, "explicit business restoration must not retry the failed old cleanup");
  const nextRunId = await f.completeRun("Execute a new primary Run after explicit business restoration");
  assert.notEqual(nextRunId, runId);
  assert.equal(f.probe.modelCalls, 2, "the recovered generation must execute exactly one new model request");
  assert.deepEqual(await f.runtimeEvents(runId), originalEvents);
}, { breakExistingCleanup: true, after: "legacy" }));

test("the same product artifact reopens a captured AgentProfile and runs again after restart", { timeout: 30_000 }, () => fixture(async f => {
  let ctx = f.profileContext();
  await ctx.get("agentProfiles").register({ schemaVersion: 1, id: "restart-profile", version: 1,
    model: "fixture/model", tools: [], permissionProfile: "read-only", memory: "none",
    reservedOutputTokens: 512, compaction: { keepRecentTokens: 128 } });
  const captured = await ctx.get("agentProfiles").capture("restart-profile@1", await ctx.get("application").resolve());
  const execute = async id => {
    const application = await ctx.get("application").open({ agentProfile: captured.digest });
    try {
      assert.equal(application.executionProfile.digest, captured.digest);
      const session = await application.createSession({ sessionId: id, workspaceRoot: f.directory, title: "Pinned Profile" });
      const run = await application.startRun({ sessionId: session.sessionId, inputSource: "user", payload: { text: "Execute the captured Profile" } });
      assert.equal((await run.completion).status, "completed");
      return run.runId;
    } finally { await application.runGeneration.retire(); }
  };
  const originalRun = await execute("profile-before-restart");
  const originalEvents = await f.runtimeEvents(originalRun);
  await f.restart();
  ctx = f.profileContext();
  assert.equal((await ctx.get("agentProfiles").get(captured.digest)).digest, captured.digest);
  const successorRun = await execute("profile-after-restart");
  assert.notEqual(successorRun, originalRun);
  assert.equal(f.probe.modelCalls, 2);
  assert.deepEqual(await f.runtimeEvents(originalRun), originalEvents);
  const bindings = await ctx.get("agentProfiles").listBindings();
  assert.equal(bindings.filter(binding => binding.snapshotDigest === captured.digest && binding.status === "completed").length, 2);
  await f.businessAvailable();
}, { before: "local" }));
