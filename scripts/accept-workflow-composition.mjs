import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../dist/boot/bootstrap.js";

for (const disabled of [{}, { WISH_WORKFLOW_ENABLED: "0" }, { WISH_PLAN_ENABLED: "0" }, { WISH_SUBAGENTS_ENABLED: "0" }, { WISH_TASKS_ENABLED: "0" }, { WISH_WORKFLOW_TOOLS_ENABLED: "0", WISH_SUBAGENT_TOOLS_ENABLED: "0" }]) {
  const directory = await mkdtemp(join(tmpdir(), "wish-workflow-composition-"));
  let boot;
  try {
    boot = await bootstrap({ surface: "cli", argv: ["--version"], cwd: process.cwd(), homeDirectory: directory, environment: { WISH_DATA_DIR: join(directory, "data"), ...disabled } });
    const context = boot.surfaceContext;
    const names = context.get("tools").registry.list().map(tool => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.includes("spawn_agent"), disabled.WISH_SUBAGENTS_ENABLED !== "0" && disabled.WISH_SUBAGENT_TOOLS_ENABLED !== "0");
    const scheduled = !disabled.WISH_WORKFLOW_ENABLED && !disabled.WISH_TASKS_ENABLED && !disabled.WISH_PLAN_ENABLED && !disabled.WISH_SUBAGENTS_ENABLED;
    assert.equal(names.includes("workflow_start"), scheduled && disabled.WISH_WORKFLOW_TOOLS_ENABLED !== "0");
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
console.log("default and opt-out workflow composition passed");
