import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ToolExecutor, ToolRegistry } from
  "../dist/core/tools/scheduler.js";
import {
  buildRuntimeLifecycleStartupSnapshot,
  JournalRuntimeLifecycleAuthority,
  RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
} from "../dist/core/runtime/durability/index.js";
import JournalRuntimeLifecycleProvider from
  "../dist/core/runtime/durability/providers/journal.js";
import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from
  "../dist/storage/providers/file/backend.js";
import FileStorageProvider from
  "../dist/storage/providers/file/plugin.js";

let fixtureId = 0;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-runtime-durability-"));
  const backendId = `runtime-${++fixtureId}`;
  const open = () => {
    const backend = new FileStorageBackend({
      id: backendId,
      rootDirectory: directory,
    });
    const authority = new JournalRuntimeLifecycleAuthority({
      backendId,
      journal: backend.journal.open({
        namespace: RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
      }),
    });
    return { authority, backend };
  };
  return {
    directory,
    open,
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Runtime lifecycle records boundaries without retaining Tool payloads", async () => {
  const state = await fixture();
  let current = state.open();
  try {
    const { run, turn, step } = snapshots("run-private");
    const call = readyCall("call-private", "danger", {
      secret: "must-not-be-persisted",
    });
    const descriptor = toolDescriptor("danger", "needs-reconciliation");
    await current.authority.openRun(run);
    await current.authority.openUserTurn({ run, userTurn: turn });
    await current.authority.openStep(step);
    await current.authority.prepare({
      call,
      descriptor,
      context: { secretContext: "must-not-be-persisted" },
      scope: toolScope(step),
      snapshot: toolSnapshot(),
    });
    await current.authority.markDispatched({
      call,
      descriptor,
      context: {},
      scope: toolScope(step),
      snapshot: toolSnapshot(),
      grant: { grantId: "grant-private" },
    });
    await current.authority.finish({
      call,
      descriptor,
      context: {},
      scope: toolScope(step),
      snapshot: toolSnapshot(),
      result: {
        ok: true,
        callId: call.id,
        toolName: call.name,
        output: { secretOutput: "must-not-be-persisted" },
        phase: "completed",
      },
    });
    await current.authority.finishStep({
      snapshot: step,
      status: "completed",
      reason: "complete",
    });
    await current.authority.finishUserTurn({
      run,
      userTurn: turn,
      status: "completed",
    });
    await current.authority.finishRun({ snapshot: run, status: "completed" });

    const events = await current.authority.readEvents(run.runId);
    assert.deepEqual(events.map((event) => event.type), [
      "run.opened",
      "user_turn.opened",
      "step.opened",
      "tool.prepared",
      "tool.dispatched",
      "tool.completed",
      "step.completed",
      "user_turn.completed",
      "run.completed",
    ]);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("must-not-be-persisted"), false);
    assert.match(events[3].callFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.match(events[5].resultFingerprint, /^sha256:[a-f0-9]{64}$/u);
    await assert.rejects(
      current.authority.recoverInterrupted(),
      /must run before admitting lifecycle work/u,
    );
  } finally {
    await current.authority.close();
    await current.backend.close();
    await state.dispose();
  }
});

test("Core ToolExecutor commits prepared and dispatched before execution", async () => {
  const state = await fixture();
  const current = state.open();
  let executions = 0;
  try {
    const { run, turn, step } = snapshots("run-executor");
    await current.authority.openRun(run);
    await current.authority.openUserTurn({ run, userTurn: turn });
    await current.authority.openStep(step);

    const registry = new ToolRegistry();
    registry.register({
      name: "effect",
      description: "one effect",
      inputSchemaJson: "{}",
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
      parse(input) {
        return { ok: true, input };
      },
      resolveCapabilities() {
        return { requirements: [] };
      },
      async execute(input) {
        executions += 1;
        const events = await current.authority.readEvents(run.runId);
        assert.equal(events.at(-1).type, "tool.dispatched");
        return input;
      },
    });
    const executor = new ToolExecutor({
      registry,
      lifecycle: current.authority,
      authorization: {
        authorize: () => ({ status: "allowed", policyVersion: "policy-v1" }),
        revalidate: () => ({ status: "valid", policyVersion: "policy-v1" }),
      },
      grantId: () => "executor-grant",
    });
    const result = await executor.execute({
      call: readyCall("executor-call", "effect", { value: "private" }),
      context: {},
      scope: toolScope(step),
      snapshot: registry.captureSnapshot({ authorityVersion: "authority-v1" }),
    });
    assert.equal(result.ok, true);
    assert.equal(executions, 1);
    assert.deepEqual(
      (await current.authority.readEvents(run.runId)).slice(-3).map((event) =>
        event.type
      ),
      ["tool.prepared", "tool.dispatched", "tool.completed"],
    );
  } finally {
    await current.authority.close();
    await current.backend.close();
    await state.dispose();
  }
});

test("Runtime recovery classifies interrupted Tools and never replays them", async () => {
  const state = await fixture();
  let current = state.open();
  let toolExecutions = 0;
  try {
    const { run, turn, step } = snapshots("run-interrupted");
    await current.authority.openRun(run);
    await current.authority.openUserTurn({ run, userTurn: turn });
    await current.authority.openStep(step);

    const cases = [
      ["prepared", "needs-reconciliation", false],
      ["resumable", "resumable", true],
      ["reconcile", "needs-reconciliation", true],
      ["fatal", "terminal-failed", true],
      ["terminal", "retry-safe", true],
    ];
    for (const [id, policy, dispatched] of cases) {
      const call = readyCall(id, `tool-${id}`, { value: id });
      const descriptor = toolDescriptor(call.name, policy);
      await current.authority.prepare({
        call,
        descriptor,
        context: { execute: () => { toolExecutions += 1; } },
        scope: toolScope(step),
        snapshot: toolSnapshot(),
      });
      if (dispatched) {
        await current.authority.markDispatched({
          call,
          descriptor,
          context: {},
          scope: toolScope(step),
          snapshot: toolSnapshot(),
          grant: { grantId: `grant-${id}` },
        });
      }
      if (id === "terminal") {
        await current.authority.finish({
          call,
          descriptor,
          context: {},
          scope: toolScope(step),
          snapshot: toolSnapshot(),
          result: {
            ok: true,
            callId: call.id,
            toolName: call.name,
            output: "done",
            phase: "completed",
          },
        });
      }
    }
    await current.authority.close();
    await current.backend.close();

    current = state.open();
    const report = await current.authority.recoverInterrupted("process_restart");
    assert.equal(toolExecutions, 0);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.runs), true);
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].disposition, "terminal-failed");
    assert.deepEqual(
      report.runs[0].tools.map(({ callId, phase, disposition }) => ({
        callId,
        phase,
        disposition,
      })),
      [
        { callId: "prepared", phase: "prepared", disposition: "retry-safe" },
        { callId: "resumable", phase: "dispatched", disposition: "resumable" },
        { callId: "reconcile", phase: "dispatched", disposition: "needs-reconciliation" },
        { callId: "fatal", phase: "dispatched", disposition: "terminal-failed" },
      ],
    );
    const events = await current.authority.readEvents(run.runId);
    assert.deepEqual(events.slice(-7).map((event) => event.type), [
      "tool.interrupted",
      "tool.interrupted",
      "tool.interrupted",
      "tool.interrupted",
      "step.interrupted",
      "user_turn.interrupted",
      "run.interrupted",
    ]);
    assert.equal((await current.authority.recoverInterrupted()).runs.length, 0);
    assert.equal(toolExecutions, 0);

    const beforeResolution = buildRuntimeLifecycleStartupSnapshot(
      report,
      events,
    );
    assert.deepEqual(
      beforeResolution.pendingReconciliations.map((item) => item.callId),
      ["reconcile"],
    );
    const resolutionRequest = {
      resolutionId: "resolution-reconcile",
      runId: run.runId,
      userTurnId: turn.id,
      stepId: step.step.stepId,
      callId: "reconcile",
      outcome: "accepted-unknown",
      actor: "acceptance-operator",
      reason: "External outcome cannot be established; do not retry",
      evidence: "private operator evidence",
    };
    const resolved = await current.authority.resolveReconciliation(
      resolutionRequest,
    );
    assert.equal(resolved.replayed, false);
    assert.equal(resolved.resolution.outcome, "accepted-unknown");
    assert.match(
      resolved.resolution.evidenceFingerprint,
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.equal(
      (await current.authority.resolveReconciliation(resolutionRequest)).replayed,
      true,
    );
    await assert.rejects(
      current.authority.resolveReconciliation({
        ...resolutionRequest,
        resolutionId: "resolution-conflict",
      }),
      (error) => error?.code === "runtime_reconciliation_conflict",
    );
    await assert.rejects(
      current.authority.resolveReconciliation({
        ...resolutionRequest,
        callId: "fatal",
        resolutionId: "resolution-not-required",
      }),
      (error) => error?.code === "runtime_reconciliation_not_found",
    );
    const resolvedEvents = await current.authority.readEvents(run.runId);
    assert.equal(
      resolvedEvents.filter((event) =>
        event.type === "tool.reconciliation_resolved"
      ).length,
      1,
    );
    assert.equal(
      JSON.stringify(resolvedEvents).includes("private operator evidence"),
      false,
    );
    const afterResolution = buildRuntimeLifecycleStartupSnapshot(
      report,
      resolvedEvents,
    );
    assert.deepEqual(afterResolution.pendingReconciliations, []);
    assert.deepEqual(afterResolution.reconciliationRequiredRuns, []);
    assert.equal(afterResolution.reconciliationResolutions.length, 1);
  } finally {
    await current.authority.close();
    await current.backend.close();
    await state.dispose();
  }
});

test("Runtime lifecycle reports malformed domain entries as Storage corruption", async () => {
  const state = await fixture();
  const current = state.open();
  try {
    await current.backend.journal.open({
      namespace: RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
    }).append({
      idempotencyKey: "malformed-runtime-event",
      entries: [new TextEncoder().encode("not-json")],
    }, { kind: "any" });
    await assert.rejects(
      current.authority.recoverInterrupted(),
      (error) =>
        error?.code === "storage_corruption" &&
        error?.namespace === RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
    );
  } finally {
    await current.authority.close();
    await current.backend.close();
    await state.dispose();
  }
});

test("Cordis replaces and unloads the Journal Runtime lifecycle Provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-runtime-provider-"));
  const seededBackend = new FileStorageBackend({
    id: "file",
    rootDirectory: join(directory, "storage"),
  });
  const seededAuthority = new JournalRuntimeLifecycleAuthority({
    backendId: "file",
    journal: seededBackend.journal.open({
      namespace: RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
    }),
  });
  const { run, turn, step } = snapshots("run-provider-recovery");
  const call = readyCall("call-provider-recovery", "provider-effect", {});
  const descriptor = toolDescriptor("provider-effect", "needs-reconciliation");
  await seededAuthority.openRun(run);
  await seededAuthority.openUserTurn({ run, userTurn: turn });
  await seededAuthority.openStep(step);
  await seededAuthority.prepare({
    call,
    descriptor,
    context: {},
    scope: toolScope(step),
    snapshot: toolSnapshot(),
  });
  await seededAuthority.markDispatched({
    call,
    descriptor,
    context: {},
    scope: toolScope(step),
    snapshot: toolSnapshot(),
    grant: { grantId: "provider-grant" },
  });
  await seededAuthority.close();
  await seededBackend.close();

  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  const seen = [];
  const consumer = root.plugin({
    inject: ["runtimeLifecycle"],
    apply(ctx) {
      seen.push({
        service: ctx.runtimeLifecycle,
        startupRecovery: ctx.runtimeLifecycle.startupRecovery,
      });
    },
  });
  const lifecycle = root.plugin(JournalRuntimeLifecycleProvider, {
    backendId: "file",
  });
  assert.equal(lifecycle.state, 0);
  try {
    await root.plugin(StorageHub);
    const storage = root.plugin(FileStorageProvider, {
      id: "file",
      rootDirectory: "storage",
    });
    await storage.await();
    await lifecycle.await();
    await consumer.await();
    assert.equal(lifecycle.state, 2);
    assert.equal(consumer.state, 2);
    assert.equal(root.runtimeLifecycle.version, "runtime-lifecycle-journal-v1:file");
    assert.equal(seen[0].startupRecovery.recovery.runs.length, 1);
    assert.deepEqual(
      seen[0].startupRecovery.reconciliationRequiredRuns.map((item) => item.runId),
      ["run-provider-recovery"],
    );
    const target = seen[0].startupRecovery.pendingReconciliations[0];
    const committed = await root.runtimeLifecycle.resolveReconciliation({
      resolutionId: "provider-resolution",
      runId: target.runId,
      userTurnId: target.userTurnId,
      stepId: target.stepId,
      callId: target.callId,
      outcome: "confirmed-completed",
      actor: "provider-test",
      reason: "External system confirms completion",
    });
    assert.equal(committed.replayed, false);
    assert.deepEqual(
      (await root.runtimeLifecycle.recoverySnapshot()).pendingReconciliations,
      [],
    );

    const first = root.runtimeLifecycle;
    await lifecycle.update({ backendId: "file" });
    await consumer.await();
    assert.notEqual(root.runtimeLifecycle, first);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].startupRecovery.recovery.runs.length, 0);
    assert.deepEqual(
      seen[1].startupRecovery.recordedInterruptedRuns.map((item) => item.runId),
      ["run-provider-recovery"],
    );
    assert.deepEqual(
      seen[1].startupRecovery.reconciliationRequiredRuns.map((item) => item.runId),
      [],
    );
    assert.equal(seen[1].startupRecovery.reconciliationResolutions.length, 1);

    await storage.dispose();
    assert.equal(root.get("storageBackend"), undefined);
    assert.equal(root.get("runtimeLifecycle"), undefined);
    assert.equal(consumer.state, 0);

    const restoredStorage = root.plugin(FileStorageProvider, {
      id: "file",
      rootDirectory: "storage",
    });
    await restoredStorage.await();
    await lifecycle.await();
    await consumer.await();
    assert.equal(root.runtimeLifecycle.version, "runtime-lifecycle-journal-v1:file");
    assert.equal(seen.length, 3);
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Cordis keeps Runtime consumers pending when startup recovery is corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-runtime-provider-corrupt-"));
  const seededBackend = new FileStorageBackend({
    id: "file",
    rootDirectory: join(directory, "storage"),
  });
  await seededBackend.journal.open({
    namespace: RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
  }).append({
    idempotencyKey: "corrupt-provider-startup",
    entries: [new TextEncoder().encode("not-json")],
  }, { kind: "any" });
  await seededBackend.close();

  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  const consumer = root.plugin({
    inject: ["runtimeLifecycle"],
    apply() {
      throw new Error("corrupt recovery must not activate Runtime consumers");
    },
  });
  const lifecycle = root.plugin(JournalRuntimeLifecycleProvider, {
    backendId: "file",
  });
  try {
    await root.plugin(StorageHub);
    const storage = root.plugin(FileStorageProvider, {
      id: "file",
      rootDirectory: "storage",
    });
    await storage.await();
    await assert.rejects(
      lifecycle.await(),
      (error) => error?.code === "storage_corruption",
    );
    assert.equal(lifecycle.state, 3);
    assert.equal(consumer.state, 0);
    assert.equal(root.get("runtimeLifecycle"), undefined);
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function snapshots(runId) {
  const turn = Object.freeze({
    id: `${runId}-turn`,
    ordinal: 0,
    status: "running",
    input: Object.freeze({ text: "private prompt" }),
    startedAt: "2026-01-01T00:00:00.000Z",
    steps: Object.freeze([]),
  });
  const run = Object.freeze({
    schemaVersion: 1,
    version: 1,
    runId,
    agentId: "wish",
    scope: "/workspace",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    currentUserTurnId: turn.id,
    userTurns: Object.freeze([turn]),
    pendingSteering: 0,
    queuedFollowUps: 0,
    completionHolds: 0,
  });
  const step = Object.freeze({
    schemaVersion: 1,
    capturedAt: "2026-01-01T00:00:00.000Z",
    stateVersion: 1,
    run: Object.freeze({ runId, agentId: "wish", scope: "/workspace" }),
    userTurn: Object.freeze({
      userTurnId: turn.id,
      ordinal: 0,
      input: turn.input,
    }),
    step: Object.freeze({ stepId: `${runId}-step`, ordinal: 0 }),
    steering: Object.freeze([]),
    environment: Object.freeze({ workspace: "fingerprint" }),
  });
  return { run, turn, step };
}

function readyCall(id, name, input) {
  return Object.freeze({ status: "ready", id, name, input: Object.freeze(input) });
}

function toolDescriptor(name, recoveryPolicy) {
  return Object.freeze({
    name,
    description: name,
    inputSchemaJson: "{}",
    executionMode: "sequential",
    recoveryPolicy,
  });
}

function toolScope(step) {
  return Object.freeze({
    runId: step.run.runId,
    userTurnId: step.userTurn.userTurnId,
    stepId: step.step.stepId,
  });
}

function toolSnapshot() {
  return Object.freeze({
    schemaVersion: 1,
    registryVersion: 1,
    authorityVersion: "authority-v1",
    availableTools: Object.freeze(["danger"]),
  });
}
