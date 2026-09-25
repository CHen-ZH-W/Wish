import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrap } from "../dist/boot/bootstrap.js";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const owner = Object.freeze({ parentAgentId: "wish", parentSessionId: "session", parentRunId: "run", workspaceRoot: process.cwd() });

function affectedEntries(inspection, entryId) {
  const impact = inspection.previewDisable(entryId);
  return new Set(impact.affected.map(({ fiberId }) =>
    impact.snapshot.fibers.find(fiber => fiber.id === fiberId)?.entryId).filter(Boolean));
}

function assertImpact(inspection, entryId, { includes = [], excludes = [] }) {
  const affected = affectedEntries(inspection, entryId);
  for (const id of includes) assert.equal(affected.has(id), true, `${entryId} must affect ${id}`);
  for (const id of excludes) assert.equal(affected.has(id), false, `${entryId} must not affect ${id}`);
}

const directory = await mkdtemp(join(tmpdir(), "wish-plugin-decoupling-"));
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
  const root = boot.context, ctx = boot.surfaceContext, inspection = root.pluginInspection;
  const tools = () => ctx.get("tools").registry.list().map(tool => tool.name);
  const change = async (entryId, preference) => {
    const before = boot.pluginManagement.snapshot();
    const receipt = await boot.pluginManagement.change({ requestId: randomUUID(), revision: before.revision, preference,
      selection: { instanceId: before.inspection.instanceId, entryIds: [entryId] } });
    assert.equal(receipt.status, "succeeded", `${entryId} ${preference}: ${JSON.stringify(receipt)}`);
  };

  assertImpact(inspection, "include:plan-storage", {
    includes: ["include:plan-mode-adapters", "include:tool-tasks-update"],
    excludes: ["include:tasks-storage", "include:tool-tasks", "include:workflow-schedulers"],
  });
  assertImpact(inspection, "include:workflow-schedulers", {
    includes: ["include:tool-workflow-controls", "include:workflow-session-feature"],
    excludes: ["include:tool-workflow", "include:tool-subagents"],
  });
  assertImpact(inspection, "include:context-engine", {
    includes: ["include:plan-mode-adapters", "include:coordinator-mode-adapters"],
    excludes: ["include:plan-storage", "include:coordinator-storage"],
  });
  assertImpact(inspection, "include:permissions-default", {
    includes: ["include:plan-mode-adapters", "include:coordinator-mode-adapters"],
    excludes: ["include:plan-storage", "include:coordinator-storage"],
  });
  assertImpact(inspection, "include:subagent-launcher-cli", {
    excludes: ["include:subagents-runtime", "include:tool-subagents"],
  });
  assertImpact(inspection, "include:subagents-runtime", {
    includes: ["include:workflow-schedulers", "include:tool-subagents"],
    excludes: ["include:coordinator-storage", "include:tool-coordinator"],
  });

  const plan = ctx.get("plan"), planFiber = root.loader.resolve("include:plan-storage").fiber;
  await plan.enter({ sessionId: "durable-plan" });
  await plan.update({ sessionId: "durable-plan", markdown: "Keep state separate from projections" });
  await plan.approve({ sessionId: "durable-plan", markdown: "Keep state separate from projections", expectedPlanVersion: 1 });
  await change("include:plan-mode-adapters", "disabled");
  assert.ok(root.loader.resolve("include:plan-storage").fiber === planFiber);
  assert.equal((await plan.get({ sessionId: "durable-plan" })).document.markdown, "Keep state separate from projections");
  await change("include:plan-mode-adapters", "enabled");

  const coordinator = ctx.get("coordinator"), coordinatorFiber = root.loader.resolve("include:coordinator-storage").fiber;
  await coordinator.enter({ runId: "durable-coordinator", sessionId: "session", goal: "Keep state separate from projections" });
  await coordinator.exit({ runId: "durable-coordinator" });
  await change("include:coordinator-mode-adapters", "disabled");
  assert.ok(root.loader.resolve("include:coordinator-storage").fiber === coordinatorFiber);
  assert.equal((await coordinator.get({ runId: "durable-coordinator" })).active, false);
  await change("include:coordinator-mode-adapters", "enabled");

  assert.ok(ctx.get("plan").modeControls().some(control => control.toolName === "tasks_read"));
  await change("include:tasks-plan-controls", "disabled");
  assert.equal(ctx.get("plan").modeControls().some(control => control.toolName === "tasks_read" || control.toolName === "tasks_update"), false);
  await change("include:tasks-plan-controls", "enabled");
  assert.equal(ctx.get("plan").modeControls().filter(control => control.toolName === "tasks_read").length, 1);

  const subagents = ctx.get("subagents"), subagentsFiber = root.loader.resolve("include:subagents-runtime").fiber;
  await change("include:subagent-launcher-cli", "disabled");
  assert.ok(root.loader.resolve("include:subagents-runtime").fiber === subagentsFiber);
  assert.deepEqual(await subagents.list(owner), []);
  await assert.rejects(subagents.spawn({ ...owner, task: "Must not launch without a launcher" }), /launch capability is unavailable/u);
  await change("include:subagent-launcher-cli", "enabled");

  await coordinator.enter({ runId: "coordinator-without-subagents", sessionId: "session", goal: "Retain control state" });
  await change("include:subagents-runtime", "disabled");
  assert.equal(ctx.get("subagents"), undefined);
  assert.ok(root.loader.resolve("include:coordinator-storage").fiber === coordinatorFiber);
  assert.equal((await coordinator.get({ runId: "coordinator-without-subagents" })).active, true);
  for (const name of ["enter_coordinator_mode", "read_coordinator", "exit_coordinator_mode"]) assert.equal(tools().includes(name), true);
  await coordinator.exit({ runId: "coordinator-without-subagents" });
  await change("include:subagents-runtime", "enabled");
  assert.notEqual(ctx.get("subagents"), undefined);
} finally {
  await boot?.dispose();
  await rm(directory, { recursive: true, force: true });
}

console.log("optional plugin dependency decoupling passed");
