import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import ApprovalHub from "../dist/approval/service.js";
import {
  COORDINATOR_DELEGATION_TOOL_NAMES,
  CoordinatorContextProvider,
  CoordinatorRuntime,
  DomainCoordinatorStateStore,
  MemoryCoordinatorStateStore,
  createCoordinatorPermissionPolicy,
} from "../dist/coordinator/index.js";
import { createCoordinatorTools } from
  "../dist/coordinator/consumers/model-tools/tools.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import DefaultPermissions from "../dist/permissions/providers/default.js";
import MemoryApprovalRules from
  "../dist/permissions/rules/providers/memory.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";
import LinuxNativeShell from "../dist/shell/providers/linux-native.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

const workspace = Object.freeze({
  requestedRoot: process.cwd(),
  root: process.cwd(),
  fingerprint: "coordinator-acceptance-workspace",
  revision: "coordinator-acceptance-workspace-v1",
  instructions: Object.freeze([]),
});

function subject(stepId) {
  return Object.freeze({
    agentId: "wish",
    sessionId: "session-coordinator",
    runId: "run-coordinator",
    userTurnId: "turn-coordinator",
    stepId,
  });
}

test("Coordinator state is Run-scoped and durably reloadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-coordinator-store-"));
  let revision = 0;
  const kv = new FileKvStorageBackend({
    backendId: "fixture",
    rootDirectory: directory,
    revision: () => `revision-${++revision}`,
  });
  const storage = {
    backend(id) {
      assert.equal(id, "fixture");
      return {
        id,
        capabilities: { writerConcurrency: "process-local", kv: { list: true } },
        kv,
      };
    },
  };
  try {
    const first = new CoordinatorRuntime({
      store: new DomainCoordinatorStateStore({ storage, backendId: "fixture" }),
      now: () => new Date("2026-09-12T12:00:00.000Z"),
    });
    const entered = await first.enter({
      runId: "run-1",
      sessionId: "session-1",
      goal: "Delegate safely",
    });
    assert.equal(entered.active, true);
    assert.equal(entered.version, 1);
    await first.close();

    const second = new CoordinatorRuntime({
      store: new DomainCoordinatorStateStore({ storage, backendId: "fixture" }),
      now: () => new Date("2026-09-12T12:00:01.000Z"),
    });
    const recovered = await second.get({ runId: "run-1" });
    assert.equal(recovered.goal, "Delegate safely");
    const exited = await second.exit({ runId: "run-1", outcome: "Reconciled" });
    assert.equal(exited.active, false);
    assert.equal(exited.outcome, "Reconciled");
    assert.equal(exited.exitedAt, "2026-09-12T12:00:01.000Z");
    await second.close();
  } finally {
    await kv.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Coordinator Context preserves transparent tmux/Subagent ownership", async () => {
  const coordinator = new CoordinatorRuntime({
    store: new MemoryCoordinatorStateStore(),
  });
  const provider = new CoordinatorContextProvider(coordinator);
  const input = {
    runId: "run-coordinator",
    userTurnId: "turn-coordinator",
    stepId: "step-coordinator",
    sessionId: "session-coordinator",
    model: { provider: "fixture", model: "model" },
    workspace: {
      cwd: process.cwd(),
      fingerprint: "workspace",
      revision: "workspace-v1",
      instructions: [],
    },
    runtime: {
      capturedAt: "2026-09-12T12:00:00.000Z",
      stateVersion: 1,
      userTurnOrdinal: 1,
      stepOrdinal: 1,
    },
  };
  assert.deepEqual(await provider.provide(input), []);
  await coordinator.enter({
    runId: input.runId,
    sessionId: input.sessionId,
    goal: "Coordinate",
  });
  const active = await provider.provide(input);
  assert.equal(active.length, 1);
  assert.match(active[0].message.content, /attach to their tmux sessions/u);
  assert.match(active[0].message.content, /do not busy-poll/u);
  assert.match(active[0].message.content, /share the workspace/u);
  await coordinator.exit({ runId: input.runId });
  assert.deepEqual(await provider.provide(input), []);
  await coordinator.close();
});

test("Coordinator allows Subagent controls but hard-blocks direct work and mode overlap", async () => {
  const root = new Context();
  const coordinator = new CoordinatorRuntime({
    store: new MemoryCoordinatorStateStore(),
  });
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  root.approval.register({
    requestApproval() { return { status: "approved" }; },
  });
  await root.plugin(DefaultPermissions);
  root.permissions.registerPolicy(createCoordinatorPermissionPolicy(coordinator));

  const registry = new ToolRegistry();
  for (const definition of createCoordinatorTools(coordinator)) {
    registry.register(definition);
  }
  for (const name of COORDINATOR_DELEGATION_TOOL_NAMES) {
    const read = ["list_agents", "capture_agent", "collect_agent"].includes(name);
    registry.register({
      name,
      description: `fixture ${name}`,
      inputSchemaJson: '{"type":"object"}',
      executionMode: "sequential",
      recoveryPolicy: "retry-safe",
      parse(input) { return { ok: true, input }; },
      resolveCapabilities() {
        return {
          requirements: [{
            capability: read ? "runtime.read" : "runtime.control",
            resources: [`subagents.${read ? "read" : "control"}:fixture`],
          }],
        };
      },
      execute() { return { delegated: name }; },
    });
  }
  registry.register({
    name: "write",
    description: "fixture write",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "sequential",
    recoveryPolicy: "retry-safe",
    parse(input) { return { ok: true, input }; },
    resolveCapabilities() {
      return {
        requirements: [{ capability: "filesystem.write", paths: ["coordinator-test.txt"] }],
      };
    },
    execute() { return { wrote: true }; },
  });
  registry.register({
    name: "enter_plan_mode",
    description: "fixture competing mode",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "sequential",
    recoveryPolicy: "retry-safe",
    parse(input) { return { ok: true, input }; },
    resolveCapabilities() {
      return {
        requirements: [{
          capability: "runtime.control",
          resources: ["plan.enter:session-coordinator"],
        }],
      };
    },
    execute() { return { entered: "plan" }; },
  });
  const executor = new ToolExecutor({ registry, authorization: root.permissions });

  async function permissionsFor(stepId) {
    return root.permissions.resolve({
      subject: subject(stepId),
      workspace,
      registeredTools: registry.list().map((tool) => tool.name),
    });
  }

  async function call(name, input, permissions, snapshot, callId, stepId) {
    const parsed = registry.parseCall({
      id: callId,
      name,
      argumentsJson: JSON.stringify(input),
    });
    assert.equal(parsed.ok, true);
    return executor.execute({
      call: parsed.call,
      context: Object.freeze({ cwd: workspace.root, workspace, permissions }),
      scope: Object.freeze({
        runId: "run-coordinator",
        userTurnId: "turn-coordinator",
        stepId,
      }),
      snapshot,
    });
  }

  try {
    const step1 = await permissionsFor("step-1");
    const snapshot1 = registry.captureSnapshot({
      authorityVersion: step1.authorityVersion,
      availableTools: step1.availableTools,
    });
    const entered = await call(
      "enter_coordinator_mode",
      { goal: "Delegate and reconcile" },
      step1,
      snapshot1,
      "enter-1",
      "step-1",
    );
    assert.equal(entered.ok, true);

    const activeStep = await permissionsFor("active-step");
    assert.equal(activeStep.availableTools.includes("spawn_agent"), true);
    assert.equal(activeStep.availableTools.includes("list_agents"), true);
    assert.equal(activeStep.availableTools.includes("write"), false);
    assert.equal(activeStep.availableTools.includes("enter_plan_mode"), false);

    const delegated = await call(
      "spawn_agent", {}, step1, snapshot1, "spawn-1", "step-1",
    );
    assert.equal(delegated.ok, true);

    const write = await call(
      "write", {}, step1, snapshot1, "write-1", "step-1",
    );
    assert.equal(write.ok, false);
    assert.equal(write.error.code, "permission_denied");

    const overlappingMode = await call(
      "enter_plan_mode", {}, step1, snapshot1, "plan-1", "step-1",
    );
    assert.equal(overlappingMode.ok, false);
    assert.match(overlappingMode.error.message, /Coordinator mode/u);

    const exited = await call(
      "exit_coordinator_mode",
      { outcome: "Children reconciled" },
      step1,
      snapshot1,
      "exit-1",
      "step-1",
    );
    assert.equal(exited.ok, true);
    assert.equal(exited.output.coordinator.active, false);

    const sameStepWrite = await call(
      "write", {}, step1, snapshot1, "write-2", "step-1",
    );
    assert.equal(sameStepWrite.ok, false);

    const step2 = await permissionsFor("step-2");
    const snapshot2 = registry.captureSnapshot({
      authorityVersion: step2.authorityVersion,
      availableTools: step2.availableTools,
    });
    const nextStepWrite = await call(
      "write", {}, step2, snapshot2, "write-3", "step-2",
    );
    assert.equal(nextStepWrite.ok, true);
  } finally {
    await coordinator.close();
    await root.fiber.dispose();
  }
});
