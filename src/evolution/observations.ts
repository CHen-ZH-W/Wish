import type { DurableRuntimeLifecycleEvent } from "../core/runtime/durability/types.js";
import type { SessionHistorySnapshot } from "../sessions/types.js";
import type { ModelAttemptRecord } from "../models/pricing/attempts.js";
import type { SystemPromptSnapshot } from "../system-prompt/history/types.js";
import { digest, freezeJson } from "../agent-profiles/validation.js";
import { ProfileRecordStore } from "../agent-profiles/store.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import type { TaskTrace, EvolutionTicket } from "./types.js";

/** Supplied by a trusted verifier adapter, never parsed from an assistant message. */
export interface TaskOutcomeReceipt {
  readonly runId: string; readonly taskId: string; readonly verifierId: string; readonly verifierVersion: number;
  readonly result: "passed" | "failed" | "invalid"; readonly evidenceDigest: string;
  readonly sourceKind: TaskTrace["sourceKind"];
}
export interface TraceRecord extends TaskTrace {
  readonly taskId: string;
  readonly events: readonly DurableRuntimeLifecycleEvent[];
  readonly attempts: readonly ModelAttemptRecord[];
  readonly promptDigests: readonly string[];
  readonly historyDigest: string;
  readonly untrustedTranscript: string;
  readonly transcriptTruncated: boolean;
  readonly outcome?: TaskOutcomeReceipt;
  readonly toolArchives?: readonly ToolArchiveEvidence[];
  readonly toolInvocations?: readonly { readonly callId: string; readonly toolName: string; readonly inputDigest: string }[];
}
export interface ToolArchiveEvidence {
  readonly toolCallId: string; readonly hash: string; readonly locator: string;
  readonly status: "available" | "unavailable"; readonly untrustedPreview?: string; readonly truncated?: boolean;
}
export interface RunProvenance {
  readonly runId: string; readonly sessionId: string; readonly taskId: string;
  readonly sourceKind: TaskTrace["sourceKind"]; readonly ownerId: string;
}
export function runProvenance(value: RunProvenance): RunProvenance {
  if (!value || [value.runId, value.sessionId, value.taskId, value.ownerId].some(item => typeof item !== "string" || !item.trim() || item.length > 512) ||
    !["production", "development", "regression", "held-out", "evolution"].includes(value.sourceKind)) throw new Error("evolution_provenance_invalid");
  return freezeJson(value);
}
/** Host-only registrations: immutable partitions and independent results, outside model text. */
export class EvolutionObservationRegistry {
  private readonly origins: ProfileRecordStore<RunProvenance>;
  private readonly outcomes: ProfileRecordStore<TaskOutcomeReceipt>;
  constructor(storage: StorageBackendResolver, backendId: string) {
    this.origins = new ProfileRecordStore(storage, backendId, "evolution/run-origins/v1", value => runProvenance(value as RunProvenance));
    this.outcomes = new ProfileRecordStore(storage, backendId, "evolution/task-outcomes/v1", value => taskOutcomeReceipt(value as TaskOutcomeReceipt));
  }
  recordOrigin(value: RunProvenance) { const item = runProvenance(value); return this.origins.create(item.runId, item); }
  async recordOutcome(value: TaskOutcomeReceipt) {
    const item = taskOutcomeReceipt(value), origin = await this.origins.get(item.runId);
    if (!origin || origin.taskId !== item.taskId || origin.sourceKind !== item.sourceKind) throw new Error("evolution_outcome_provenance_required");
    return this.outcomes.create(item.runId, item);
  }
  async get(runId: string) { return { origin: await this.origins.get(runId), outcome: await this.outcomes.get(runId) }; }
  async list() { return { origins: await this.origins.list(), outcomes: await this.outcomes.list() }; }
}
const sha = (value: string) => /^[a-f0-9]{64}$/u.test(value);
export function taskOutcomeReceipt(value: TaskOutcomeReceipt): TaskOutcomeReceipt {
  if (!value || Object.keys(value).some(key => !["runId", "taskId", "verifierId", "verifierVersion", "result", "evidenceDigest", "sourceKind"].includes(key)) ||
      [value.runId, value.taskId, value.verifierId].some(item => typeof item !== "string" || !item.trim() || item.length > 512) || !Number.isSafeInteger(value.verifierVersion) || value.verifierVersion < 1 ||
      !["passed", "failed", "invalid"].includes(value.result) || !sha(value.evidenceDigest) ||
      !["production", "development", "regression", "held-out", "evolution"].includes(value.sourceKind)) throw new Error("evolution_outcome_invalid");
  return freezeJson(value);
}
export function captureTaskTrace(input: {
  readonly sessionId: string; readonly runId: string; readonly history: SessionHistorySnapshot;
  readonly events: readonly DurableRuntimeLifecycleEvent[]; readonly attempts: readonly ModelAttemptRecord[];
  readonly prompts?: readonly SystemPromptSnapshot[]; readonly profileSnapshotDigest?: string;
  readonly outcome?: TaskOutcomeReceipt; readonly sourceKind?: TaskTrace["sourceKind"];
  readonly taskId?: string; readonly toolArchives?: readonly ToolArchiveEvidence[];
}): TraceRecord {
  if (input.history.sessionId !== input.sessionId) throw new Error("evolution_trace_session_mismatch");
  const events = input.events.filter(event => event.runId === input.runId);
  if (events.some(event => event.type === "run.opened" && event.scope !== input.sessionId)) throw new Error("evolution_trace_session_mismatch");
  const terminal = events.filter(event => ["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)).at(-1);
  if (!terminal) throw new Error("evolution_trace_requires_committed_terminal");
  const records = input.history.records.filter(record => record.kind === "message" && record.runId === input.runId);
  const transcript = JSON.stringify(records.filter(record => record.kind === "message" && !["system", "developer"].includes(record.message.role)));
  const outcome = input.outcome ? taskOutcomeReceipt(input.outcome) : undefined;
  if (outcome && outcome.runId !== input.runId) throw new Error("evolution_trace_outcome_mismatch");
  const sourceKind = outcome?.sourceKind ?? input.sourceKind ?? "production";
  if (input.sourceKind && sourceKind !== input.sourceKind) throw new Error("evolution_trace_partition_mismatch");
  const historyDigest = digest(records), promptDigests = (input.prompts ?? []).filter(item => item.runId === input.runId).map(item => item.digest);
  const dispatched = new Set(events.filter(event => event.type === "tool.dispatched").map(event => `${event.callId}:${event.toolName}`));
  const toolInvocations = records.flatMap(record => record.kind === "message" && record.message.role === "assistant" ? record.message.toolCalls ?? [] : []).flatMap(call => {
    if (!dispatched.has(`${call.id}:${call.name}`)) return [];
    try { return [{ callId: call.id, toolName: call.name, inputDigest: digest({ name: call.name, input: JSON.parse(call.argumentsJson) }) }]; }
    catch { return []; }
  });
  const taskOutcome = outcome?.result === "passed" ? "passed" : outcome?.result === "failed" ? "failed" : "unknown";
  const body = {
    sourceKind, sessionId: input.sessionId, runId: input.runId, taskId: outcome?.taskId ?? input.taskId ?? input.runId,
    terminalStatus: terminal.type, taskOutcome, events, attempts: input.attempts.filter(item => item.runId === input.runId),
    promptDigests, historyDigest, capturedAt: terminal.occurredAt,
    evidenceRefs: [`session:${input.sessionId}:${input.runId}:${historyDigest}`, ...promptDigests.map(value => `prompt:${value}`), ...(outcome ? [`verifier:${outcome.verifierId}@${outcome.verifierVersion}:${outcome.evidenceDigest}`] : []), ...(input.toolArchives ?? []).map(item => `tool-archive:${item.toolCallId}:${item.hash}`)],
    summary: `Run ${terminal.type}; independent task result ${taskOutcome}.`,
    untrustedTranscript: transcript.slice(0, 64_000), transcriptTruncated: transcript.length > 64_000,
    ...(input.profileSnapshotDigest ? { profileSnapshotDigest: input.profileSnapshotDigest } : {}), ...(outcome ? { outcome } : {}),
    ...(input.toolArchives ? { toolArchives: input.toolArchives } : {}),
    ...(toolInvocations.length ? { toolInvocations } : {}),
  } as const;
  const key = digest(body);
  return freezeJson({ ...body, id: `trace-${key}`, digest: key });
}
export function validateTrace(value: unknown): TraceRecord {
  const item = value as TraceRecord;
  if (!item || !sha(item.digest) || item.id !== `trace-${item.digest}` || !Array.isArray(item.events) || !Array.isArray(item.attempts) || !Array.isArray(item.evidenceRefs) || typeof item.untrustedTranscript !== "string") throw new Error("evolution_trace_invalid");
  const { id: _, digest: __, ...body } = item;
  if (digest(body) !== item.digest) throw new Error("evolution_trace_digest_mismatch");
  if (item.toolInvocations !== undefined && (!Array.isArray(item.toolInvocations) || item.toolInvocations.length > 10_000 || new Set(item.toolInvocations.map(row => row.callId)).size !== item.toolInvocations.length || item.toolInvocations.some(row => !row.callId || !row.toolName || !sha(row.inputDigest) || !item.events.some(event => event.type === "tool.dispatched" && event.callId === row.callId && event.toolName === row.toolName)))) throw new Error("evolution_trace_tool_provenance_invalid");
  if (item.toolArchives !== undefined && (!Array.isArray(item.toolArchives) || item.toolArchives.length > 256 || new Set(item.toolArchives.map(row => row.toolCallId)).size !== item.toolArchives.length || item.toolArchives.some(row =>
    !row.toolCallId || !sha(row.hash) || typeof row.locator !== "string" || row.locator.length > 4096 || !["available", "unavailable"].includes(row.status) ||
    row.untrustedPreview !== undefined && (typeof row.untrustedPreview !== "string" || row.untrustedPreview.length > 4096) ||
    !item.evidenceRefs.includes(`tool-archive:${row.toolCallId}:${row.hash}`)) || JSON.stringify(item.toolArchives).length > 256_000)) throw new Error("evolution_trace_archive_invalid");
  if (!["production", "development", "regression", "held-out", "evolution"].includes(item.sourceKind) || !["passed", "failed", "unknown"].includes(item.taskOutcome) ||
      typeof item.runId !== "string" || !item.runId || typeof item.sessionId !== "string" || !item.sessionId || typeof item.taskId !== "string" || !item.taskId ||
      !sha(item.historyDigest) || !Array.isArray(item.promptDigests) || item.promptDigests.some(value => !sha(value)) ||
      item.evidenceRefs.some(value => typeof value !== "string" || !value) || item.untrustedTranscript.length > 64_000 || typeof item.transcriptTruncated !== "boolean" ||
      !Number.isFinite(Date.parse(item.capturedAt)) || item.events.some(event => event.runId !== item.runId || event.type === "run.opened" && event.scope !== item.sessionId) ||
      item.attempts.some(attempt => attempt.runId !== item.runId) || item.profileSnapshotDigest !== undefined && !sha(item.profileSnapshotDigest)) throw new Error("evolution_trace_invalid");
  const terminal = item.events.filter(event => ["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)).at(-1);
  if (!terminal || terminal.type !== item.terminalStatus || terminal.occurredAt !== item.capturedAt) throw new Error("evolution_trace_terminal_mismatch");
  if (item.outcome) {
    const outcome = taskOutcomeReceipt(item.outcome);
    if (outcome.runId !== item.runId || outcome.taskId !== item.taskId || outcome.sourceKind !== item.sourceKind ||
      item.taskOutcome !== (outcome.result === "invalid" ? "unknown" : outcome.result) ||
      !item.evidenceRefs.includes(`verifier:${outcome.verifierId}@${outcome.verifierVersion}:${outcome.evidenceDigest}`)) throw new Error("evolution_trace_outcome_mismatch");
  } else if (item.taskOutcome !== "unknown") throw new Error("evolution_trace_outcome_required");
  return freezeJson(item);
}
export class EvolutionTraceArchive {
  private readonly traces: ProfileRecordStore<TraceRecord>;
  private readonly partitions: ProfileRecordStore<{ readonly runId: string; readonly sessionId: string; readonly sourceKind: TaskTrace["sourceKind"] }>;
  private initialized: Promise<void> | undefined;
  constructor(storage: StorageBackendResolver, backendId: string) {
    this.traces = new ProfileRecordStore(storage, backendId, "evolution/traces/v1", validateTrace);
    this.partitions = new ProfileRecordStore(storage, backendId, "evolution/trace-partitions/v1", value => {
      const row = value as { readonly runId: string; readonly sessionId: string; readonly sourceKind: TaskTrace["sourceKind"] };
      if (!row || typeof row.runId !== "string" || !row.runId || typeof row.sessionId !== "string" || !row.sessionId || !["production", "development", "regression", "held-out", "evolution"].includes(row.sourceKind)) throw new Error("evolution_trace_partition_invalid");
      return freezeJson(row);
    });
  }
  private partition(trace: TraceRecord) { return this.partitions.create(trace.runId, { runId: trace.runId, sessionId: trace.sessionId!, sourceKind: trace.sourceKind }); }
  private initialize(): Promise<void> {
    // Backfill identities once; conflicting legacy partitions fail closed instead of feeding generation.
    return this.initialized ??= (async () => { for (const trace of await this.traces.list()) await this.partition(trace); })();
  }
  async put(trace: TraceRecord) {
    const stable = validateTrace(trace); await this.initialize(); await this.partition(stable);
    return this.traces.create(stable.id, stable);
  }
  async list(options: { readonly forGeneration?: boolean } = {}) {
    await this.initialize();
    const rows = await this.traces.list();
    const ordered = [...rows].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
    if (!options.forGeneration) return ordered;
    const selected = new Map<string, TraceRecord>();
    for (const row of ordered) {
      if (["held-out", "evolution"].includes(row.sourceKind)) continue;
      const old = selected.get(row.runId);
      if (!old || traceRichness(row) >= traceRichness(old)) selected.set(row.runId, row);
    }
    return [...selected.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
  }
}
function traceRichness(row: TraceRecord): number { return (row.outcome ? 1e9 : 0) + row.events.length * 1000 + row.attempts.length * 10 + (row.toolArchives?.length ?? 0); }

/** Conservative aggregation. Heuristics create hypotheses, never claim causal attribution. */
export function diagnoseTraces(traces: readonly TraceRecord[], minimumTasks = 3, options: { readonly maxModelCalls?: number; readonly maxTokens?: number; readonly repeatedToolCalls?: number; readonly maxCostByCurrency?: Readonly<Record<string, number>> } = {}): readonly EvolutionTicket[] {
  if (!Number.isSafeInteger(minimumTasks) || minimumTasks < 1) throw new Error("evolution_observer_threshold_invalid");
  const groups = new Map<string, TraceRecord[]>();
  for (const trace of traces) {
    if (["held-out", "evolution"].includes(trace.sourceKind)) continue;
    const category = classifyFailure(trace);
    const patterns: string[] = category ? [`${category}:failure`] : [];
    if (!category || category === "harness") {
      const counts = new Map<string, number>();
      for (const event of trace.toolInvocations ?? []) counts.set(`${event.toolName}:${event.inputDigest}`, (counts.get(`${event.toolName}:${event.inputDigest}`) ?? 0) + 1);
      if ([...counts.values()].some(count => count >= (options.repeatedToolCalls ?? 3))) patterns.push("harness:repeated-tool");
      const complete = trace.attempts.length > 0 && trace.attempts.every(item => item.status === "completed" && !!item.usage);
      if (complete && (trace.attempts.length > (options.maxModelCalls ?? 12) || trace.attempts.reduce((sum, item) => sum + item.usage!.totalTokens, 0) > (options.maxTokens ?? 32_000))) patterns.push("harness:high-token-use");
      if (complete && Object.entries(options.maxCostByCurrency ?? {}).some(([currency, maximum]) => {
        const costs = trace.attempts.filter(item => item.cost?.status === "available" && item.cost.currency === currency);
        return costs.length === trace.attempts.length && costs.reduce((sum, item) => sum + (item.cost?.status === "available" ? item.cost.totalCost : 0), 0) > maximum;
      })) patterns.push("harness:high-cost");
    }
    for (const pattern of patterns) { const rows = groups.get(pattern) ?? []; rows.push(trace); groups.set(pattern, rows); }
  }
  return [...groups].flatMap(([keyPattern, rows]) => {
    const [category, pattern] = keyPattern.split(":") as [EvolutionTicket["failureCategory"], NonNullable<EvolutionTicket["pattern"]>];
    const latest = [...new Map(rows.map(row => [row.taskId, row])).values()];
    if (latest.length < minimumTasks) return [];
    const failureCategory = category as EvolutionTicket["failureCategory"];
    const traceIds = latest.map(row => row.id).sort(), traceDigests = latest.map(row => row.digest).sort();
    const key = digest({ category, pattern, traceDigests });
    return [{ id: `ticket-${key}`, traceIds, traceDigests, failureCategory,
      evidenceRefs: [...new Set(latest.flatMap(row => row.evidenceRefs))],
      summary: `${latest.length} independent tasks share ${category} symptoms`,
      problem: pattern === "repeated-tool" ? "Repeated identical Tool invocations across independent tasks; inspect redundant work and retry behavior."
        : pattern === "high-token-use" ? "High measured request or Token use across independent tasks; inspect context selection and execution strategy."
        : pattern === "high-cost" ? "Measured task cost exceeds the configured currency threshold; inspect the strategy before changing it."
        : category === "harness" ? "Independent validation failed after completed Runs; inspect verification and execution behavior." : `Investigate ${category} failures before changing Harness behavior.`,
      hypothesis: "A repeated symptom may have a shared cause; verify alternatives against the referenced traces.",
      pattern, alternatives: pattern === "failure" ? ["Environment, permissions or project-specific defects may explain the symptom.", "The verifier itself may require inspection."] : ["Legitimate task complexity or explicit user requirements may justify the work.", "Transient errors or changing external state may justify repeated calls."],
      target: "prompt" as const, confidence: category === "harness" ? 0.5 : 0.25 }];
  });
}
function classifyFailure(trace: TraceRecord): EvolutionTicket["failureCategory"] | undefined {
  // Provider facts take precedence over a completed Run's task-level failure.
  // A retry can recover the stream without resolving the environmental cause.
  if (trace.attempts.some(item => item.error && (["network_error", "missing_api_key"].includes(item.error.code) || [401, 403, 408, 429, 500, 502, 503, 504].includes(item.error.status ?? 0)))) return "environment";
  const reasons = trace.events.map(item => item.reason ?? "").join(" ").toLowerCase();
  if (/permission_denied|approval_denied|not_authorized|capability_denied/u.test(reasons)) return "authorization";
  if (/econnrefused|enotfound|network_unavailable|provider_unavailable|rate_limit|authentication_failed/u.test(reasons)) return "environment";
  if (trace.taskOutcome === "failed" && trace.terminalStatus === "run.completed") return "harness";
  if (["run.failed", "run.interrupted"].includes(trace.terminalStatus)) return "unknown";
  return undefined;
}
