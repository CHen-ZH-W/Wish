import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symbols } from "@deepseek-ai/cordis";
import { bootstrap } from "../dist/boot/bootstrap.js";

const sameService = (left, right) => (left?.[symbols.original] ?? left) === (right?.[symbols.original] ?? right);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const current = project => project.changes.find(change => change.id === project.activeChangeId) ?? project.changes.at(-1);
const request = project => ({ projectId: project.id, changeId: current(project).id, sessionId: "cordis-wish-owner", expectedRevision: project.revision });
const spec = { objective: "Preserve the user's paper file", scope: ["Inspect and verify the paper file"], outOfScope: ["Network services"], constraints: ["Keep user data"], criteria: [{ id: "preserve", text: "The file remains intact", kind: "technical" }], questions: [], assumptions: ["Local project"], decisions: ["Verify before delivery"], planMarkdown: "Inspect the file, verify preservation, and report the evidence", assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "One bounded local increment" } };

class OwnedApplication {
  inputs = []; controls = []; runs = new Map();
  beforeStart;
  sessionPermissions = { forRun: async () => "workspace-write" };
  constructor(root) { this.root = root; this.runGeneration = { snapshot: () => ({ activeRuns: [...this.runs.values()].filter(run => !run.done).map(run => ({ runId: run.handle.runId, scope: "cordis-wish-owner" })) }) }; }
  async getSession({ sessionId }) { return { sessionId, agentId: "wish", status: "active", scope: this.root }; }
  async startRun(input) {
    assert.equal([...this.runs.values()].some(run => !run.done), false);
    await this.beforeStart?.(input);
    let settle; const completion = new Promise(resolve => { settle = resolve; });
    const handle = { agentId: "wish", runId: input.runId ?? randomUUID(), initialUserTurnId: randomUUID(), scope: input.sessionId, completion };
    this.inputs.push(input); this.runs.set(handle.runId, { handle, settle, done: false }); return handle;
  }
  controlRun(runId, control) {
    this.controls.push({ runId, control }); const run = this.runs.get(runId);
    if (run && !run.done) { run.done = true; run.settle({ runId, status: "aborted" }); }
    return { runId, type: control.type, accepted: true };
  }
}

test("Wish development Cordis consumers cleanly unload, provider restarts retain state, and owned Runs require pause", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-development-cordis-")), workspace = join(directory, "workspace");
  let booted, fake, stage = "bootstrap";
  try {
    await mkdir(workspace); await writeFile(join(workspace, "paper.txt"), "existing user paper\n");
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: workspace, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_STORAGE_FILE_ROOT: join(directory, "storage"), WISH_MEMORY_ENABLED: "0", WISH_SKILLS_ENABLED: "0" },
      management: { directory: join(directory, "management"), async start(_root, control) { control.setRecoveryAvailable(true); return async () => control.setRecoveryAvailable(false); } },
    });
    assert.equal(await booted.completion, 0);
    const deadline = Date.now() + 10000;
    while (!booted.pluginManagement.snapshot().writable) { assert.ok(Date.now() < deadline, "Managed control must become writable"); await delay(10); }
    stage = "inspect initial services";
    const ctx = booted.surfaceContext, root = booted.context;
    const entryId = "include:development", initial = ctx.get("wishDevelopment"); assert.ok(initial);
    const core = { runtime: ctx.get("runEngine"), agents: ctx.get("agents"), application: ctx.get("application"), permissions: ctx.get("permissions"), plan: ctx.get("plan") };
    const toolNames = () => ctx.get("tools").registry.list().map(tool => tool.name);
    const wishControls = () => ctx.get("plan").modeControls().filter(control => control.toolName.startsWith("wish_"));
    const policies = async () => {
      const resolvedWorkspace = await ctx.get("workspace").resolve({ root: workspace });
      return (await ctx.get("permissions").resolve({ workspace: resolvedWorkspace, subject: { agentId: "wish", sessionId: "cordis-wish-owner", runId: "policy-probe", userTurnId: "turn", stepId: "step" }, agent: { profile: "read-only" }, registeredTools: toolNames() })).policies ?? [];
    };
    const change = async (entry, preference) => {
      const before = booted.pluginManagement.snapshot();
      return booted.pluginManagement.change({ requestId: randomUUID(), revision: before.revision, preference, selection: { instanceId: before.inspection.instanceId, entryIds: [entry] } });
    };
    const success = async (entry, preference) => { const result = await change(entry, preference); assert.equal(result.status, "succeeded", JSON.stringify(result)); };
    const assertCore = () => {
      assert.ok(sameService(ctx.get("runEngine"), core.runtime), "service identity must remain stable: ctx.get(\"runEngine\")"); assert.ok(sameService(ctx.get("agents"), core.agents), "service identity must remain stable: ctx.get(\"agents\")"); assert.ok(sameService(ctx.get("application"), core.application), "service identity must remain stable: ctx.get(\"application\")");
      assert.ok(sameService(ctx.get("permissions"), core.permissions), "service identity must remain stable: ctx.get(\"permissions\")"); assert.ok(sameService(ctx.get("plan"), core.plan), "service identity must remain stable: ctx.get(\"plan\")");
      assert.equal(typeof core.agents.open, "function"); assert.equal(typeof core.runtime.lifecycleSnapshot, "function");
    };
    stage = "create durable proposal";
    let project = await initial.begin({ sessionId: "cordis-wish-owner", workspaceRoot: workspace, rawWish: "Preserve my paper", requestId: "cordis-open" });
    project = await initial.propose({ ...request(project), spec });
    const initialSpecDigest = current(project).specs[0].digest;
    fake = new OwnedApplication(workspace);
    const assertUnavailable = async (service, requestId) => {
      const before = await service.state.get(project.id), saved = current(before).specs.at(-1);
      await assert.rejects(service.control(fake, "cordis-wish-owner", { action: "approve-and-start", requestId, projectId: before.id, expectedRevision: before.revision,
        data: { changeId: current(before).id, specVersion: saved.version, specDigest: saved.digest } }), { code: "development_execution_unavailable" });
      const after = await service.state.get(project.id);
      assert.equal(after.revision, before.revision, "Unavailable enforcement must reject before changing confirmation or execution state");
      assert.equal(current(after).confirmations.length, 0); assert.equal(current(after).starts.length, 0);
      assert.equal(fake.inputs.length, 0, "A missing execution guard or verifier must never launch a Run");
      assert.equal((await ctx.get("plan").get({ sessionId: "cordis-wish-owner" })).review.status, "pending");
    };
    assert.equal(wishControls().length, 3); assert.equal((await policies()).filter(policy => policy.id === "wish-development").length, 1);
    for (const name of ["wish_begin", "wish_read", "wish_propose", "wish_verify", "wish_report"]) assert.equal(toolNames().filter(tool => tool === name).length, 1);

    stage = "disable policy consumer";
    await success("include:development-policy", "disabled"); assert.equal((await policies()).some(policy => policy.id === "wish-development"), false); assert.ok(sameService(ctx.get("wishDevelopment"), initial), "service identity must remain stable: ctx.get(\"wishDevelopment\")"); assertCore();
    await assertUnavailable(initial, "missing-policy-guard");
    await success("include:development-policy", "enabled"); assert.equal((await policies()).filter(policy => policy.id === "wish-development").length, 1);
    stage = "disable model tool consumer";
    await success("include:tool-development", "disabled"); assert.equal(wishControls().length, 0); assert.equal(toolNames().some(name => name.startsWith("wish_")), false); assert.ok(sameService(ctx.get("wishDevelopment"), initial), "service identity must remain stable: ctx.get(\"wishDevelopment\")"); assertCore();
    await assertUnavailable(initial, "missing-verification-tools");
    await success("include:tool-development", "enabled"); assert.equal(wishControls().length, 3); assert.equal(toolNames().filter(name => name === "wish_read").length, 1);

    stage = "disable product provider";
    await success(entryId, "disabled"); assert.equal(ctx.get("wishDevelopment"), undefined); assert.equal(wishControls().length, 0); assert.equal(toolNames().some(name => name.startsWith("wish_")), false); assert.equal((await policies()).some(policy => policy.id === "wish-development"), false);
    await assert.rejects(initial.list(), /closed/u); await assert.rejects(initial.state.list(), /closed/u); assertCore();
    stage = "ordinary application without product";
    const ordinary = await core.application.open();
    const ordinarySession = await ordinary.createSession({ sessionId: "ordinary-unmanaged", workspaceRoot: workspace, title: "Ordinary Core remains available" }); assert.equal(ordinarySession.sessionId, "ordinary-unmanaged");
    await success(entryId, "enabled");
    let service = ctx.get("wishDevelopment"); assert.ok(service); assert.equal(sameService(service, initial), false); project = await service.state.get(project.id);
    assert.equal(current(project).specs[0].digest, initialSpecDigest);
    assert.equal(current(project).rawWish, "Preserve my paper"); assert.equal(current(project).starts.length, 0); assert.equal(wishControls().length, 3); assert.equal((await policies()).filter(policy => policy.id === "wish-development").length, 1); assertCore();

    stage = "start owned product run";
    const saved = current(project).specs.at(-1);
    let startingWindowChecks = 0;
    fake.beforeStart = async input => {
      assert.ok(input.runId, "Implementation admission reserves the Run identity before Application starts");
      assert.ok(service.activeRunCount > 0, "An admitted start must be owned while Application is still preparing its handle");
      assert.equal(fake.runs.size, 0, "The lifecycle check must run before any handle is registered");
      assert.equal(fake.inputs.length, 0);
      for (const consumerEntry of ["include:development-policy", "include:tool-development"]) {
        stage = `reject consumer removal before Application returns a handle: ${consumerEntry}`;
        const consumerSelection = { instanceId: booted.pluginManagement.snapshot().inspection.instanceId, entryIds: [consumerEntry] };
        const before = await root.pluginLifecycle.collect(consumerSelection), fiberId = root.loader.resolve(consumerEntry).fiber.uid;
        assert.equal(before.owners.find(owner => owner.fiberId === fiberId)?.status.disposition, "blocked", "Starting work must protect its guard and verification consumers");
        const result = await change(consumerEntry, "disabled"); assert.notEqual(result.status, "succeeded", JSON.stringify(result));
        assert.equal(root.loader.resolve(consumerEntry).fiber.uid, fiberId);
        assert.ok(service.activeRunCount > 0); assert.equal(fake.runs.size, 0); assert.equal(fake.controls.length, 0);
        startingWindowChecks++;
      }
    };
    const started = await service.control(fake, "cordis-wish-owner", { action: "approve-and-start", requestId: "cordis-start", projectId: project.id, expectedRevision: project.revision, data: { changeId: current(project).id, specVersion: saved.version, specDigest: saved.digest } });
    fake.beforeStart = undefined;
    assert.equal(startingWindowChecks, 2, "Both policy and tools must be protected before a Run handle exists");
    project = started.project;
    const selection = { instanceId: booted.pluginManagement.snapshot().inspection.instanceId, entryIds: [entryId] };
    const observation = await root.pluginLifecycle.collect(selection), fiberId = root.loader.resolve(entryId).fiber.uid;
    const provider = observation.owners.find(owner => owner.fiberId === fiberId);
    assert.equal(provider?.status.disposition, "blocked"); assert.equal(provider?.status.code, "wish_development_running");
    const refused = await change(entryId, "disabled"); assert.notEqual(refused.status, "succeeded"); assert.ok(sameService(ctx.get("wishDevelopment"), service), "service identity must remain stable: ctx.get(\"wishDevelopment\")"); assert.equal(fake.controls.length, 0); assert.equal(fake.inputs.length, 1);
    assert.equal(service.activeRunCount, 1);
    for (const consumerEntry of ["include:development-policy", "include:tool-development"]) {
      stage = `reject disabling active execution consumer ${consumerEntry}`;
      const consumerSelection = { instanceId: booted.pluginManagement.snapshot().inspection.instanceId, entryIds: [consumerEntry] };
      const consumerView = await root.pluginLifecycle.collect(consumerSelection), consumerFiberId = root.loader.resolve(consumerEntry).fiber.uid;
      const owner = consumerView.owners.find(item => item.fiberId === consumerFiberId);
      assert.equal(owner?.status.disposition, "blocked", `${consumerEntry} must preserve the active Run's enforcement and evidence capability`);
      const result = await change(consumerEntry, "disabled"); assert.notEqual(result.status, "succeeded", JSON.stringify(result));
      assert.equal(root.loader.resolve(consumerEntry).fiber.uid, consumerFiberId);
      assert.equal(service.activeRunCount, 1); assert.equal(fake.controls.length, 0, "Blocking consumer removal must leave the owned Run running");
      assert.equal((await policies()).filter(policy => policy.id === "wish-development").length, 1);
      for (const name of ["wish_read", "wish_verify", "wish_report"]) assert.equal(toolNames().filter(item => item === name).length, 1);
    }
    stage = "pause owned product run";
    const paused = await service.control(fake, "cordis-wish-owner", { action: "pause", requestId: "cordis-pause", projectId: project.id, expectedRevision: project.revision, data: { changeId: current(project).id } });
    project = paused.project; assert.equal(current(project).phase, "paused"); assert.equal(current(project).starts[0].status, "aborted"); assert.equal(fake.controls.length, 1); assertCore();
    assert.equal(service.activeRunCount, 0);
    stage = "idle consumer removal recovers after active-run veto";
    await success("include:development-policy", "disabled"); assert.equal((await policies()).some(policy => policy.id === "wish-development"), false);
    await success("include:development-policy", "enabled"); assert.equal((await policies()).filter(policy => policy.id === "wish-development").length, 1);
    await success("include:tool-development", "disabled"); assert.equal(wishControls().length, 0); assert.equal(toolNames().some(name => name.startsWith("wish_")), false);
    await success("include:tool-development", "enabled"); assert.equal(wishControls().length, 3);
    for (const name of ["wish_read", "wish_verify", "wish_report"]) assert.equal(toolNames().filter(item => item === name).length, 1);
    await success(entryId, "disabled"); await assert.rejects(service.list(), /closed/u); await success(entryId, "enabled"); service = ctx.get("wishDevelopment"); project = await service.state.get(project.id);
    assert.equal(current(project).phase, "paused"); assert.equal(fake.inputs.length, 1, "Re-enabling a paused provider must not dispatch work");

    stage = "recover an unsubmitted reservation";
    // Model a crash after durable reservation but before Application.startRun.
    const latest = current(project), specRevision = latest.specs.at(-1);
    project = await service.state.confirm({ ...request(project), specVersion: specRevision.version, specDigest: specRevision.digest, actor: "human-recovery-fixture", planApproval: latest.confirmations.at(-1).planApproval });
    project = await service.state.reserveStart({ ...request(project), requestId: "reserved-before-crash", confirmationDigest: current(project).confirmations.at(-1).digest });
    assert.equal(current(project).starts.at(-1).status, "dispatching");
    const previous = service; await success(entryId, "disabled"); await success(entryId, "enabled"); service = ctx.get("wishDevelopment"); project = await service.state.get(project.id);
    assert.equal(current(project).phase, "interrupted"); assert.equal(current(project).starts.at(-1).status, "interrupted"); assert.equal(fake.inputs.length, 1, "Startup recovery must not replay an uncertain reservation");
    await assert.rejects(previous.state.list(), /closed/u); assertCore(); assert.equal((await ordinary.getSession({ sessionId: "ordinary-unmanaged" })).sessionId, "ordinary-unmanaged");
  } catch (error) { throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    for (const run of fake?.runs.values() ?? []) if (!run.done) fake.controlRun(run.handle.runId, { type: "abort" });
    await booted?.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
