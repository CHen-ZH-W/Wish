import assert from "node:assert/strict";

export function workspaceSnapshot(root) {
  return Object.freeze({
    requestedRoot: root,
    root,
    fingerprint: `workspace:fixture:${root}`,
    revision: `workspace-revision:fixture:${root}`,
    instructions: Object.freeze([]),
  });
}

function runtimeRecoverySnapshot(runId) {
  const tool = Object.freeze({
    runId,
    userTurnId: `${runId}-turn`,
    stepId: `${runId}-step`,
    callId: `${runId}-call`,
    toolName: "bash",
    phase: "dispatched",
    recoveryPolicy: "needs-reconciliation",
    disposition: "needs-reconciliation",
  });
  const interrupted = Object.freeze({
    runId,
    agentId: "wish",
    scope: "session-recovery",
    userTurnIds: Object.freeze([tool.userTurnId]),
    stepIds: Object.freeze([tool.stepId]),
    tools: Object.freeze([tool]),
    disposition: "needs-reconciliation",
  });
  const recorded = Object.freeze({
    ...interrupted,
    interruptedAt: "2099-01-01T00:00:00.000Z",
    reason: "provider_startup",
  });
  const target = Object.freeze({
    runId,
    agentId: interrupted.agentId,
    scope: interrupted.scope,
    userTurnId: tool.userTurnId,
    stepId: tool.stepId,
    callId: tool.callId,
    toolName: tool.toolName,
    recoveryPolicy: tool.recoveryPolicy,
    interruptedAt: recorded.interruptedAt,
    interruptionReason: recorded.reason,
  });
  return Object.freeze({
    schemaVersion: 1,
    status: "ready",
    recovery: Object.freeze({
      schemaVersion: 1,
      reason: "provider_startup",
      recoveredAt: recorded.interruptedAt,
      scannedThroughCursor: 5,
      runs: Object.freeze([interrupted]),
    }),
    recordedInterruptedRuns: Object.freeze([recorded]),
    pendingReconciliations: Object.freeze([target]),
    reconciliationResolutions: Object.freeze([]),
    reconciliationRequiredRuns: Object.freeze([recorded]),
  });
}

export function runtimeRecoveryPort(runId) {
  const snapshot = runtimeRecoverySnapshot(runId);
  return Object.freeze({
    async snapshot() {
      return snapshot;
    },
    async resolve() {
      throw new Error("Unexpected reconciliation resolution");
    },
  });
}

export function runtimeRecoveryHarness(runId) {
  let current = runtimeRecoverySnapshot(runId);
  const requests = [];
  const port = Object.freeze({
    async snapshot() {
      return current;
    },
    async resolve(request) {
      requests.push(request);
      const target = current.pendingReconciliations[0];
      assert.ok(target);
      const resolution = Object.freeze({
        schemaVersion: 1,
        ...target,
        resolutionId: request.resolutionId,
        outcome: request.outcome,
        actor: request.actor,
        reason: request.reason,
        resolvedAt: "2099-01-01T00:00:01.000Z",
      });
      current = Object.freeze({
        ...current,
        pendingReconciliations: Object.freeze([]),
        reconciliationResolutions: Object.freeze([resolution]),
        reconciliationRequiredRuns: Object.freeze([]),
      });
      return Object.freeze({ resolution, replayed: false });
    },
  });
  return { port, requests };
}
