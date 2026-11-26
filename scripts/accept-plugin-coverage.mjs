import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { headlessManagement } from "../dist/boot/plugin-control/headless-management.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { ToolExecutor } from "../dist/core/tools/scheduler.js";

for (const surface of ["cli", "webui"]) test(`${surface} business owners declare lifecycle and code replacement policy`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-coverage-")); let booted;
  try {
    booted = await bootstrap({ surface, argv: surface === "cli" ? ["--version"] : [], cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0", WISH_WEB_FETCH_ENABLED: "1", WISH_MEMORY_CURATION_ENABLED: "1" },
      management: surface === "webui" ? managedWebUi({ directory: join(directory, "management"), port: 0 }) : {
        directory: join(directory, "management"),
        async start() { return async () => {}; },
      },
    });
    const snapshot = booted.pluginManagement?.snapshot(), inspection = booted.plugins.inspect();
    const owners = inspection.fibers.filter(fiber => fiber.phase === "active" && fiber.entryId &&
      inspection.entries.find(entry => entry.id === fiber.entryId)?.kind === "plugin" &&
      !["include", "include:timer", "include:hmr"].includes(fiber.entryId)); // Native process infrastructure, not Wish owners.
    assert.ok(owners.length >= 60);
    assert.ok(snapshot, "managed bootstrap must expose the Host coverage snapshot");
    const activeEntries = inspection.entries.filter(entry => entry.kind === "plugin" && entry.phase === "active");
    const activeManaged = new Set(activeEntries.filter(entry => entry.managementClass === "managed").map(entry => entry.id));
    const activeManagedFibers = new Set(inspection.fibers.filter(fiber => fiber.phase === "active" &&
      fiber.entryId !== null && activeManaged.has(fiber.entryId)).map(fiber => fiber.id));
    const debt = {
      noncompliant: activeEntries.filter(entry => entry.managementClass === "noncompliant").map(entry => entry.id).sort(),
      compatibility: snapshot.owners.filter(owner => activeManagedFibers.has(owner.fiberId) && owner.declaration !== "canonical")
        .map(owner => owner.fiberId).sort((a, b) => a - b),
      restart: snapshot.protocols.filter(item => activeManaged.has(item.entryId) && item.conformance === "restart")
        .map(item => ({ entryId: item.entryId, stop: item.stop, codeUpdate: item.codeUpdate })).sort((a, b) => a.entryId.localeCompare(b.entryId)),
      incomplete: snapshot.protocols.filter(item => activeManaged.has(item.entryId) && item.conformance === "incomplete")
        .map(item => ({ entryId: item.entryId, stop: item.stop, codeUpdate: item.codeUpdate })).sort((a, b) => a.entryId.localeCompare(b.entryId)),
    };
    assert.deepEqual(snapshot.protocols.find(item => item.entryId === "include:tool-read"), {
      entryId: "include:tool-read", conformance: "online", stop: "online", codeUpdate: "online",
    });
    assert.deepEqual(debt, { noncompliant: [], compatibility: [], restart: [], incomplete: [] },
      `managed plugins must support same-process stop and replacement:\n${JSON.stringify(debt, null, 2)}`);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("CLI plugins can be managed in WebUI without starting a CLI command, including persisted profile upgrades", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-cli-"));
  const configurationFile = join(directory, "cordis.yml");
  const profile = await readFile(new URL("../dist/config/cordis.yml", import.meta.url), "utf8");
  const previousProfile = profile.replace(
    /(\n    - id: (?:cli|candidate-cli|agent-profile-cli)\n      name: '[^']+'\n      disabled: [^\n]+\n)      management:\n        activation: user\n/gu,
    "$1",
  );
  const entryIds = ["include:cli", "include:candidate-cli", "include:agent-profile-cli"].sort();
  let booted, completion, request = 0;
  const boot = async (surface = "webui") => {
    booted = await bootstrap({ surface, argv: ["--version"], cwd: directory, homeDirectory: directory,
      configurationFile,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0" },
      management: surface === "webui"
        ? managedWebUi({ directory: join(directory, "management"), port: 0 })
        : headlessManagement(join(directory, "management")),
    });
    const observed = { settled: false };
    void booted.completion.then(() => { observed.settled = true; }, () => { observed.settled = true; });
    completion = observed;
  };
  const change = async preference => {
    const before = booted.pluginManagement.snapshot();
    const receipt = await booted.pluginManagement.change({ requestId: `cli-activation-${++request}`,
      revision: before.revision, preference,
      selection: { instanceId: before.inspection.instanceId, entryIds },
    });
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
  };
  const check = async (phase, preference) => {
    await nextTurn();
    const snapshot = booted.pluginManagement.snapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.pending, null);
    for (const id of entryIds) {
      assert.equal(snapshot.inspection.entries.find(entry => entry.id === id)?.phase, phase, id);
      assert.equal(snapshot.preferences[id]?.preference, preference, id);
      if (phase === "active") {
        assert.equal(snapshot.controls[id]?.canDisable, true, id);
        assert.equal(snapshot.protocols.find(protocol => protocol.entryId === id)?.conformance, "online", id);
      }
    }
    assert.equal(completion.settled, false, "loading or stopping CLI plugins must not complete the WebUI process");
    assert.equal((await fetch(booted.context.webManagementHost.url + "/api/health")).status, 200);
  };
  try {
    await writeFile(configurationFile, previousProfile);
    await boot("cli");
    assert.equal(await booted.completion, 0);
    await change("disabled");
    await booted.dispose();

    // Keep the existing management store when the deployment delegates activation.
    await writeFile(configurationFile, profile);
    await boot();
    await check("absent", "disabled");
    await change("inherit");
    await check("absent", undefined);
    const initial = booted.pluginManagement.snapshot();
    for (const id of entryIds) assert.equal(initial.controls[id]?.canEnable, true, id);
    const ctx = booted.surfaceContext;
    let dispatched = 0;
    ctx.on("cli/command", () => { dispatched++; });
    const stdinListeners = process.stdin.eventNames().map(name => [name, process.stdin.listenerCount(name)]);
    await change("enabled");
    await check("active", "enabled");
    assert.equal(dispatched, 0, "WebUI activation must not dispatch launch.argv as a CLI command");
    assert.deepEqual(process.stdin.eventNames().map(name => [name, process.stdin.listenerCount(name)]), stdinListeners);

    const signal = new AbortController().signal;
    for (const prefix of ["candidate", "profile", "experiment"]) {
      let output = "";
      const terminal = { async writeOutput(value) { output += value; }, async writeError() {} };
      const operation = ctx.bail("cli/command", [prefix, "list"], terminal, signal);
      assert.ok(operation, `${prefix} command handler must be registered`);
      assert.equal(await operation, 0);
      assert.deepEqual(JSON.parse(output), []);
    }
    await change("disabled");
    await check("absent", "disabled");
    for (const prefix of ["candidate", "profile", "experiment"]) {
      assert.equal(ctx.bail("cli/command", [prefix, "list"], {}, signal), undefined);
    }
    await change("enabled");
    await booted.dispose();
    await boot();
    await check("active", "enabled");
    await change("disabled");
    await booted.dispose();
    await boot();
    await check("absent", "disabled");
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("candidate tools follow managed activation while staying unavailable to every current Agent mode", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-tool-policy-"));
  const configurationFile = join(directory, "cordis.yml"), entryId = "include:candidate-tools";
  const profile = await readFile(new URL("../dist/config/cordis.yml", import.meta.url), "utf8");
  const previousProfile = profile.replace("    - id: candidate-tools\n      name: 'cordis:candidate-tools'\n",
    "    - id: candidate-tools\n      name: 'cordis:candidate-tools'\n      disabled: !!js launch.environment.WISH_CANDIDATE_TOOLS !== '1'\n");
  const names = ["candidate_submit", "candidate_validate", "candidate_evaluate"];
  let booted, request = 0;
  const boot = async flag => {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory, configurationFile,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0",
        ...(flag === undefined ? {} : { WISH_CANDIDATE_TOOLS: flag }),
      }, management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
  };
  const change = async preference => {
    const before = booted.pluginManagement.snapshot();
    assert.equal((await booted.pluginManagement.change({ requestId: `candidate-tools-${++request}`,
      revision: before.revision, preference, selection: { instanceId: before.inspection.instanceId, entryIds: [entryId] },
    })).status, "succeeded");
    await nextTurn();
  };
  const phase = () => booted.plugins.inspect().entries.find(entry => entry.id === entryId).phase;
  const checkVisibility = async () => {
    const ctx = booted.surfaceContext, registry = ctx.get("tools").registry;
    const workspace = { requestedRoot: directory, root: directory, fingerprint: "candidate-workspace", revision: "v1", instructions: [] };
    const executor = new ToolExecutor({ registry, authorization: ctx.get("permissions") });
    assert.equal(phase(), "active");
    assert.equal(booted.pluginManagement.snapshot().protocols.find(item => item.entryId === entryId).conformance, "online");
    for (const name of names) assert.equal(registry.has(name), true, "enabled plugin owns its Tool definitions");
    for (const mode of ["normal", "plan", "coordinator"]) {
      const subject = { agentId: "wish", sessionId: `session-${mode}`, runId: `run-${mode}`, userTurnId: "turn-1", stepId: "step-1" };
      if (mode === "plan") await ctx.get("plan").enter({ sessionId: subject.sessionId });
      if (mode === "coordinator") await ctx.get("coordinator").enter({ sessionId: subject.sessionId, runId: subject.runId });
      // Even an explicit Tool allowlist and full-access permission cannot expose them.
      const permissions = await ctx.get("permissions").resolve({ agent: { profile: "full-access", availableTools: ["read", ...names] },
        subject, workspace, registeredTools: registry.list().map(tool => tool.name),
      });
      assert.deepEqual(permissions.availableTools, ["read"], mode);
      assert.deepEqual(permissions.delegation.availableTools, ["read"], `${mode} child delegation`);
      const snapshot = registry.captureSnapshot({ authorityVersion: permissions.authorityVersion, availableTools: permissions.availableTools });
      assert.deepEqual(registry.listForSnapshot(snapshot).map(tool => tool.name), ["read"], `${mode} model input`);
      for (const name of names) {
        const parsed = registry.parseCall({ id: `${mode}-${name}`, name, argumentsJson: '{"request":{}}' });
        assert.equal(parsed.ok, true);
        const result = await executor.execute({ call: parsed.call, context: { cwd: directory, workspace, permissions }, snapshot,
          scope: { runId: subject.runId, userTurnId: subject.userTurnId, stepId: subject.stepId },
        });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "permission_denied", `${mode} cannot dispatch ${name}`);
      }
      if (mode === "plan") await ctx.get("plan").clear({ sessionId: subject.sessionId });
      if (mode === "coordinator") await ctx.get("coordinator").clear({ sessionId: subject.sessionId, runId: subject.runId });
    }
    assert.deepEqual(await ctx.get("candidates").list(), []);
  };
  try {
    await writeFile(configurationFile, previousProfile);
    await boot();
    assert.equal(phase(), "absent");
    await change("disabled");
    await booted.dispose();
    await writeFile(configurationFile, profile);
    await boot();
    assert.equal(phase(), "absent", "deployment upgrade preserves the saved disabled choice");
    await change("enabled");
    await checkVisibility();
    await booted.dispose();
    await boot("0");
    await checkVisibility();
    await change("disabled");
    assert.equal(phase(), "absent");
    for (const name of names) assert.equal(booted.surfaceContext.get("tools").registry.has(name), false);
    await booted.dispose();
    await boot("1");
    assert.equal(phase(), "absent", "legacy environment cannot override the system switch");
    await change("enabled");
    await checkVisibility();
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
