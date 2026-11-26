import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../dist/boot/bootstrap.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const disabled of [{}, { WISH_SUBAGENT_WORKFLOW_ENABLED: "0" }, { WISH_SUBAGENT_WORKFLOW_ENABLED: "1" }, { WISH_WORKFLOW_ENABLED: "0" }, { WISH_PLAN_ENABLED: "0" }, { WISH_SUBAGENTS_ENABLED: "0" }, { WISH_TASKS_ENABLED: "0" }, { WISH_WORKFLOW_TOOLS_ENABLED: "0", WISH_SUBAGENT_TOOLS_ENABLED: "0" }]) {
  const directory = await mkdtemp(join(tmpdir(), "wish-workflow-composition-"));
  let boot;
  try {
    boot = await bootstrap({ surface: "cli", argv: ["--version"], cwd: process.cwd(), homeDirectory: directory, environment: { WISH_DATA_DIR: join(directory, "data"), ...disabled } });
    const context = boot.surfaceContext;
    const names = context.get("tools").registry.list().map(tool => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.includes("spawn_agent"), disabled.WISH_SUBAGENTS_ENABLED !== "0" && disabled.WISH_SUBAGENT_TOOLS_ENABLED !== "0");
    const childScheduled = !disabled.WISH_WORKFLOW_ENABLED && !disabled.WISH_SUBAGENTS_ENABLED;
    const graphScheduled = childScheduled && !disabled.WISH_TASKS_ENABLED && !disabled.WISH_PLAN_ENABLED;
    const workflowRead = !disabled.WISH_WORKFLOW_ENABLED && disabled.WISH_WORKFLOW_TOOLS_ENABLED !== "0";
    const workflowControls = childScheduled && disabled.WISH_WORKFLOW_TOOLS_ENABLED !== "0";
    const taskRead = !disabled.WISH_TASKS_ENABLED && disabled.WISH_TASK_TOOLS_ENABLED !== "0";
    assert.equal(context.get("workflowScheduler") !== undefined, childScheduled);
    assert.equal(context.get("workflowGraphScheduler") !== undefined, graphScheduled);
    assert.equal(names.includes("workflow_read"), workflowRead);
    for (const name of ["workflow_cancel", "workflow_retry"]) assert.equal(names.includes(name), workflowControls);
    assert.equal(names.includes("workflow_start"), graphScheduled && disabled.WISH_WORKFLOW_TOOLS_ENABLED !== "0");
    assert.equal(names.includes("tasks_read"), taskRead);
    assert.equal(names.includes("tasks_update"), taskRead && !disabled.WISH_PLAN_ENABLED);
    if (names.includes("spawn_agent")) assert.equal(context.get("subagentToolDispatch").activeStrategy,
      childScheduled ? "workflow" : "direct");
    for (const name of ["enter_coordinator_mode", "read_coordinator", "exit_coordinator_mode"]) {
      assert.equal(names.includes(name), disabled.WISH_COORDINATOR_ENABLED !== "0" && disabled.WISH_COORDINATOR_TOOLS_ENABLED !== "0");
    }
    if (!Object.keys(disabled).length) {
      const plan = context.get("plan"), tasks = context.get("tasks");
      assert.equal(context.get("workflow").state !== undefined, true);
      assert.equal(context.get("workflowScheduler").children !== undefined, true);
      await plan.enter({ sessionId: "test-session" });
      await plan.update({ sessionId: "test-session", markdown: "inspect first" });
      await tasks.replace("test-session", [], 0);
      const permissions = await context.get("permissions").resolve({ subject: { agentId: "wish", sessionId: "test-session", runId: "run", userTurnId: "turn", stepId: "step" },
        workspace: await context.get("workspace").resolve({ root: process.cwd() }), registeredTools: names,
      });
      assert.equal(permissions.availableTools.includes("tasks_update"), true);
      assert.equal(permissions.availableTools.includes("workflow_read"), true);
      assert.equal(permissions.availableTools.includes("workflow_start"), false);
      assert.equal(permissions.delegation.availableTools.includes("write"), false);
      await plan.approve({ sessionId: "test-session", markdown: "inspect first", expectedPlanVersion: 1 });
      await context.get("coordinator").enter({ runId: "run", sessionId: "test-session" });
      const coordinated = await context.get("permissions").resolve({ subject: { agentId: "wish", sessionId: "test-session", runId: "run", userTurnId: "turn", stepId: "step-2" },
        workspace: await context.get("workspace").resolve({ root: process.cwd() }), registeredTools: names,
      });
      assert.equal(coordinated.availableTools.includes("write"), false);
      assert.equal(coordinated.delegation.availableTools.includes("write"), true);
      assert.equal(coordinated.availableTools.includes("workflow_start"), true);
      const limited = await context.get("permissions").resolve({ subject: { agentId: "wish", sessionId: "test-session", runId: "run", userTurnId: "turn", stepId: "step-3" },
        agent: { profile: "read-only", availableTools: ["read"], allowedCapabilities: ["filesystem.read"] },
        workspace: await context.get("workspace").resolve({ root: process.cwd() }), registeredTools: names,
      });
      assert.deepEqual(limited.delegation.availableTools, ["read"]);
      assert.deepEqual(limited.delegation.allowedCapabilities, ["filesystem.read"]);
    }
  } finally { await boot?.context.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
}

{
  const directory = await mkdtemp(join(tmpdir(), "wish-workflow-managed-composition-"));
  const configurationFile = join(directory, "cordis.yml"), adapterId = "include:tool-workflow-subagents";
  const profile = await readFile(new URL("../dist/config/cordis.yml", import.meta.url), "utf8");
  const adapterProfile = "    - id: tool-workflow-subagents\n      name: 'cordis:workflow-subagent-tools'\n      disabled: !!js >-\n" +
    "        launch.environment.WISH_SUBAGENT_TOOLS_ENABLED === '0' ||\n" +
    "        launch.environment.WISH_SUBAGENTS_ENABLED === '0' ||\n" +
    "        launch.environment.WISH_WORKFLOW_ENABLED === '0'\n";
  const previousProfile = profile.replace(adapterProfile,
    `${adapterProfile.trimEnd()} ||\n        launch.environment.WISH_SUBAGENT_WORKFLOW_ENABLED !== '1'\n`);
  assert.notEqual(previousProfile, profile);
  const subagentTools = ["spawn_agent", "list_agents", "capture_agent", "send_agent", "stop_agent", "collect_agent"];
  let boot;
  const start = async flag => {
    boot = await bootstrap({ surface: "cli", argv: ["--version"], cwd: process.cwd(), homeDirectory: directory, configurationFile,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0",
        ...(flag === undefined ? {} : { WISH_SUBAGENT_WORKFLOW_ENABLED: flag }) },
      management: { directory: join(directory, "management"), async start(_root, control) {
        control.setRecoveryAvailable(true);
        return async () => control.setRecoveryAvailable(false);
      } },
    });
    for (let attempt = 0; !boot.pluginManagement.snapshot().writable && attempt < 200; attempt++) await delay(10);
    assert.equal(boot.pluginManagement.snapshot().writable, true);
  };
  const changeAdapter = async preference => {
    const before = boot.pluginManagement.snapshot();
    const receipt = await boot.pluginManagement.change({ requestId: randomUUID(), revision: before.revision, preference,
      selection: { instanceId: before.inspection.instanceId, entryIds: [adapterId] } });
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
  };
  const checkAdapter = (strategy, preference) => {
    const snapshot = boot.pluginManagement.snapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.pending, null);
    assert.equal(snapshot.preferences[adapterId]?.preference, preference);
    assert.equal(snapshot.inspection.entries.find(entry => entry.id === adapterId).phase, strategy === "workflow" ? "active" : "absent");
    assert.equal(boot.surfaceContext.get("subagentToolDispatch").activeStrategy, strategy);
    const names = boot.surfaceContext.get("tools").registry.list().map(tool => tool.name);
    for (const name of subagentTools) assert.equal(names.filter(candidate => candidate === name).length, 1, name);
  };
  try {
    await writeFile(configurationFile, previousProfile);
    await start();
    checkAdapter("direct", undefined);
    await changeAdapter("disabled");
    await boot.dispose();
    await writeFile(configurationFile, profile);
    await start();
    checkAdapter("direct", "disabled"); // Upgrading the deployment retains an explicit disabled choice.
    const baseToolFiber = boot.context.loader.resolve("include:tool-subagents").fiber;
    await changeAdapter("enabled");
    checkAdapter("workflow", "enabled");
    assert.equal(boot.context.loader.resolve("include:tool-subagents").fiber, baseToolFiber);
    await changeAdapter("disabled");
    checkAdapter("direct", "disabled");
    assert.equal(boot.context.loader.resolve("include:tool-subagents").fiber, baseToolFiber);
    await boot.dispose();
    await start("1");
    checkAdapter("direct", "disabled"); // A legacy flag cannot override a saved system switch.
    await changeAdapter("enabled");
    await boot.dispose();
    await start("0");
    checkAdapter("workflow", "enabled");

    for (const entryId of ["include:plan-storage", "include:tasks-storage"]) {
      const before = boot.pluginManagement.snapshot();
      const selection = { instanceId: before.inspection.instanceId, entryIds: [entryId] };
      const disabled = await boot.pluginManagement.change({ requestId: randomUUID(), revision: before.revision, preference: "disabled", selection });
      assert.equal(disabled.status, "succeeded", JSON.stringify(disabled));
      const names = boot.surfaceContext.get("tools").registry.list().map(tool => tool.name);
      assert.equal(names.includes("spawn_agent"), true, `${entryId} must not remove child dispatch`);
      assert.equal(names.includes("workflow_read"), true, `${entryId} must not remove durable Workflow reads`);
      assert.equal(names.includes("workflow_start"), false, `${entryId} must remove graph start admission`);
      if (entryId === "include:plan-storage") {
        assert.equal(names.includes("tasks_read"), true, "Plan removal must retain Tasks reads");
        assert.equal(names.includes("tasks_update"), false, "Plan removal must remove only the Tasks mutation adapter");
      }
      assert.notEqual(boot.surfaceContext.get("workflowScheduler"), undefined);
      assert.equal(boot.surfaceContext.get("workflowGraphScheduler"), undefined);
      const after = boot.pluginManagement.snapshot();
      const enabled = await boot.pluginManagement.change({ requestId: randomUUID(), revision: after.revision, preference: "enabled",
        selection: { instanceId: after.inspection.instanceId, entryIds: [entryId] } });
      assert.equal(enabled.status, "succeeded", JSON.stringify(enabled));
      assert.notEqual(boot.surfaceContext.get("workflowGraphScheduler"), undefined);
      assert.equal(boot.surfaceContext.get("tools").registry.list().some(tool => tool.name === "workflow_start"), true);
    }

    const toolEntry = boot.context.loader.resolve("include:tool-subagents");
    const toolFiber = toolEntry.fiber;
    const cleanupFiber = boot.context.loader.resolve("include:workflow-session-feature").fiber;
    assert.equal(boot.surfaceContext.get("subagentToolDispatch").activeStrategy, "workflow");
    const beforeScheduler = boot.pluginManagement.snapshot();
    const schedulerDisabled = await boot.pluginManagement.change({ requestId: randomUUID(), revision: beforeScheduler.revision, preference: "disabled",
      selection: { instanceId: beforeScheduler.inspection.instanceId, entryIds: ["include:workflow-schedulers"] } });
    assert.equal(schedulerDisabled.status, "succeeded", JSON.stringify(schedulerDisabled));
    assert.equal(boot.context.loader.resolve("include:tool-subagents").fiber, toolFiber);
    assert.equal(boot.context.loader.resolve("include:workflow-session-feature").fiber, cleanupFiber,
      "durable Workflow cleanup remains registered while the Scheduler is unavailable");
    assert.equal(boot.surfaceContext.get("subagentToolDispatch").activeStrategy, "direct");
    const directNames = boot.surfaceContext.get("tools").registry.list().map(tool => tool.name);
    for (const name of subagentTools) assert.equal(directNames.filter(candidate => candidate === name).length, 1, `${name} must remain registered exactly once`);
    assert.equal(directNames.includes("workflow_read"), true, "Scheduler removal must retain durable Workflow reads");
    assert.equal(directNames.includes("workflow_cancel"), false);
    assert.equal(directNames.includes("workflow_retry"), false);

    const afterScheduler = boot.pluginManagement.snapshot();
    const schedulerEnabled = await boot.pluginManagement.change({ requestId: randomUUID(), revision: afterScheduler.revision, preference: "enabled",
      selection: { instanceId: afterScheduler.inspection.instanceId, entryIds: ["include:workflow-schedulers"] } });
    assert.equal(schedulerEnabled.status, "succeeded", JSON.stringify(schedulerEnabled));
    assert.equal(boot.context.loader.resolve("include:tool-subagents").fiber, toolFiber);
    assert.equal(boot.context.loader.resolve("include:workflow-session-feature").fiber, cleanupFiber);
    assert.equal(boot.surfaceContext.get("subagentToolDispatch").activeStrategy, "workflow");
    const restoredNames = boot.surfaceContext.get("tools").registry.list().map(tool => tool.name);
    for (const name of subagentTools) assert.equal(restoredNames.filter(candidate => candidate === name).length, 1, `${name} must restore without duplicate registration`);
    for (const name of ["workflow_read", "workflow_cancel", "workflow_retry"]) assert.equal(restoredNames.filter(candidate => candidate === name).length, 1);
  } finally { await boot?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
console.log("managed Workflow activation, persisted profile upgrades and direct dispatch fallback passed");
