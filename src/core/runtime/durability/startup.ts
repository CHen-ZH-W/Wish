import type {
  DurableRuntimeLifecycleEvent,
  InterruptedToolExecution,
  RecordedInterruptedRunExecution,
  RuntimeReconciliationResolution,
  RuntimeReconciliationTarget,
  RuntimeLifecycleRecoveryReport,
  RuntimeLifecycleStartupSnapshot,
} from "./types.js";

interface InterruptedChildren {
  readonly userTurnIds: string[];
  readonly stepIds: string[];
  readonly tools: InterruptedToolExecution[];
}

/** Build the restart-stable operator view from already validated events. */
export function buildRuntimeLifecycleStartupSnapshot(
  recovery: RuntimeLifecycleRecoveryReport,
  events: readonly DurableRuntimeLifecycleEvent[],
): RuntimeLifecycleStartupSnapshot {
  const children = new Map<string, InterruptedChildren>();
  const interruptedToolEvents = new Map<string, DurableRuntimeLifecycleEvent>();
  const recorded: RecordedInterruptedRunExecution[] = [];

  for (const event of events) {
    if (!event.type.endsWith(".interrupted")) continue;
    const current = children.get(event.runId) ?? {
      userTurnIds: [],
      stepIds: [],
      tools: [],
    };
    children.set(event.runId, current);

    if (event.type === "tool.interrupted") {
      interruptedToolEvents.set(reconciliationKey(event), event);
      current.tools.push(Object.freeze({
        runId: event.runId,
        userTurnId: required(event.userTurnId, "interrupted Tool UserTurn id"),
        stepId: required(event.stepId, "interrupted Tool Step id"),
        callId: required(event.callId, "interrupted Tool call id"),
        toolName: required(event.toolName, "interrupted Tool name"),
        phase: required(event.interruptedPhase, "interrupted Tool phase"),
        recoveryPolicy: required(
          event.recoveryPolicy,
          "interrupted Tool recovery policy",
        ),
        disposition: required(
          event.recoveryDisposition,
          "interrupted Tool recovery disposition",
        ),
      }));
      continue;
    }
    if (event.type === "step.interrupted") {
      pushUnique(
        current.stepIds,
        required(event.stepId, "interrupted Step id"),
      );
      continue;
    }
    if (event.type === "user_turn.interrupted") {
      pushUnique(
        current.userTurnIds,
        required(event.userTurnId, "interrupted UserTurn id"),
      );
      continue;
    }
    if (event.type !== "run.interrupted") continue;

    recorded.push(Object.freeze({
      runId: event.runId,
      agentId: required(event.agentId, "interrupted Run Agent id"),
      scope: required(event.scope, "interrupted Run scope"),
      userTurnIds: Object.freeze([...current.userTurnIds]),
      stepIds: Object.freeze([...current.stepIds]),
      tools: Object.freeze([...current.tools]),
      disposition: required(
        event.recoveryDisposition,
        "interrupted Run recovery disposition",
      ),
      interruptedAt: event.occurredAt,
      reason: required(event.reason, "interrupted Run reason"),
    }));
    children.delete(event.runId);
  }

  const recordedInterruptedRuns = Object.freeze(recorded);
  const targetByKey = new Map<string, RuntimeReconciliationTarget>();
  for (const run of recorded) {
    for (const tool of run.tools) {
      if (tool.disposition !== "needs-reconciliation") continue;
      const interruption = required(
        interruptedToolEvents.get(reconciliationKey(tool)),
        "interrupted Tool event",
      );
      const target = Object.freeze({
        runId: run.runId,
        agentId: run.agentId,
        scope: run.scope,
        userTurnId: tool.userTurnId,
        stepId: tool.stepId,
        callId: tool.callId,
        toolName: tool.toolName,
        recoveryPolicy: tool.recoveryPolicy,
        interruptedAt: interruption.occurredAt,
        interruptionReason: required(
          interruption.reason,
          "interrupted Tool reason",
        ),
      });
      targetByKey.set(reconciliationKey(target), target);
    }
  }
  const reconciliationResolutions = Object.freeze(events
    .filter((event) => event.type === "tool.reconciliation_resolved")
    .map((event) => resolutionFromEvent(
      event,
      required(
        targetByKey.get(reconciliationKey(event)),
        "reconciliation target",
      ),
    )));
  const resolvedKeys = new Set(reconciliationResolutions.map(reconciliationKey));
  const pendingReconciliations = Object.freeze([...targetByKey]
    .filter(([key]) => !resolvedKeys.has(key))
    .map(([, target]) => target));
  const pendingKeys = new Set(pendingReconciliations.map(reconciliationKey));
  const reconciliationRequiredRuns = Object.freeze(recorded.flatMap((run) => {
    const tools = run.tools.filter((tool) => pendingKeys.has(reconciliationKey(tool)));
    if (tools.length === 0) return [];
    return [Object.freeze({
      ...run,
      userTurnIds: Object.freeze(unique(tools.map((tool) => tool.userTurnId))),
      stepIds: Object.freeze(unique(tools.map((tool) => tool.stepId))),
      tools: Object.freeze(tools),
      disposition: "needs-reconciliation" as const,
    })];
  }));
  return Object.freeze({
    schemaVersion: 1,
    status: "ready",
    recovery,
    recordedInterruptedRuns,
    pendingReconciliations,
    reconciliationResolutions,
    reconciliationRequiredRuns,
  });
}

function resolutionFromEvent(
  event: DurableRuntimeLifecycleEvent,
  target: RuntimeReconciliationTarget,
): RuntimeReconciliationResolution {
  return Object.freeze({
    schemaVersion: 1,
    ...target,
    resolutionId: required(event.resolutionId, "reconciliation resolution id"),
    outcome: required(event.reconciliationOutcome, "reconciliation outcome"),
    actor: required(event.actor, "reconciliation actor"),
    reason: required(event.reason, "reconciliation reason"),
    ...(event.evidenceFingerprint === undefined
      ? {}
      : { evidenceFingerprint: event.evidenceFingerprint }),
    resolvedAt: event.occurredAt,
  });
}

function reconciliationKey(input: {
  readonly runId: string;
  readonly userTurnId?: string;
  readonly stepId?: string;
  readonly callId?: string;
}): string {
  return JSON.stringify([
    input.runId,
    required(input.userTurnId, "reconciliation UserTurn id"),
    required(input.stepId, "reconciliation Step id"),
    required(input.callId, "reconciliation Tool call id"),
  ]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function required<Value>(
  value: Value | undefined,
  label: string,
): Value {
  if (value === undefined) {
    throw new TypeError(`${label} is missing from a validated lifecycle event`);
  }
  return value;
}
