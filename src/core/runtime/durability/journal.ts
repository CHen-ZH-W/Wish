import { createHash } from "node:crypto";

import type {
  RunSnapshot,
  StepSnapshot,
  UserTurnSnapshot,
} from "../snapshot.js";
import type { RuntimeLifecycleService } from "../lifecycle.js";
import type {
  ToolExecutionLifecycle,
} from "../../tools/executor.js";
import type {
  ToolCall,
  ToolDescriptor,
  ToolExecutionScope,
  ToolExecutionSnapshot,
  ToolRecoveryPolicy,
  ToolResult,
} from "../../tools/tool.js";
import type { ToolAuthorizationGrant } from "../../tools/authorization.js";
import { StorageClosedError, StorageCorruptionError } from "../../../storage/errors.js";
import { JOURNAL_ANY, type Journal } from "../../../storage/journal.js";
import {
  RuntimeReconciliationConflictError,
  RuntimeReconciliationNotFoundError,
} from "./errors.js";
import {
  RECOVERY_DISPOSITIONS,
  RUNTIME_RECONCILIATION_OUTCOMES,
  combineRecoveryDispositions,
  type DurableRuntimeLifecycleEvent,
  type DurableRuntimeLifecycleEventType,
  type InterruptedRunExecution,
  type InterruptedToolExecution,
  type RecoveryDisposition,
  type ResolveRuntimeReconciliationRequest,
  type RuntimeReconciliationCommit,
  type RuntimeReconciliationOutcome,
  type RuntimeReconciliationResolution,
  type RuntimeLifecycleRecoveryReport,
} from "./types.js";

export const RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE = "runtime/lifecycle";

const EVENT_SCHEMA_VERSION = 1;
const ID_PREFIX = "runtime-lifecycle:v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface JournalRuntimeLifecycleAuthorityOptions {
  readonly journal: Journal;
  readonly backendId: string;
  readonly now?: () => Date;
}

interface LoadedEvent {
  readonly cursor: number;
  readonly event: DurableRuntimeLifecycleEvent;
}

interface ToolState {
  readonly prepared: DurableRuntimeLifecycleEvent;
  phase: "prepared" | "dispatched";
  terminal: boolean;
  terminalEvent?: DurableRuntimeLifecycleEvent;
  reconciliation?: DurableRuntimeLifecycleEvent;
}

interface StepState {
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly tools: Map<string, ToolState>;
  terminal: boolean;
}

interface TurnState {
  readonly runId: string;
  readonly userTurnId: string;
  readonly steps: Map<string, StepState>;
  terminal: boolean;
}

interface RunState {
  readonly runId: string;
  readonly agentId: string;
  readonly scope: string;
  readonly turns: Map<string, TurnState>;
  terminal: boolean;
}

interface LifecycleState {
  readonly runs: Map<string, RunState>;
  readonly scannedThroughCursor: number;
}

interface NormalizedReconciliationRequest {
  readonly resolutionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly outcome: RuntimeReconciliationOutcome;
  readonly actor: string;
  readonly reason: string;
  readonly evidenceFingerprint?: string;
  readonly signal?: AbortSignal;
}

/**
 * Runtime-owned durable authority backed by a Storage Journal.
 *
 * Lifecycle calls are serialized, and every successful return is after the
 * selected Journal Provider's durability point. Recovery only classifies and
 * seals interrupted work; it never invokes a Tool or reconstructs a Run.
 */
export class JournalRuntimeLifecycleAuthority
  implements RuntimeLifecycleService<unknown, unknown>, ToolExecutionLifecycle<unknown> {
  private readonly now: () => Date;
  private readonly encodedEvents = new Map<string, Uint8Array>();
  private tail: Promise<void> = Promise.resolve();
  private hasLocalLifecycleWrites = false;
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: JournalRuntimeLifecycleAuthorityOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Runtime lifecycle authority options must be an object");
    }
    requireIdentifier(options.backendId, "Runtime lifecycle Backend id");
    if (options.journal === null || typeof options.journal !== "object") {
      throw new TypeError("Runtime lifecycle authority requires a Journal");
    }
    this.now = options.now ?? (() => new Date());
  }

  openRun(snapshot: RunSnapshot<unknown, unknown>): Promise<void> {
    const event = this.event({
      type: "run.opened",
      runId: snapshot.runId,
      agentId: snapshot.agentId,
      scope: snapshot.scope,
    });
    return this.appendEvent(event, identityKey(event));
  }

  finishRun(input: {
    readonly snapshot: RunSnapshot<unknown, unknown>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> {
    const event = this.event({
      type: `run.${input.status}`,
      runId: input.snapshot.runId,
      ...(input.reason === undefined ? {} : { reason: normalizeReason(input.reason) }),
    });
    return this.appendEvent(event, identityKey(event));
  }

  openUserTurn(input: {
    readonly run: RunSnapshot<unknown, unknown>;
    readonly userTurn: UserTurnSnapshot<unknown, unknown>;
  }): Promise<void> {
    const event = this.event({
      type: "user_turn.opened",
      runId: input.run.runId,
      userTurnId: input.userTurn.id,
    });
    return this.appendEvent(event, identityKey(event));
  }

  finishUserTurn(input: {
    readonly run: RunSnapshot<unknown, unknown>;
    readonly userTurn: UserTurnSnapshot<unknown, unknown>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> {
    const event = this.event({
      type: `user_turn.${input.status}`,
      runId: input.run.runId,
      userTurnId: input.userTurn.id,
      ...(input.reason === undefined ? {} : { reason: normalizeReason(input.reason) }),
    });
    return this.appendEvent(event, identityKey(event));
  }

  openStep(snapshot: StepSnapshot<unknown>): Promise<void> {
    const event = this.event({
      type: "step.opened",
      runId: snapshot.run.runId,
      userTurnId: snapshot.userTurn.userTurnId,
      stepId: snapshot.step.stepId,
      snapshotFingerprint: fingerprint(snapshot),
    });
    return this.appendEvent(event, identityKey(event));
  }

  finishStep(input: {
    readonly snapshot: StepSnapshot<unknown>;
    readonly status: "completed" | "failed" | "aborted";
    readonly reason?: string;
  }): Promise<void> {
    const event = this.event({
      type: `step.${input.status}`,
      runId: input.snapshot.run.runId,
      userTurnId: input.snapshot.userTurn.userTurnId,
      stepId: input.snapshot.step.stepId,
      ...(input.reason === undefined ? {} : { reason: normalizeReason(input.reason) }),
    });
    return this.appendEvent(event, identityKey(event));
  }

  prepare(input: {
    readonly call: ToolCall;
    readonly descriptor?: ToolDescriptor;
    readonly context: unknown;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
  }): Promise<void> {
    const event = this.event({
      type: "tool.prepared",
      ...scopeFields(input.scope),
      callId: input.call.id,
      toolName: input.call.name,
      recoveryPolicy: input.descriptor?.recoveryPolicy ?? "terminal-failed",
      callFingerprint: fingerprint(input.call),
      snapshotFingerprint: fingerprint(input.snapshot),
    });
    return this.appendEvent(event, identityKey(event));
  }

  markDispatched(input: {
    readonly call: Extract<ToolCall, { readonly status: "ready" }>;
    readonly descriptor: ToolDescriptor;
    readonly context: unknown;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
    readonly grant: ToolAuthorizationGrant;
  }): Promise<void> {
    const event = this.event({
      type: "tool.dispatched",
      ...scopeFields(input.scope),
      callId: input.call.id,
      toolName: input.call.name,
      grantId: input.grant.grantId,
    });
    return this.appendEvent(event, identityKey(event));
  }

  finish(input: {
    readonly call: ToolCall;
    readonly descriptor?: ToolDescriptor;
    readonly context: unknown;
    readonly scope: ToolExecutionScope;
    readonly snapshot: ToolExecutionSnapshot;
    readonly result: ToolResult;
  }): Promise<void> {
    const status = toolResultStatus(input.result);
    const event = this.event({
      type: `tool.${status}`,
      ...scopeFields(input.scope),
      callId: input.call.id,
      toolName: input.call.name,
      resultStatus: status,
      resultFingerprint: fingerprint(input.result),
    });
    return this.appendEvent(event, identityKey(event));
  }

  readEvents(
    runId?: string,
    signal?: AbortSignal,
  ): Promise<readonly DurableRuntimeLifecycleEvent[]> {
    const selectedRunId = runId === undefined
      ? undefined
      : requireIdentifier(runId, "Runtime lifecycle Run id");
    return this.serial(async () => {
      const loaded = await this.load(signal);
      return Object.freeze(loaded
        .filter(({ event }) => selectedRunId === undefined || event.runId === selectedRunId)
        .map(({ event }) => event));
    });
  }

  recoverInterrupted(reason = "runtime_restarted"): Promise<RuntimeLifecycleRecoveryReport> {
    const normalizedReason = normalizeReason(reason);
    return this.serial(async () => {
      if (this.hasLocalLifecycleWrites) {
        throw new Error(
          "Runtime lifecycle recovery must run before admitting lifecycle work in this process",
        );
      }
      const loaded = await this.load();
      const state = buildLifecycleState(loaded, this.options.backendId);
      const recoveredAt = this.timestamp();
      const reports: InterruptedRunExecution[] = [];
      const interruptionEvents: DurableRuntimeLifecycleEvent[] = [];

      for (const run of state.runs.values()) {
        if (run.terminal) continue;
        const openTurns = [...run.turns.values()].filter((turn) => !turn.terminal);
        const openSteps = openTurns.flatMap((turn) =>
          [...turn.steps.values()].filter((step) => !step.terminal)
        );
        const tools: InterruptedToolExecution[] = [];
        for (const step of openSteps) {
          for (const [callId, tool] of step.tools) {
            if (tool.terminal) continue;
            const policy = tool.prepared.recoveryPolicy ?? "terminal-failed";
            const disposition = tool.phase === "prepared"
              ? "retry-safe"
              : dispositionForPolicy(policy);
            const interrupted = deepFreeze({
              runId: step.runId,
              userTurnId: step.userTurnId,
              stepId: step.stepId,
              callId,
              toolName: tool.prepared.toolName!,
              phase: tool.phase,
              recoveryPolicy: policy,
              disposition,
            }) as InterruptedToolExecution;
            tools.push(interrupted);
            interruptionEvents.push(freezeEvent({
              schemaVersion: EVENT_SCHEMA_VERSION,
              type: "tool.interrupted",
              occurredAt: recoveredAt,
              runId: interrupted.runId,
              userTurnId: interrupted.userTurnId,
              stepId: interrupted.stepId,
              callId: interrupted.callId,
              toolName: interrupted.toolName,
              recoveryPolicy: interrupted.recoveryPolicy,
              interruptedPhase: interrupted.phase,
              recoveryDisposition: interrupted.disposition,
              reason: normalizedReason,
            }));
          }
        }
        const disposition = combineRecoveryDispositions(
          tools.map((tool) => tool.disposition),
        );
        const report = deepFreeze({
          runId: run.runId,
          agentId: run.agentId,
          scope: run.scope,
          userTurnIds: openTurns.map((turn) => turn.userTurnId),
          stepIds: openSteps.map((step) => step.stepId),
          tools,
          disposition,
        }) as InterruptedRunExecution;
        reports.push(report);
        for (const step of openSteps) {
          interruptionEvents.push(freezeEvent({
            schemaVersion: EVENT_SCHEMA_VERSION,
            type: "step.interrupted",
            occurredAt: recoveredAt,
            runId: step.runId,
            userTurnId: step.userTurnId,
            stepId: step.stepId,
            recoveryDisposition: dispositionForStep(step, tools),
            reason: normalizedReason,
          }));
        }
        for (const turn of openTurns) {
          interruptionEvents.push(freezeEvent({
            schemaVersion: EVENT_SCHEMA_VERSION,
            type: "user_turn.interrupted",
            occurredAt: recoveredAt,
            runId: turn.runId,
            userTurnId: turn.userTurnId,
            recoveryDisposition: dispositionForTurn(turn, tools),
            reason: normalizedReason,
          }));
        }
        interruptionEvents.push(freezeEvent({
          schemaVersion: EVENT_SCHEMA_VERSION,
          type: "run.interrupted",
          occurredAt: recoveredAt,
          runId: run.runId,
          agentId: run.agentId,
          scope: run.scope,
          recoveryDisposition: disposition,
          reason: normalizedReason,
        }));
      }

      if (interruptionEvents.length > 0) {
        const recoveryIdentity = fingerprint({
          through: state.scannedThroughCursor,
          reason: normalizedReason,
          events: interruptionEvents.map(recoveryEventIdentity),
        });
        await this.options.journal.append({
          idempotencyKey: `${ID_PREFIX}:recovery:${recoveryIdentity}`,
          entries: interruptionEvents.map(encodeEvent),
        }, JOURNAL_ANY);
      }

      return deepFreeze({
        schemaVersion: 1,
        reason: normalizedReason,
        recoveredAt,
        scannedThroughCursor: state.scannedThroughCursor,
        runs: reports,
      }) as RuntimeLifecycleRecoveryReport;
    });
  }

  resolveReconciliation(
    request: ResolveRuntimeReconciliationRequest,
  ): Promise<RuntimeReconciliationCommit> {
    const normalized = normalizeReconciliationRequest(request);
    return this.serial(async () => {
      const loaded = await this.load(normalized.signal);
      throwIfAborted(normalized.signal);
      const state = buildLifecycleState(loaded, this.options.backendId);
      const existingIdentity = loaded.find(({ event }) =>
        event.type === "tool.reconciliation_resolved" &&
        event.resolutionId === normalized.resolutionId
      )?.event;
      if (existingIdentity !== undefined) {
        if (!sameReconciliation(existingIdentity, normalized)) {
          throw new RuntimeReconciliationConflictError(
            normalized.runId,
            normalized.callId,
            `Runtime reconciliation resolution id "${normalized.resolutionId}" was already used for another decision`,
          );
        }
        return Object.freeze({
          resolution: resolutionFromState(
            state,
            existingIdentity,
            this.options.backendId,
          ),
          replayed: true,
        });
      }

      const target = reconciliationTarget(state, normalized);
      if (target.reconciliation !== undefined) {
        throw new RuntimeReconciliationConflictError(
          normalized.runId,
          normalized.callId,
        );
      }
      const interrupted = target.terminalEvent;
      if (
        interrupted?.type !== "tool.interrupted" ||
        interrupted.recoveryDisposition !== "needs-reconciliation"
      ) {
        throw new RuntimeReconciliationNotFoundError(
          normalized.runId,
          normalized.callId,
        );
      }
      const event = this.event({
        type: "tool.reconciliation_resolved",
        runId: normalized.runId,
        userTurnId: normalized.userTurnId,
        stepId: normalized.stepId,
        callId: normalized.callId,
        toolName: target.prepared.toolName!,
        resolutionId: normalized.resolutionId,
        reconciliationOutcome: normalized.outcome,
        actor: normalized.actor,
        reason: normalized.reason,
        ...(normalized.evidenceFingerprint === undefined
          ? {}
          : { evidenceFingerprint: normalized.evidenceFingerprint }),
      });
      await this.options.journal.append({
        idempotencyKey: reconciliationIdentityKey(normalized.resolutionId),
        entries: [encodeEvent(event)],
      }, JOURNAL_ANY, normalized.signal);
      this.hasLocalLifecycleWrites = true;
      applyEvent(state.runs, event);
      return Object.freeze({
        resolution: resolutionFromState(state, event, this.options.backendId),
        replayed: false,
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.state = "closing";
    return this.closePromise = (async () => {
      await this.tail.catch(() => undefined);
      try {
        await this.options.journal.flush();
      } finally {
        try {
          await this.options.journal.close();
        } finally {
          this.state = "closed";
          this.encodedEvents.clear();
        }
      }
    })();
  }

  private event(
    input: Omit<DurableRuntimeLifecycleEvent, "schemaVersion" | "occurredAt">,
  ): DurableRuntimeLifecycleEvent {
    return freezeEvent({
      schemaVersion: EVENT_SCHEMA_VERSION,
      occurredAt: this.timestamp(),
      ...input,
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Runtime lifecycle clock must return a valid Date");
    }
    return value.toISOString();
  }

  private appendEvent(
    event: DurableRuntimeLifecycleEvent,
    idempotencyKey: string,
  ): Promise<void> {
    return this.serial(async () => {
      let encoded = this.encodedEvents.get(idempotencyKey);
      if (encoded === undefined) {
        encoded = encodeEvent(event);
        this.encodedEvents.set(idempotencyKey, encoded);
      }
      await this.options.journal.append({
        idempotencyKey,
        entries: [encoded],
      }, JOURNAL_ANY);
      this.hasLocalLifecycleWrites = true;
    });
  }

  private serial<Output>(operation: () => Promise<Output>): Promise<Output> {
    this.assertOpen();
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new StorageClosedError(this.options.backendId, "journal");
    }
  }

  private async load(signal?: AbortSignal): Promise<readonly LoadedEvent[]> {
    const events: LoadedEvent[] = [];
    try {
      for await (const entry of this.options.journal.read(
        signal === undefined ? {} : { signal },
      )) {
        events.push(Object.freeze({
          cursor: entry.cursor,
          event: decodeEvent(entry.value, this.options.backendId),
        }));
      }
    } catch (error: unknown) {
      if (error instanceof StorageCorruptionError) throw error;
      if (error instanceof TypeError || error instanceof SyntaxError) {
        throw corruption("Runtime lifecycle Journal cannot be decoded", this.options.backendId, error);
      }
      throw error;
    }
    return Object.freeze(events);
  }
}

function buildLifecycleState(
  loaded: readonly LoadedEvent[],
  backendId: string,
): LifecycleState {
  const runs = new Map<string, RunState>();
  let scannedThroughCursor = 0;
  for (const { cursor, event } of loaded) {
    scannedThroughCursor = Math.max(scannedThroughCursor, cursor);
    try {
      applyEvent(runs, event);
    } catch (error: unknown) {
      throw corruption(
        `Runtime lifecycle event at cursor ${cursor} violates lifecycle order`,
        backendId,
        error,
      );
    }
  }
  return Object.freeze({ runs, scannedThroughCursor });
}

function applyEvent(
  runs: Map<string, RunState>,
  event: DurableRuntimeLifecycleEvent,
): void {
  if (event.type === "run.opened") {
    if (runs.has(event.runId)) throw new Error(`Run ${event.runId} was opened twice`);
    runs.set(event.runId, {
      runId: event.runId,
      agentId: event.agentId!,
      scope: event.scope!,
      turns: new Map(),
      terminal: false,
    });
    return;
  }
  const run = runs.get(event.runId);
  if (run === undefined) throw new Error(`Run ${event.runId} was not opened`);
  if (event.type === "tool.reconciliation_resolved") {
    if (!run.terminal) {
      throw new Error(`Run ${event.runId} is not interrupted and terminal`);
    }
    const turn = run.turns.get(event.userTurnId!);
    const step = turn?.steps.get(event.stepId!);
    const tool = step?.tools.get(event.callId!);
    if (
      turn === undefined || step === undefined || tool === undefined ||
      tool.terminalEvent?.type !== "tool.interrupted" ||
      tool.terminalEvent.recoveryDisposition !== "needs-reconciliation"
    ) {
      throw new Error(`Tool call ${event.callId} does not require reconciliation`);
    }
    if (event.toolName !== tool.prepared.toolName) {
      throw new Error(`Tool call ${event.callId} changed its Tool name`);
    }
    if (tool.reconciliation !== undefined) {
      throw new Error(`Tool call ${event.callId} was reconciled twice`);
    }
    tool.reconciliation = event;
    return;
  }
  if (run.terminal) throw new Error(`Run ${event.runId} is already terminal`);

  if (isRunTerminal(event.type)) {
    if (hasOpenTurn(run)) throw new Error(`Run ${event.runId} still has open UserTurns`);
    run.terminal = true;
    return;
  }
  if (event.type === "user_turn.opened") {
    const userTurnId = event.userTurnId!;
    if (run.turns.has(userTurnId)) throw new Error(`UserTurn ${userTurnId} was opened twice`);
    if (hasOpenTurn(run)) throw new Error(`Run ${event.runId} already has an open UserTurn`);
    run.turns.set(userTurnId, {
      runId: event.runId,
      userTurnId,
      steps: new Map(),
      terminal: false,
    });
    return;
  }
  const turn = run.turns.get(event.userTurnId!);
  if (turn === undefined) throw new Error(`UserTurn ${event.userTurnId} was not opened`);
  if (turn.terminal) throw new Error(`UserTurn ${event.userTurnId} is already terminal`);

  if (isTurnTerminal(event.type)) {
    if (hasOpenStep(turn)) throw new Error(`UserTurn ${event.userTurnId} still has open Steps`);
    turn.terminal = true;
    return;
  }
  if (event.type === "step.opened") {
    const stepId = event.stepId!;
    if (turn.steps.has(stepId)) throw new Error(`Step ${stepId} was opened twice`);
    if (hasOpenStep(turn)) throw new Error(`UserTurn ${event.userTurnId} already has an open Step`);
    turn.steps.set(stepId, {
      runId: event.runId,
      userTurnId: event.userTurnId!,
      stepId,
      tools: new Map(),
      terminal: false,
    });
    return;
  }
  const step = turn.steps.get(event.stepId!);
  if (step === undefined) throw new Error(`Step ${event.stepId} was not opened`);
  if (step.terminal) throw new Error(`Step ${event.stepId} is already terminal`);

  if (isStepTerminal(event.type)) {
    if (hasOpenTool(step)) throw new Error(`Step ${event.stepId} still has open Tools`);
    step.terminal = true;
    return;
  }
  if (event.type === "tool.prepared") {
    const callId = event.callId!;
    if (step.tools.has(callId)) throw new Error(`Tool call ${callId} was prepared twice`);
    step.tools.set(callId, { prepared: event, phase: "prepared", terminal: false });
    return;
  }
  const tool = step.tools.get(event.callId!);
  if (tool === undefined) throw new Error(`Tool call ${event.callId} was not prepared`);
  if (tool.terminal) throw new Error(`Tool call ${event.callId} is already terminal`);
  if (event.type === "tool.dispatched") {
    if (tool.phase === "dispatched") throw new Error(`Tool call ${event.callId} was dispatched twice`);
    if (event.toolName !== tool.prepared.toolName) {
      throw new Error(`Tool call ${event.callId} changed its Tool name`);
    }
    tool.phase = "dispatched";
    return;
  }
  if (isToolTerminal(event.type)) {
    if (event.toolName !== tool.prepared.toolName) {
      throw new Error(`Tool call ${event.callId} changed its Tool name`);
    }
    if (event.type === "tool.interrupted") {
      if (event.interruptedPhase !== tool.phase) {
        throw new Error(`Tool call ${event.callId} interruption phase is inconsistent`);
      }
      if (event.recoveryPolicy !== tool.prepared.recoveryPolicy) {
        throw new Error(`Tool call ${event.callId} recovery policy changed`);
      }
      const expected = tool.phase === "prepared"
        ? "retry-safe"
        : dispositionForPolicy(tool.prepared.recoveryPolicy!);
      if (event.recoveryDisposition !== expected) {
        throw new Error(`Tool call ${event.callId} recovery disposition is inconsistent`);
      }
    }
    tool.terminal = true;
    tool.terminalEvent = event;
    return;
  }
  throw new Error(`Unsupported lifecycle event ${event.type}`);
}

function decodeEvent(
  value: Uint8Array,
  backendId: string,
): DurableRuntimeLifecycleEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(value));
  } catch (error: unknown) {
    throw corruption("Runtime lifecycle Journal contains invalid JSON", backendId, error);
  }
  try {
    return validateEvent(parsed);
  } catch (error: unknown) {
    throw corruption("Runtime lifecycle Journal event is invalid", backendId, error);
  }
}

function validateEvent(value: unknown): DurableRuntimeLifecycleEvent {
  if (!isRecord(value)) throw new TypeError("event must be an object");
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION) throw new TypeError("schemaVersion is unsupported");
  const type = requireEventType(value.type);
  const runId = requireIdentifier(value.runId, "Run id");
  const occurredAt = requireTimestamp(value.occurredAt);
  const event = value as unknown as DurableRuntimeLifecycleEvent;
  requireEventFields(type, event);
  return freezeEvent({ ...event, type, runId, occurredAt });
}

function requireEventFields(
  type: DurableRuntimeLifecycleEventType,
  event: DurableRuntimeLifecycleEvent,
): void {
  if (type === "run.opened") {
    requireIdentifier(event.agentId, "Agent id");
    requireIdentifier(event.scope, "Run scope");
  }
  if (type.startsWith("user_turn.") || type.startsWith("step.") || type.startsWith("tool.")) {
    requireIdentifier(event.userTurnId, "UserTurn id");
  }
  if (type.startsWith("step.") || type.startsWith("tool.")) {
    requireIdentifier(event.stepId, "Step id");
  }
  if (type.startsWith("tool.")) {
    requireIdentifier(event.callId, "Tool call id");
    requireIdentifier(event.toolName, "Tool name");
  }
  if (type === "step.opened") requireFingerprint(event.snapshotFingerprint, "Step snapshot fingerprint");
  if (type === "tool.prepared") {
    requireRecoveryPolicy(event.recoveryPolicy);
    requireFingerprint(event.callFingerprint, "Tool call fingerprint");
    requireFingerprint(event.snapshotFingerprint, "Tool snapshot fingerprint");
  }
  if (type === "tool.dispatched") requireIdentifier(event.grantId, "Tool Grant id");
  if (type === "tool.completed" || type === "tool.failed" || type === "tool.aborted") {
    const expected = type.slice("tool.".length);
    if (event.resultStatus !== expected) throw new TypeError("Tool resultStatus does not match event type");
    requireFingerprint(event.resultFingerprint, "Tool result fingerprint");
  }
  if (type.endsWith(".interrupted")) {
    requireRecoveryDisposition(event.recoveryDisposition);
    requireIdentifier(event.reason, "Interruption reason");
  }
  if (type === "tool.interrupted") {
    requireRecoveryPolicy(event.recoveryPolicy);
    if (event.interruptedPhase !== "prepared" && event.interruptedPhase !== "dispatched") {
      throw new TypeError("Tool interruptedPhase is invalid");
    }
  }
  if (type === "tool.reconciliation_resolved") {
    requireIdentifier(event.resolutionId, "Reconciliation resolution id");
    requireReconciliationOutcome(event.reconciliationOutcome);
    requireIdentifier(event.actor, "Reconciliation actor");
    requireIdentifier(event.reason, "Reconciliation reason");
    if (event.evidenceFingerprint !== undefined) {
      requireFingerprint(event.evidenceFingerprint, "Reconciliation evidence fingerprint");
    }
  }
}

function encodeEvent(event: DurableRuntimeLifecycleEvent): Uint8Array {
  return encoder.encode(JSON.stringify(event));
}

function freezeEvent(event: DurableRuntimeLifecycleEvent): DurableRuntimeLifecycleEvent {
  return Object.freeze(event);
}

function identityKey(event: DurableRuntimeLifecycleEvent): string {
  return [
    ID_PREFIX,
    event.type,
    event.runId,
    event.userTurnId,
    event.stepId,
    event.callId,
    event.resolutionId,
  ].filter((part): part is string => part !== undefined).map(encodeURIComponent).join(":");
}

function recoveryEventIdentity(event: DurableRuntimeLifecycleEvent): readonly unknown[] {
  return Object.freeze([
    event.type,
    event.runId,
    event.userTurnId,
    event.stepId,
    event.callId,
    event.recoveryDisposition,
  ]);
}

function scopeFields(scope: ToolExecutionScope): Pick<DurableRuntimeLifecycleEvent, "runId" | "userTurnId" | "stepId"> {
  return {
    runId: requireIdentifier(scope.runId, "Tool Run id"),
    userTurnId: requireIdentifier(scope.userTurnId, "Tool UserTurn id"),
    stepId: requireIdentifier(scope.stepId, "Tool Step id"),
  };
}

function toolResultStatus(result: ToolResult): "completed" | "failed" | "aborted" {
  if (result.ok) return "completed";
  return result.error.code === "aborted" ? "aborted" : "failed";
}

function dispositionForPolicy(policy: ToolRecoveryPolicy): RecoveryDisposition {
  return policy;
}

function dispositionForStep(
  step: StepState,
  tools: readonly InterruptedToolExecution[],
): RecoveryDisposition {
  return combineRecoveryDispositions(tools
    .filter((tool) => tool.stepId === step.stepId && tool.userTurnId === step.userTurnId)
    .map((tool) => tool.disposition));
}

function dispositionForTurn(
  turn: TurnState,
  tools: readonly InterruptedToolExecution[],
): RecoveryDisposition {
  return combineRecoveryDispositions(tools
    .filter((tool) => tool.userTurnId === turn.userTurnId)
    .map((tool) => tool.disposition));
}

function hasOpenTurn(run: RunState): boolean {
  return [...run.turns.values()].some((turn) => !turn.terminal);
}

function hasOpenStep(turn: TurnState): boolean {
  return [...turn.steps.values()].some((step) => !step.terminal);
}

function hasOpenTool(step: StepState): boolean {
  return [...step.tools.values()].some((tool) => !tool.terminal);
}

function isRunTerminal(type: DurableRuntimeLifecycleEventType): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.aborted" || type === "run.interrupted";
}

function isTurnTerminal(type: DurableRuntimeLifecycleEventType): boolean {
  return type === "user_turn.completed" || type === "user_turn.failed" || type === "user_turn.aborted" || type === "user_turn.interrupted";
}

function isStepTerminal(type: DurableRuntimeLifecycleEventType): boolean {
  return type === "step.completed" || type === "step.failed" || type === "step.aborted" || type === "step.interrupted";
}

function isToolTerminal(type: DurableRuntimeLifecycleEventType): boolean {
  return type === "tool.completed" || type === "tool.failed" || type === "tool.aborted" || type === "tool.interrupted";
}

function requireEventType(value: unknown): DurableRuntimeLifecycleEventType {
  if (typeof value !== "string" || !EVENT_TYPES.has(value as DurableRuntimeLifecycleEventType)) {
    throw new TypeError("Runtime lifecycle event type is invalid");
  }
  return value as DurableRuntimeLifecycleEventType;
}

const EVENT_TYPES = new Set<DurableRuntimeLifecycleEventType>([
  "run.opened", "run.completed", "run.failed", "run.aborted", "run.interrupted",
  "user_turn.opened", "user_turn.completed", "user_turn.failed", "user_turn.aborted", "user_turn.interrupted",
  "step.opened", "step.completed", "step.failed", "step.aborted", "step.interrupted",
  "tool.prepared", "tool.dispatched", "tool.completed", "tool.failed", "tool.aborted", "tool.interrupted",
  "tool.reconciliation_resolved",
]);

function requireReconciliationOutcome(
  value: unknown,
): RuntimeReconciliationOutcome {
  if (!RUNTIME_RECONCILIATION_OUTCOMES.includes(
    value as RuntimeReconciliationOutcome,
  )) {
    throw new TypeError("Runtime reconciliation outcome is invalid");
  }
  return value as RuntimeReconciliationOutcome;
}

function requireRecoveryPolicy(value: unknown): ToolRecoveryPolicy {
  if (
    value !== "retry-safe" && value !== "resumable" &&
    value !== "needs-reconciliation" && value !== "terminal-failed"
  ) throw new TypeError("Tool recoveryPolicy is invalid");
  return value;
}

function requireRecoveryDisposition(value: unknown): RecoveryDisposition {
  if (!RECOVERY_DISPOSITIONS.includes(value as RecoveryDisposition)) {
    throw new TypeError("Runtime recoveryDisposition is invalid");
  }
  return value as RecoveryDisposition;
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Runtime lifecycle occurredAt is invalid");
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function normalizeReason(value: string): string {
  const reason = requireIdentifier(value, "Runtime lifecycle reason");
  if (reason.length > 4_096) throw new TypeError("Runtime lifecycle reason is too long");
  return reason;
}

function normalizeReconciliationRequest(
  request: ResolveRuntimeReconciliationRequest,
): NormalizedReconciliationRequest {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Runtime reconciliation request must be an object");
  }
  const actor = requireIdentifier(request.actor, "Runtime reconciliation actor");
  if (actor.length > 256) {
    throw new TypeError("Runtime reconciliation actor is too long");
  }
  const resolutionId = requireIdentifier(
    request.resolutionId,
    "Runtime reconciliation resolution id",
  );
  if (resolutionId.length > 256) {
    throw new TypeError("Runtime reconciliation resolution id is too long");
  }
  const reason = normalizeReason(request.reason);
  const outcome = requireReconciliationOutcome(request.outcome);
  let evidenceFingerprint: string | undefined;
  if (request.evidence !== undefined) {
    const evidence = requireIdentifier(
      request.evidence,
      "Runtime reconciliation evidence",
    );
    if (Buffer.byteLength(evidence, "utf8") > 65_536) {
      throw new TypeError("Runtime reconciliation evidence is too large");
    }
    evidenceFingerprint = fingerprint(evidence);
  }
  return Object.freeze({
    resolutionId,
    runId: requireIdentifier(request.runId, "Runtime reconciliation Run id"),
    userTurnId: requireIdentifier(
      request.userTurnId,
      "Runtime reconciliation UserTurn id",
    ),
    stepId: requireIdentifier(request.stepId, "Runtime reconciliation Step id"),
    callId: requireIdentifier(request.callId, "Runtime reconciliation Tool call id"),
    outcome,
    actor,
    reason,
    ...(evidenceFingerprint === undefined ? {} : { evidenceFingerprint }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function reconciliationTarget(
  state: LifecycleState,
  input: Pick<
    NormalizedReconciliationRequest,
    "runId" | "userTurnId" | "stepId" | "callId"
  >,
): ToolState {
  const tool = state.runs.get(input.runId)?.turns.get(input.userTurnId)?.steps
    .get(input.stepId)?.tools.get(input.callId);
  if (tool === undefined) {
    throw new RuntimeReconciliationNotFoundError(input.runId, input.callId);
  }
  return tool;
}

function resolutionFromState(
  state: LifecycleState,
  event: DurableRuntimeLifecycleEvent,
  backendId: string,
): RuntimeReconciliationResolution {
  const run = state.runs.get(event.runId);
  const tool = run?.turns.get(event.userTurnId!)?.steps.get(event.stepId!)?.tools
    .get(event.callId!);
  const interrupted = tool?.terminalEvent;
  if (
    run === undefined || tool === undefined ||
    interrupted?.type !== "tool.interrupted"
  ) {
    throw corruption(
      "Runtime reconciliation target cannot be reconstructed",
      backendId,
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    runId: event.runId,
    agentId: run.agentId,
    scope: run.scope,
    userTurnId: event.userTurnId!,
    stepId: event.stepId!,
    callId: event.callId!,
    toolName: event.toolName!,
    recoveryPolicy: interrupted.recoveryPolicy!,
    interruptedAt: interrupted.occurredAt,
    interruptionReason: interrupted.reason!,
    resolutionId: event.resolutionId!,
    outcome: event.reconciliationOutcome!,
    actor: event.actor!,
    reason: event.reason!,
    ...(event.evidenceFingerprint === undefined
      ? {}
      : { evidenceFingerprint: event.evidenceFingerprint }),
    resolvedAt: event.occurredAt,
  }) as RuntimeReconciliationResolution;
}

function sameReconciliation(
  event: DurableRuntimeLifecycleEvent,
  request: NormalizedReconciliationRequest,
): boolean {
  return event.runId === request.runId &&
    event.userTurnId === request.userTurnId &&
    event.stepId === request.stepId &&
    event.callId === request.callId &&
    event.resolutionId === request.resolutionId &&
    event.reconciliationOutcome === request.outcome &&
    event.actor === request.actor &&
    event.reason === request.reason &&
    event.evidenceFingerprint === request.evidenceFingerprint;
}

function reconciliationIdentityKey(resolutionId: string): string {
  return `${ID_PREFIX}:reconciliation:${encodeURIComponent(resolutionId)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Runtime reconciliation was aborted", {
    cause: signal.reason,
  });
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableSerialize(value)).digest("hex")}`;
}

function stableSerialize(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === undefined) return Object.freeze({ $type: "undefined" });
    if (typeof item === "bigint") return Object.freeze({ $type: "bigint", value: item.toString() });
    if (typeof item === "number" && !Number.isFinite(item)) {
      return Object.freeze({ $type: "number", value: String(item) });
    }
    if (item instanceof Uint8Array) {
      return Object.freeze({ $type: "bytes", value: Buffer.from(item).toString("base64") });
    }
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new TypeError("Cannot fingerprint a cyclic value");
      ancestors.add(item);
      const result = item.map(normalize);
      ancestors.delete(item);
      return result;
    }
    if (isRecord(item)) {
      if (ancestors.has(item)) throw new TypeError("Cannot fingerprint a cyclic value");
      ancestors.add(item);
      const result = Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, normalize(item[key])]),
      );
      ancestors.delete(item);
      return result;
    }
    if (typeof item === "function" || typeof item === "symbol") {
      return Object.freeze({ $type: typeof item, value: String(item) });
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corruption(message: string, backendId: string, cause?: unknown): StorageCorruptionError {
  return new StorageCorruptionError(message, {
    backendId,
    facet: "journal",
    namespace: RUNTIME_LIFECYCLE_JOURNAL_NAMESPACE,
  }, cause === undefined ? undefined : { cause });
}
