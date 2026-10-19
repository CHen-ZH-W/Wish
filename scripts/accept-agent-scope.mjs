import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";

import { AgentScope, composeAgentScope } from "../dist/composition/agent-scope.js";
import Tools from "../dist/tools/service.js";
import SystemPrompt from "../dist/system-prompt/service.js";
import { SystemPromptContextProvider } from "../dist/system-prompt/consumers/context.js";
import ContextEngine from "../dist/context/service.js";
import Compaction from "../dist/compaction/service.js";
import Agents from "../dist/composition/agent-service.js";
import { parseAgentScopePresets } from "../dist/composition/agent-preset.js";
import WishCliSubagentLauncher, { WishCliSubagentLauncherBackend } from "../dist/apps/cli/subagent-launcher.js";
import { resourceDigest } from "../dist/subagents/resources.js";
import { createLaunch } from "../dist/boot/launch.js";
import { installWishPluginCatalog } from "../dist/boot/plugin-catalog.js";

function tool(name, origin) {
  return {
    name,
    description: origin,
    inputSchemaJson: '{"type":"object","additionalProperties":false}',
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse: input => ({ ok: true, input }),
    resolveCapabilities: () => ({ requirements: [] }),
    execute: () => ({ origin }),
  };
}

test("Agent Scope inherits application and parent contributions while isolating siblings", async () => {
  const root = new Context();
  const application = new AgentScope("application");
  const coder = new AgentScope("coder", application);
  const coderChild = new AgentScope("coder-child", coder);
  const reviewer = new AgentScope("reviewer", application);
  try {
    await root.plugin(Tools);
    await root.plugin(SystemPrompt);
    const contributions = root.plugin({ inject: ["tools", "systemPrompt"], apply(ctx) {
      ctx.tools.register(tool("read", "application"));
      ctx.tools.register(tool("shared", "application"));
      ctx.tools.registerScoped(ctx, coder, tool("private", "coder"));
      ctx.tools.registerScoped(ctx, coder, tool("shared", "coder"));
      ctx.tools.registerScoped(ctx, coderChild, tool("shared", "coder-child"));
      ctx.tools.registerScoped(ctx, reviewer, tool("private", "reviewer"));
      ctx.systemPrompt.register({ id: "base", content: "Application" });
      ctx.systemPrompt.registerScoped(ctx, coder, { id: "base", content: "Coder base" });
      ctx.systemPrompt.registerScoped(ctx, coder, { id: "role", content: "Coder" });
      ctx.systemPrompt.registerScoped(ctx, reviewer, { id: "role", content: "Reviewer" });
      ctx.systemPrompt.registerScoped(ctx, coder, {
        id: "private-guidance", content: "Use private", requiredTools: ["private"],
      });
    } });
    await contributions.await();

    assert.deepEqual(root.tools.registryFor(coder).list().map(item => item.name), ["read", "shared", "private"]);
    assert.deepEqual(root.tools.registryFor(coderChild).list().map(item => item.name), ["read", "shared", "private"]);
    assert.deepEqual(root.tools.registryFor(reviewer).list().map(item => item.name), ["read", "shared", "private"]);
    assert.equal(root.tools.registryFor(coder).describe("shared").description, "coder");
    assert.equal(root.tools.registryFor(coderChild).describe("shared").description, "coder-child");
    assert.equal(root.tools.registryFor(reviewer).describe("shared").description, "application");
    assert.equal(root.tools.registryFor(coder).describe("private").description, "coder");
    assert.equal(root.tools.registryFor(reviewer).describe("private").description, "reviewer");
    const coderRegistry = root.tools.registryFor(coder);
    const initialVersion = coderRegistry.version;
    const transient = root.tools.registry.register(tool("transient", "application"));
    assert.equal(coderRegistry.has("transient"), true);
    assert.ok(coderRegistry.version > initialVersion);
    transient.unregister();
    assert.equal(coderRegistry.has("transient"), false);
    const coderTool = root.tools.registryFor(coder).parseCall({ id: "coder-call", name: "private", argumentsJson: "{}" });
    const reviewerTool = root.tools.registryFor(reviewer).parseCall({ id: "reviewer-call", name: "private", argumentsJson: "{}" });
    assert.equal(coderTool.ok, true);
    assert.equal(reviewerTool.ok, true);
    const coderSections = root.systemPrompt.assemble({ agentScope: coder, availableTools: ["read", "private"] });
    const reviewerSections = root.systemPrompt.assemble({ agentScope: reviewer, availableTools: ["read", "private"] });
    assert.deepEqual(coderSections.map(item => item.id), ["base", "private-guidance", "role"]);
    assert.deepEqual(reviewerSections.map(item => item.id), ["base", "role"]);
    assert.equal(coderSections.find(item => item.id === "role").content, "Coder");
    assert.equal(coderSections.find(item => item.id === "base").content, "Coder base");
    assert.equal(reviewerSections.find(item => item.id === "role").content, "Reviewer");
    assert.equal(reviewerSections.find(item => item.id === "base").content, "Application");
    assert.deepEqual(new SystemPromptContextProvider(root.systemPrompt)
      .provide({ agentScope: reviewer, request: { availableTools: ["read", "private"] } }), []);
    assert.equal(new SystemPromptContextProvider(root.systemPrompt)
      .provide({ agentScope: coder, request: { availableTools: ["read", "private"] } }).length, 1);
    const pinnedPrompt = root.systemPrompt.capture(coder);

    const release = coder.acquire();
    let disposed = false;
    const closing = coder.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false, "an active Step retains its Agent contributions");
    release();
    await closing;
    assert.equal(disposed, true);
    assert.equal(coderRegistry.has("private"), false, "a held Registry releases Agent-owned Tools on disposal");
    assert.deepEqual(root.tools.registryFor(reviewer).list().map(item => item.name), ["read", "shared", "private"]);
    assert.deepEqual(root.tools.registryFor(coder).list().map(item => item.name), ["read", "shared"]);
    assert.deepEqual(root.systemPrompt.assemble({ agentScope: coder, availableTools: ["read"] }).map(item => item.id), ["base"]);
    assert.equal(new SystemPromptContextProvider(root.systemPrompt)
      .provide({ systemPromptSections: pinnedPrompt, request: { availableTools: ["read", "private"] } }).length, 1);
  } finally {
    await application.dispose();
    await root.fiber.dispose();
  }
});

test("Agent Scope owns listeners and aborts background work before cleanup", async () => {
  const scope = new AgentScope("worker");
  const observed = [];
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  scope.listen(() => observed.push("listener removed"));
  const task = scope.run(async signal => {
    entered();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    observed.push("task drained");
  });
  await started;
  await scope.dispose();
  await task;
  assert.deepEqual(observed, ["task drained", "listener removed"]);
  assert.throws(() => scope.run(async () => {}), /closing/u);
});

test("Agent Scope aborts work awaited by a leased Step before waiting for that lease", async () => {
  const scope = new AgentScope("worker");
  const release = scope.acquire();
  let admissionBlocked = false;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const task = scope.run(async signal => {
    await new Promise(resolve => {
      signal.addEventListener("abort", () => {
        try { scope.acquire()(); }
        catch { admissionBlocked = scope.isClosing; }
        resolve();
      }, { once: true });
      entered();
    });
    release();
  });
  await started;
  let timeout;
  try {
    await Promise.race([
      scope.dispose(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Agent Scope disposal deadlocked")), 1000); }),
    ]);
  } finally { clearTimeout(timeout); }
  await task;
  assert.equal(admissionBlocked, true, "abort listeners cannot admit new Scope work");
});

test("a contributing Cordis Fiber unload revokes its scoped registrations", async () => {
  const root = new Context();
  const scope = new AgentScope("reviewer");
  try {
    await root.plugin(Tools);
    await root.plugin(SystemPrompt);
    const fiber = root.plugin({ inject: ["tools", "systemPrompt"], apply(ctx) {
      ctx.tools.registerScoped(ctx, scope, tool("review", "contributor"));
      ctx.systemPrompt.registerScoped(ctx, scope, { id: "review", content: "Review only" });
    } });
    await fiber.await();
    assert.equal(root.tools.registryFor(scope).has("review"), true);
    assert.equal(root.systemPrompt.capture(scope).some(section => section.id === "review"), true);
    await fiber.dispose();
    assert.equal(root.tools.registryFor(scope).has("review"), false);
    assert.equal(root.systemPrompt.capture(scope).some(section => section.id === "review"), false);
  } finally { await scope.dispose(); await root.fiber.dispose(); }
});

test("scoped Tool work drains on Fiber unload and its renderer follows the active contribution", async () => {
  const root = new Context();
  const parent = new AgentScope("application");
  const coder = new AgentScope("coder", parent);
  const reviewer = new AgentScope("reviewer", parent);
  let started;
  let finish;
  const entered = new Promise(resolve => { started = resolve; });
  const unfinished = new Promise(resolve => { finish = resolve; });
  try {
    await root.plugin(Tools);
    const render = root.tools.createResultRenderer({
      render: ({ result }) => ({ role: "tool", content: "fallback", toolCallId: result.callId }),
    }, coder);
    const reviewerRender = root.tools.createResultRenderer({
      render: ({ result }) => ({ role: "tool", content: "fallback", toolCallId: result.callId }),
    }, reviewer);
    const parentFiber = root.plugin({ inject: ["tools"], apply(ctx) {
      ctx.tools.registerScoped(ctx, parent, tool("shared", "parent"), {
        render: ({ result }) => ({ role: "tool", content: "parent", toolCallId: result.callId }),
      });
    } });
    const coderFiber = root.plugin({ inject: ["tools"], apply(ctx) {
      ctx.tools.registerScoped(ctx, coder, {
        ...tool("shared", "coder"),
        execute: async () => { started(); await unfinished; return { origin: "coder" }; },
      });
    } });
    await Promise.all([parentFiber.await(), coderFiber.await()]);
    const input = { call: { status: "ready", id: "call", name: "shared", input: {} },
      result: { ok: true, callId: "call", toolName: "shared", output: {}, phase: "completed" },
      snapshot: {}, signal: new AbortController().signal };
    assert.equal((await render.render(input)).content, "fallback", "a child Tool shadows its parent's renderer");
    assert.equal((await reviewerRender.render(input)).content, "parent");
    const captured = root.tools.registryFor(coder).listDefinitions().find(item => item.name === "shared");
    const executing = captured.execute({}, {}, {}, input.signal);
    await entered;
    let disposed = false;
    const closing = coderFiber.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false, "the contributing Fiber waits for admitted Tool work");
    finish();
    assert.deepEqual(await executing, { origin: "coder" });
    await closing;
    await assert.rejects(() => captured.execute({}, {}, {}, input.signal), /closed/u);
    assert.equal((await render.render(input)).content, "parent", "the same renderer handle resolves the surviving parent");
    await parentFiber.dispose();
    assert.equal((await render.render(input)).content, "fallback");
  } finally { await parent.dispose(); await root.fiber.dispose(); }
});

test("explicit scoped Tool removal still lets Scope disposal drain admitted work", async () => {
  const root = new Context();
  const scope = new AgentScope("worker");
  let started;
  let finish;
  const entered = new Promise(resolve => { started = resolve; });
  const unfinished = new Promise(resolve => { finish = resolve; });
  try {
    await root.plugin(Tools);
    let removal;
    const fiber = root.plugin({ inject: ["tools"], apply(ctx) {
      removal = ctx.tools.registerScoped(ctx, scope, {
        ...tool("slow", "worker"),
        execute: async () => { started(); await unfinished; return "done"; },
      });
    } });
    await fiber.await();
    const registry = root.tools.registryFor(scope);
    const captured = registry.listDefinitions().find(item => item.name === "slow");
    const executing = captured.execute({}, {}, {}, new AbortController().signal);
    await entered;
    assert.equal(removal.unregister(), true);
    assert.equal(registry.has("slow"), false);
    let disposed = false;
    const closing = scope.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    finish();
    assert.equal(await executing, "done");
    await closing;
    assert.equal(registry.has("slow"), false);
  } finally { await scope.dispose(); await root.fiber.dispose(); }
});

test("Compaction resolves the nearest Agent strategy and releases it with the Scope", async () => {
  const root = new Context();
  const parent = new AgentScope("application");
  const coder = new AgentScope("coder", parent);
  const reviewer = new AgentScope("reviewer", parent);
  root.provide("sessions", { open: () => ({}) });
  root.provide("models", {});
  try {
    await root.plugin(Compaction);
    const fiber = root.plugin({ inject: ["compaction"], apply(ctx) {
      ctx.compaction.registerScoped(ctx, parent, { id: "base", open: () => ({ compact: () => "base" }) });
      ctx.compaction.registerScoped(ctx, coder, { id: "coder", open: () => Object.freeze({ compact: () => "coder" }) });
    } });
    await fiber.await();
    const input = { dataDirectory: "/tmp", models: {}, keepRecentTokens: 1, summaryMaxOutputTokens: 1 };
    assert.equal(await root.compaction.open({ ...input, agentScope: coder }).compact({}), "coder");
    assert.equal(await root.compaction.open({ ...input, agentScope: reviewer }).compact({}), "base");
    await coder.dispose();
    assert.equal(await root.compaction.open({ ...input, agentScope: coder }).compact({}), "base");
  } finally { await parent.dispose(); await root.fiber.dispose(); }
});

test("scoped Compaction work drains before its contributing Fiber is disposed", async () => {
  const root = new Context();
  const scope = new AgentScope("coder");
  let started;
  let finish;
  const entered = new Promise(resolve => { started = resolve; });
  const unfinished = new Promise(resolve => { finish = resolve; });
  root.provide("sessions", { open: () => ({}) });
  root.provide("models", {});
  try {
    await root.plugin(Compaction);
    const fiber = root.plugin({ inject: ["compaction"], apply(ctx) {
      ctx.compaction.registerScoped(ctx, scope, { id: "slow", open: () => ({
        compact: async () => { started(); await unfinished; return "done"; },
      }) });
    } });
    await fiber.await();
    const compactor = root.compaction.open({ agentScope: scope, dataDirectory: "/tmp",
      models: {}, keepRecentTokens: 1, summaryMaxOutputTokens: 1 });
    const compacting = compactor.compact({});
    await entered;
    let disposed = false;
    const closing = fiber.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    finish();
    assert.equal(await compacting, "done");
    await closing;
    await assert.rejects(() => compactor.compact({}), /closed/u);
  } finally { await scope.dispose(); await root.fiber.dispose(); }
});

test("Compaction registers multiple Cordis strategies, resolves Agent choices, and drains replacement", async () => {
  const root = new Context();
  const application = new AgentScope("application");
  const coder = new AgentScope("coder", application);
  const child = new AgentScope("child", coder);
  const reviewer = new AgentScope("reviewer", application);
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  root.provide("sessions", { open: () => ({}) });
  root.provide("models", {});
  try {
    await root.plugin(Compaction);
    let calls = 0;
    const providers = root.plugin({ inject: ["compaction"], apply(ctx) {
      ctx.compaction.registerStrategy(ctx, { id: "alpha-v1", open: () => ({ compact: () => "alpha-v1" }) });
      ctx.compaction.registerStrategy(ctx, { id: "beta-v1", open: input => ({
        keepRecentTokens: input.keepRecentTokens,
        async compact() {
          if (++calls === 1) { entered.resolve(); await finish.promise; }
          return `beta-v1:${input.keepRecentTokens}`;
        },
      }) });
    } });
    const selectors = root.plugin({ inject: ["compaction"], apply(ctx) {
      ctx.compaction.selectScoped(ctx, coder, { strategyId: "beta-v1", keepRecentTokens: 7 });
      ctx.compaction.selectScoped(ctx, reviewer, { strategyId: "alpha-v1" });
    } });
    await Promise.all([providers.await(), selectors.await()]);
    const input = { dataDirectory: "/tmp", models: {}, keepRecentTokens: 2, summaryMaxOutputTokens: 1 };
    assert.equal(await root.compaction.open({ ...input, agentScope: reviewer }).compact({}), "alpha-v1");
    const old = root.compaction.open({ ...input, agentScope: coder });
    assert.equal(old.keepRecentTokens, 7);
    const pending = old.compact({});
    await entered.promise;
    let unloaded = false;
    const unloading = providers.dispose().then(() => { unloaded = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unloaded, false, "the Provider Fiber waits for its admitted compaction");
    finish.resolve();
    assert.equal(await pending, "beta-v1:7");
    await unloading;
    await assert.rejects(() => old.compact({}), /closed/u);
    assert.throws(() => root.compaction.open({ ...input, agentScope: coder }), /beta-v1.*unavailable/u);
    const replacement = root.plugin({ inject: ["compaction"], apply(ctx) {
      ctx.compaction.registerStrategy(ctx, { id: "beta-v1", open: input => ({ compact: () => `beta-v2:${input.keepRecentTokens}` }) });
    } });
    await replacement.await();
    assert.equal(await root.compaction.open({ ...input, agentScope: coder }).compact({}), "beta-v2:7");
    const override = root.plugin({ inject: ["compaction"], apply(ctx) {
      ctx.compaction.registerStrategy(ctx, { id: "beta-v1", open: () => ({ compact: () => "child-beta" }) }, child);
    } });
    await override.await();
    assert.equal(await root.compaction.open({ ...input, agentScope: child }).compact({}), "child-beta");
    assert.equal(await root.compaction.open({ ...input, agentScope: coder }).compact({}), "beta-v2:7");
  } finally { finish.resolve(); await application.dispose(); await root.fiber.dispose(); }
});

test("role preset crosses the CLI child boundary with Tool and Memory isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-agent-scope-"));
  const preset = parseAgentScopePresets(JSON.stringify([{ role: "reviewer", availableTools: ["read"],
    prompt: "Review the change", compaction: { keepRecentTokens: 900 }, memory: "none" }]))[0];
  try {
    const launcher = new WishCliSubagentLauncherBackend({ dataDirectory: directory,
      prepareResources: async () => [{ type: "wish.memory.snapshot", schemaVersion: 1, payload: {} }],
    });
    const identity = { id: "child-1", childSessionId: "session-1", childRunId: "run-1" };
    const launch = await launcher.resolve({ parentAgentId: "wish", parentSessionId: "parent-session",
      parentRunId: "parent-run", workspaceRoot: directory, task: "Review", role: "reviewer",
      availableTools: ["read"], allowedCapabilities: ["runtime.read"] }, identity, preset);
    assert.equal(launch.scopePresetDigest, resourceDigest(preset));
    assert.deepEqual(JSON.parse(launch.command.environment.WISH_AGENT_SCOPE_PRESET), preset);
    assert.equal(launch.command.environment.WISH_AVAILABLE_TOOLS, "read");
    assert.equal(launch.command.environment.WISH_MEMORY_ENABLED, "0");
    assert.equal(launch.resourceManifestDigest, undefined);
    assert.throws(() => parseAgentScopePresets('[{"role":"reviewer","availableTools":["read","read"]}]'), /Duplicate/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the production Agent owner installs its child Prompt and Compaction policy", async () => {
  const root = new Context();
  const registered = [];
  root.provide("runEngine", {});
  root.provide("systemPrompt", { registerScoped(_owner, scope, section) { registered.push(["prompt", scope, section]); } });
  root.provide("compaction", { selectScoped(_owner, scope, selection) { registered.push(["compaction", scope, selection]); } });
  const selected = { role: "reviewer", prompt: "Inspect only", compaction: { strategyId: "selective-v2", keepRecentTokens: 321 }, memory: "none" };
  try {
    const fiber = root.plugin(Agents, { childPresetsJson: JSON.stringify([selected]), scopePresetJson: JSON.stringify(selected) });
    await fiber.await();
    assert.deepEqual(root.agents.presetForRole("reviewer"), selected);
    assert.equal(root.agents.scope.agentId, "wish:reviewer");
    assert.equal(registered[0][0], "prompt");
    assert.equal(registered[0][2].content, "Inspect only");
    assert.equal(registered[1][0], "compaction");
    assert.deepEqual(registered[1][2], selected.compaction);
  } finally { await root.fiber.dispose(); }
});

test("Agent unload signals Scope work before waiting for Run retirement", async () => {
  const root = new Context();
  let workStarted;
  const started = new Promise(resolve => { workStarted = resolve; });
  let retired = false;
  root.provide("runEngine", { open({ agentScope }) {
    const releaseStep = agentScope.acquire();
    const work = agentScope.run(signal => new Promise(resolve => {
      workStarted();
      signal.addEventListener("abort", () => { releaseStep(); resolve(); }, { once: true });
    }));
    return { runtime: {}, generation: { async retire() { await work; retired = true; } }, sessions: {}, models: {} };
  } });
  try {
    const fiber = root.plugin(Agents);
    await fiber.await();
    root.agents.open({});
    await started;
    await fiber.dispose();
    assert.equal(retired, true);
    assert.equal(root.agents, undefined);
  } finally { await root.fiber.dispose(); }
});

test("a child-local Tool declaration must be fulfilled by a scoped plugin before the Agent opens", async () => {
  const root = new Context();
  const preset = { role: "specialist", availableTools: ["inspect_patch"],
    localTools: [{ name: "inspect_patch", requires: [] }] };
  const visible = new Set();
  root.provide("runEngine", { open: () => ({ runtime: {}, generation: { retire: async () => {} }, sessions: {}, models: {} }) });
  root.provide("systemPrompt", { registerScoped() {} });
  root.provide("compaction", { selectScoped() {} });
  root.provide("tools", { registryFor: () => ({ has: name => visible.has(name) }) });
  try {
    const fiber = root.plugin(Agents, { scopePresetJson: JSON.stringify(preset) });
    await fiber.await();
    assert.throws(() => root.agents.open({}), /did not register local Tool inspect_patch/u);
    visible.add("inspect_patch");
    assert.equal(root.agents.open({}).agent.definition.id, "wish");
  } finally { await root.fiber.dispose(); }
});

test("role composition narrows authority and excludes unsupported Plan controls before spawn", async () => {
  const root = new Context();
  const reviewer = parseAgentScopePresets(JSON.stringify([{ role: "reviewer", availableTools: ["read", "grep"],
    permissionProfile: "read-only", allowedCapabilities: ["filesystem.read"], memory: "none" }]))[0];
  root.provide("launch", { environment: {} });
  root.provide("sessions", { dataDirectory: "/tmp" });
  root.provide("models", {});
  root.provide("agents", { presetForRole: role => role === "reviewer" ? reviewer :
    role === "coder" ? { role: "coder", permissionProfile: "workspace-write" } :
    role === "limited" ? { role: "limited", permissionProfile: "read-only" } :
    role === "specialist" ? { role: "specialist", availableTools: ["read", "inspect_patch"],
      localTools: [{ name: "inspect_patch", requires: [] }] } : undefined });
  root.provide("tools", { registry: { list: () => ["read", "grep", "write", "bash", "enter_plan_mode"].map(name => ({ name })) },
    getCompositionContracts: () => new Map([["enter_plan_mode", { requires: ["plan.state", "human.review", "session.resume"] }],
      ["bash", { requires: [], requiredCapabilities: ["process.exec"] }],
      ["write", { requires: [], requiredCapabilities: ["filesystem.write"] }]]) });
  try {
    await root.plugin(WishCliSubagentLauncher);
    const request = { parentAgentId: "wish", parentSessionId: "session", parentRunId: "run",
      workspaceRoot: "/tmp", task: "Review", role: "reviewer", permissionProfile: "workspace-write",
      availableTools: ["read", "grep", "write", "bash", "enter_plan_mode"],
      allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"] };
    const composed = root.subagentLauncher.compose(request);
    assert.deepEqual(composed.availableTools, ["read", "grep"]);
    assert.equal(composed.permissionProfile, "read-only");
    assert.deepEqual(composed.allowedCapabilities, ["filesystem.read"]);
    assert.throws(() => root.subagentLauncher.compose({ ...request, role: "worker", availableTools: ["enter_plan_mode"] }), /plan.state/u);
    assert.throws(() => root.subagentLauncher.compose({ ...request, permissionProfile: "read-only", role: "coder" }), /exceeds the parent ceiling/u);
    assert.deepEqual(root.subagentLauncher.compose({ ...request, role: "specialist", availableTools: ["read"] }).availableTools,
      ["read", "inspect_patch"]);
    const limited = root.subagentLauncher.compose({ ...request, role: "limited" });
    assert.deepEqual(limited.availableTools, ["read", "grep"]);
    assert.deepEqual(limited.allowedCapabilities, ["filesystem.read"]);
  } finally { await root.fiber.dispose(); }
});

test("the shipped Loader profile creates distinct parent and CLI child Agent scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-scope-profile-"));
  const configuration = new URL("../config/cordis.yml", import.meta.url);
  const preset = { role: "reviewer", availableTools: ["read"], prompt: "Inspect only",
    compaction: { keepRecentTokens: 321 }, memory: "none" };
  const graphs = [];
  try {
    await mkdir(join(directory, "workspace"));
    for (const child of [false, true]) {
      const root = new Context();
      graphs.push(root);
      const launch = createLaunch({ surface: "cli", argv: child ? ["child"] : ["--version"],
        cwd: join(directory, "workspace"), homeDirectory: directory,
        environment: { WISH_DATA_DIR: join(directory, child ? "child-data" : "parent-data"),
          WISH_STORAGE_FILE_ROOT: join(directory, child ? "child-storage" : "parent-storage"),
          WISH_AGENT_PRESETS_JSON: child ? "" : JSON.stringify([preset]),
          WISH_AGENT_SCOPE_PRESET: child ? JSON.stringify(preset) : "",
          ...(child ? { WISH_MEMORY_ENABLED: "0", WISH_SUBAGENTS_ENABLED: "0" } : {}),
        }, configurationFile: configuration.pathname, configurationSource: "built-in" });
      root.baseUrl = new URL("./", configuration).href;
      root.provide("launch", launch);
      await root.plugin(Loader);
      installWishPluginCatalog(root);
      root.loader.builtins.cli = { inject: ["agents"], apply(ctx) { ctx.launch.complete(0); } };
      await root.loader.create({ id: "include", name: "cordis:include", config: { path: configuration.href } });
      await root.loader.await();
      const agents = root.loader.resolve("include:cli").ctx.get("agents");
      assert.ok(agents);
      if (child) {
        assert.equal(agents.scope.agentId, "wish:reviewer");
        assert.equal(agents.scopePreset.prompt, "Inspect only");
        assert.equal(agents.childPresets.length, 0);
      } else {
        assert.equal(agents.scope.agentId, "wish");
        assert.deepEqual(agents.presetForRole("reviewer"), preset);
      }
    }
  } finally {
    await Promise.allSettled(graphs.reverse().map(root => root.fiber.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agent scoped Context Providers share lifecycle without crossing siblings", async () => {
  const root = new Context();
  const coder = new AgentScope("coder");
  const reviewer = new AgentScope("reviewer");
  root.provide("sessions", { open: () => ({ history: { context: { read: () => [] } } }) });
  root.provide("models", {});
  root.provide("toolResultArchive", { open: () => ({ release: () => true }) });
  await root.plugin(ContextEngine);
  const makeBundle = agentScope => root.contextEngine.open({
    agentScope, dataDirectory: "/tmp/agent-scope-test",
    models: { configuredModel: { getContextWindowTokens: () => 4096 },
      requestCounter: { count: () => ({ inputTokens: 1, method: "fixture" }) } },
    configuration: { reservedOutputTokens: 512 },
  });
  const fiber = root.plugin({ inject: ["contextEngine"], apply(ctx) {
    ctx.contextEngine.registerProvider({ id: "shared", provide: () => [{ id: "application", kind: "reference" }] });
    ctx.contextEngine.registerProviderScoped(ctx, coder, { id: "shared", provide: () => [{ id: "coder-shared", kind: "reference" }] });
    ctx.contextEngine.registerProviderScoped(ctx, coder, { id: "private", provide: () => [{ id: "coder", kind: "reference" }] });
    ctx.contextEngine.registerProviderScoped(ctx, reviewer, { id: "private", provide: () => [{ id: "reviewer", kind: "reference" }] });
  } });
  let coderBundle, reviewerBundle;
  try {
    await fiber.await();
    coderBundle = makeBundle(coder);
    reviewerBundle = makeBundle(reviewer);
    const step = ordinal => ({ snapshot: {
      schemaVersion: 1, capturedAt: "2026-10-18T00:00:00Z", stateVersion: ordinal,
      run: { runId: "run" }, userTurn: { userTurnId: "turn", ordinal: 1 },
      step: { stepId: `step-${ordinal}`, ordinal },
    }, sessionId: "session", model: { provider: "mock", model: "mock" },
    workspace: { cwd: "/workspace", fingerprint: "w", revision: "r", instructions: [] } });
    const coderView = coderBundle.forStep(step(1));
    const reviewerView = reviewerBundle.forStep(step(2));
    assert.deepEqual((await coderView.providers.at(-1).provide(coderView.input)).map(item => item.id), ["coder"]);
    assert.deepEqual((await reviewerView.providers.at(-1).provide(reviewerView.input)).map(item => item.id), ["reviewer"]);
    assert.deepEqual((await coderView.providers.find(item => item.id === "shared").provide(coderView.input)).map(item => item.id), ["coder-shared"]);
    assert.deepEqual((await reviewerView.providers.find(item => item.id === "shared").provide(reviewerView.input)).map(item => item.id), ["application"]);
    await coder.dispose();
    assert.equal(coderBundle.forStep(step(3)).providers.some(item => item.id === "private"), false);
    assert.equal(reviewerBundle.forStep(step(4)).providers.some(item => item.id === "private"), true);
    await fiber.dispose();
    assert.equal(reviewerBundle.forStep(step(5)).providers.some(item => item.id === "private"), false);
  } finally {
    coderBundle?.release();
    reviewerBundle?.release();
    await reviewer.dispose();
    await root.fiber.dispose();
  }
});

test("child Tool composition requires both a resource feature and its capabilities", () => {
  const input = {
    availableTools: ["read", "memory_search", "memory_write"],
    registeredTools: ["read", "memory_search", "memory_write"],
    toolContracts: new Map([
      ["memory_search", { requires: ["memory.snapshot"], requiredCapabilities: ["runtime.read"] }],
      ["memory_write", { requires: ["memory.snapshot"], requiredCapabilities: ["runtime.read", "runtime.control"] }],
    ]),
    runtimeFeatures: [],
    allowedCapabilities: ["runtime.read", "runtime.control"],
  };
  assert.deepEqual(composeAgentScope(input).availableTools, ["read"]);
  assert.throws(() => composeAgentScope({ ...input, requestedTools: ["memory_search"] }), /memory.snapshot/u);
  assert.deepEqual(composeAgentScope({ ...input, runtimeFeatures: ["memory.snapshot"],
    allowedCapabilities: ["runtime.read"] }).availableTools, ["read", "memory_search"]);
  assert.throws(() => composeAgentScope({ ...input, runtimeFeatures: ["memory.snapshot"],
    allowedCapabilities: ["runtime.read"], requestedTools: ["memory_write"] }), /runtime.control/u);
  const executable = { availableTools: ["read", "bash", "write"], registeredTools: ["read", "bash", "write"],
    toolContracts: new Map([["bash", { requires: [], requiredCapabilities: ["process.exec"] }],
      ["write", { requires: [], requiredCapabilities: ["filesystem.write"] }]]),
    runtimeFeatures: [], allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec"] };
  assert.deepEqual(composeAgentScope({ ...executable, permissionProfile: "read-only" }).availableTools, ["read"]);
  assert.deepEqual(composeAgentScope({ ...executable, permissionProfile: "workspace-write" }).availableTools, ["read", "bash", "write"]);
  assert.throws(() => composeAgentScope({ ...executable, permissionProfile: "read-only", requestedTools: ["bash"] }), /read-only child has no approval surface for process\.exec/u);
});
