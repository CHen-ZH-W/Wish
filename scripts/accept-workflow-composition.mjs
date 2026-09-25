import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../dist/boot/bootstrap.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const disabled of [{}, { WISH_WORKFLOW_ENABLED: "0" }, { WISH_PLAN_ENABLED: "0" }, { WISH_SUBAGENTS_ENABLED: "0" }, { WISH_TASKS_ENABLED: "0" }, { WISH_WORKFLOW_TOOLS_ENABLED: "0", WISH_SUBAGENT_TOOLS_ENABLED: "0" }]) {
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
  let boot;
  try {
    boot = await bootstrap({ surface: "cli", argv: ["--version"], cwd: process.cwd(), homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0" },
      management: { directory: join(directory, "management"), async start(_root, control) {
        control.setRecoveryAvailable(true);
        return async () => control.setRecoveryAvailable(false);
      } },
    });
    for (let attempt = 0; !boot.pluginManagement.snapshot().writable && attempt < 200; attempt++) await delay(10);
    assert.equal(boot.pluginManagement.snapshot().writable, true);
    for (const entryId of ["include:plan-storage", "include:tasks-storage"]) {
      const before = boot.pluginManagement.snapshot();
      const selection = { instanceId: before.inspection.instanceId, entryIds: [entryId] };
      const disabled = await boot.pluginManagement.change({ requestId: randomUUID(), revision: before.revision, preference: "disabled", selection });
      assert.equal(disabled.status, "succeeded", JSON.stringify(disabled));
      const names = boot.surfaceContext.get("tools").registry.list().map(tool => tool.name);
      assert.equal(names.includes("spawn_agent"), true, `${entryId} must not remove direct child Workflow dispatch`);
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
    const subagentTools = ["spawn_agent", "list_agents", "capture_agent", "send_agent", "stop_agent", "collect_agent"];
    assert.equal(boot.surfaceContext.get("subagentToolDispatch").activeStrategy, "workflow");
    const beforeScheduler = boot.pluginManagement.snapshot();
    const schedulerDisabled = await boot.pluginManagement.change({ requestId: randomUUID(), revision: beforeScheduler.revision, preference: "disabled",
      selection: { instanceId: beforeScheduler.inspection.instanceId, entryIds: ["include:workflow-schedulers"] } });
    assert.equal(schedulerDisabled.status, "succeeded", JSON.stringify(schedulerDisabled));
    assert.equal(boot.context.loader.resolve("include:tool-subagents").fiber, toolFiber);
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
    assert.equal(boot.surfaceContext.get("subagentToolDispatch").activeStrategy, "workflow");
    const restoredNames = boot.surfaceContext.get("tools").registry.list().map(tool => tool.name);
    for (const name of subagentTools) assert.equal(restoredNames.filter(candidate => candidate === name).length, 1, `${name} must restore without duplicate registration`);
    for (const name of ["workflow_read", "workflow_cancel", "workflow_retry"]) assert.equal(restoredNames.filter(candidate => candidate === name).length, 1);
  } finally { await boot?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
console.log("default and opt-out workflow composition passed");
