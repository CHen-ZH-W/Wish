import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import ApprovalHub from "../dist/approval/service.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import {
  DomainPlanStateStore,
  MemoryPlanStateStore,
  PlanContextProvider,
  PlanRuntime,
  createPlanPermissionPolicy,
} from "../dist/plan/index.js";
import { createPlanTools } from "../dist/plan/consumers/model-tools/tools.js";
import DefaultPermissions from "../dist/permissions/providers/default.js";
import MemoryApprovalRules from
  "../dist/permissions/rules/providers/memory.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";
import LinuxNativeShell from "../dist/shell/providers/linux-native.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

const workspace = Object.freeze({
  requestedRoot: process.cwd(),
  root: process.cwd(),
  fingerprint: "plan-acceptance-workspace",
  revision: "plan-acceptance-workspace-v1",
  instructions: Object.freeze([]),
});

function subject(stepId) {
  return Object.freeze({
    agentId: "wish",
    sessionId: "session-plan",
    runId: "run-plan",
    userTurnId: "turn-plan",
    stepId,
  });
}

test("Plan state is Session-scoped, exact-version approved, and durably reloadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plan-store-"));
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
    const first = new PlanRuntime({
      store: new DomainPlanStateStore({ storage, backendId: "fixture" }),
      now: () => new Date("2026-09-12T12:00:00.000Z"),
    });
    const entered = await first.enter({ sessionId: "session-1", goal: "Ship safely" });
    assert.equal(entered.active, true);
    assert.equal(entered.version, 1);
    const saved = await first.update({ sessionId: "session-1", markdown: "# Plan\n\n1. Verify" });
    assert.equal(saved.document.version, 1);
    assert.match(saved.document.digest, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      first.approve({
        sessionId: "session-1",
        markdown: "# stale",
        expectedPlanVersion: 1,
      }),
      (error) => error.code === "plan_conflict",
    );
    await first.close();

    const second = new PlanRuntime({
      store: new DomainPlanStateStore({ storage, backendId: "fixture" }),
      now: () => new Date("2026-09-12T12:00:01.000Z"),
    });
    const recovered = await second.get({ sessionId: "session-1" });
    assert.equal(recovered.document.markdown, "# Plan\n\n1. Verify");
    const approved = await second.approve({
      sessionId: "session-1",
      markdown: recovered.document.markdown,
      expectedPlanVersion: recovered.document.version,
      summary: "Reviewed",
    });
    assert.equal(approved.active, false);
    assert.equal(approved.document.approvalSummary, "Reviewed");
    assert.equal(approved.exitedAt, "2026-09-12T12:00:01.000Z");
    await second.close();
  } finally {
    await kv.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Plan Context appears only while the durable mode is active", async () => {
  const plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  const provider = new PlanContextProvider(plan);
  const input = {
    runId: "run-plan",
    userTurnId: "turn-plan",
    stepId: "step-plan",
    sessionId: "session-plan",
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
  await plan.enter({ sessionId: "session-plan", goal: "Plan first" });
  const active = await provider.provide(input);
  assert.equal(active.length, 1);
  assert.match(active[0].message.content, /does not start a Workflow/u);
  await plan.update({ sessionId: "session-plan", markdown: "# Plan" });
  await plan.approve({
    sessionId: "session-plan",
    markdown: "# Plan",
    expectedPlanVersion: 1,
  });
  assert.deepEqual(await provider.provide(input), []);
  await plan.close();
});

test("Plan Tools enforce immediate tightening and next-Step-only loosening", async () => {
  const root = new Context();
  const plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  root.approval.register({
    requestApproval() { return { status: "approved" }; },
  });
  await root.plugin(DefaultPermissions);
  root.permissions.registerPolicy(createPlanPermissionPolicy(plan));

  const registry = new ToolRegistry();
  for (const definition of createPlanTools(plan)) registry.register(definition);
  registry.register({
    name: "write",
    description: "fixture write",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "sequential",
    recoveryPolicy: "retry-safe",
    parse(input) { return { ok: true, input }; },
    resolveCapabilities() {
      return { requirements: [{ capability: "filesystem.write", paths: ["plan-test.txt"] }] };
    },
    execute() { return { wrote: true }; },
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
        runId: "run-plan",
        userTurnId: "turn-plan",
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
      "enter_plan_mode",
      { goal: "Make a safe change" },
      step1,
      snapshot1,
      "enter-1",
      "step-1",
    );
    assert.equal(entered.ok, true);

    const blockedWhileActive = await call(
      "write", {}, step1, snapshot1, "write-1", "step-1",
    );
    assert.equal(blockedWhileActive.ok, false);
    assert.equal(blockedWhileActive.error.code, "permission_denied");

    const updated = await call(
      "update_plan",
      { plan: "# Plan\n\n1. Inspect\n2. Change\n3. Verify" },
      step1,
      snapshot1,
      "update-1",
      "step-1",
    );
    assert.equal(updated.ok, true);
    assert.equal(updated.output.plan.document.version, 1);

    const approved = await call(
      "exit_plan_mode",
      {
        plan: updated.output.plan.document.markdown,
        expectedPlanVersion: updated.output.plan.document.version,
        summary: "Ready",
      },
      step1,
      snapshot1,
      "exit-1",
      "step-1",
    );
    assert.equal(approved.ok, true);
    assert.equal(approved.output.plan.active, true);
    assert.equal(approved.output.plan.review.status, "pending");
    await plan.decide({ sessionId: "session-plan", reviewId: approved.output.plan.review.id,
      expectedPlanVersion: 1, digest: approved.output.plan.document.digest,
      decision: "approve", actor: "test-user" });

    const blockedAfterExitSameStep = await call(
      "write", {}, step1, snapshot1, "write-2", "step-1",
    );
    assert.equal(blockedAfterExitSameStep.ok, false);
    assert.match(blockedAfterExitSameStep.error.message, /Plan mode/u);

    const step2 = await permissionsFor("step-2");
    const snapshot2 = registry.captureSnapshot({
      authorityVersion: step2.authorityVersion,
      availableTools: step2.availableTools,
    });
    const allowedNextStep = await call(
      "write", {}, step2, snapshot2, "write-3", "step-2",
    );
    assert.equal(allowedNextStep.ok, true);
  } finally {
    await plan.close();
    await root.fiber.dispose();
  }
});
