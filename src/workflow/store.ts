import { createHash } from "node:crypto";
import { StorageDomain, type DomainSpec } from "../storage/domain.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { KV_ABSENT } from "../storage/kv.js";
import { PERMISSION_PROFILES } from "../permissions/types.js";
import { normalizeTasks } from "../tasks/graph.js";
import { fingerprint } from "./transition.js";
import { snapshotChildCapabilities } from "../subagents/identity.js";
import type { ModelsConfiguration } from "../models/types.js";
import type { WorkflowAttempt, WorkflowRun, WorkflowStore } from "./types.js";

/** A complete Run and its event prefix are committed in one CAS, never separately. */
export function snapshotWorkflow(value: unknown): WorkflowRun {
  const run = value as WorkflowRun;
  if (!run || run.schemaVersion !== 1 || typeof run.key !== "string" || !run.key.trim() || run.id !== `wf-${fingerprint(run.key)}` ||
      !Number.isSafeInteger(run.revision) || run.revision < 1 || !["task-graph", "subagent"].includes(run.kind) ||
      !["running", "completed", "failed", "blocked", "cancelled", "interrupted"].includes(run.status) ||
      !PERMISSION_PROFILES.includes(run.permissionProfile) || !Array.isArray(run.availableTools) || run.availableTools.some(t => typeof t !== "string") ||
      !run.owner || Object.values(run.owner).some(v => typeof v !== "string" || !v.trim()) ||
      ![run.owner.parentAgentId, run.owner.parentSessionId, run.owner.parentRunId, run.owner.workspaceRoot].every(Boolean) ||
      !Number.isFinite(Date.parse(run.createdAt)) || !Number.isFinite(Date.parse(run.updatedAt)) ||
      !Number.isSafeInteger(run.circuitFailures) || run.circuitFailures < 0 ||
      !run.budget || ![run.budget.maxTotalAttempts, run.budget.maxAttemptsPerStep, run.budget.maxCallsPerEdge, run.budget.circuitThreshold].every(v => Number.isSafeInteger(v) && v > 0 && v <= 10000) ||
      !Array.isArray(run.steps) || !Array.isArray(run.events) || run.events.length !== run.revision) throw new Error("Invalid Workflow state");
  const specs = normalizeTasks(run.steps.map(step => step.task));
  const ids = new Set<string>();
  const steps = run.steps.map((step, index) => {
    if (!["pending", "running", "completed", "failed", "blocked", "cancelled", "interrupted"].includes(step.status) || !Array.isArray(step.attempts)) throw new Error("Invalid Workflow Step");
    const attempts = step.attempts.map((attempt: WorkflowAttempt, ordinal: number) => {
      if (typeof attempt.id !== "string" || !attempt.id || ids.has(attempt.id) || attempt.ordinal !== ordinal + 1 ||
          attempt.idempotencyKey !== `${run.id}/${step.task.id}/${ordinal + 1}` || typeof attempt.strategy !== "string" || !attempt.strategy.trim() ||
          typeof attempt.edge !== "string" || !attempt.edge || !Number.isFinite(Date.parse(attempt.startedAt)) || !Number.isFinite(Date.parse(attempt.deadline)) ||
          !["prepared", "dispatched", "running", "completed", "failed", "cancelled", "interrupted"].includes(attempt.status) ||
          !["resumable", "retry-safe", "needs-reconciliation", "terminal-failed"].includes(attempt.recoveryPolicy) ||
          (attempt.disposition !== undefined && !["resumable", "retry-safe", "needs-reconciliation", "terminal-failed"].includes(attempt.disposition)) ||
          (ordinal < step.attempts.length - 1 && ["prepared", "dispatched", "running"].includes(attempt.status))) throw new Error("Invalid Workflow Attempt");
      ids.add(attempt.id);
      return Object.freeze({ ...attempt });
    });
    return Object.freeze({ ...step, task: specs[index]!, attempts: Object.freeze(attempts) });
  });
  const events = run.events.map((event, i) => {
    if (event.sequence !== i + 1 || typeof event.type !== "string" || !event.type || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid Workflow event sequence");
    return Object.freeze({ ...event });
  });
  return Object.freeze({ ...run, owner: Object.freeze({ ...run.owner }), budget: Object.freeze({ ...run.budget }),
    allowedCapabilities: snapshotChildCapabilities(run.allowedCapabilities),
    ...(run.graph ? { graph: Object.freeze({ ...run.graph }) } : {}),
    ...(run.modelsConfiguration ? { modelsConfiguration: freezeJson(run.modelsConfiguration) } : {}),
    availableTools: Object.freeze([...run.availableTools]), steps: Object.freeze(steps), events: Object.freeze(events) });
}

function freezeJson<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (node: unknown): void => { if (node && typeof node === "object") { for (const entry of Object.values(node)) freeze(entry); Object.freeze(node); } };
  freeze(copy); return copy;
}

function validateCommit(run: WorkflowRun, previous: WorkflowRun | undefined, expected: number): WorkflowRun {
  if ((previous?.revision ?? 0) !== expected || run.revision !== expected + 1) throw new Error("Workflow store conflict");
  const stable = snapshotWorkflow(run);
  if (previous && JSON.stringify(stable.events.slice(0, previous.events.length)) !== JSON.stringify(previous.events)) throw new Error("Workflow history is append-only");
  return stable;
}
export class MemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>();
  async list() { return Object.freeze([...this.runs.values()]); }
  async get(id: string) { return this.runs.get(id); }
  async put(run: WorkflowRun, expected: number) { this.runs.set(run.id, validateCommit(run, this.runs.get(run.id), expected)); }
  async remove(id: string) { this.runs.delete(id); }
  async close() {}
}
function encodeRuns(runs: readonly WorkflowRun[]): Uint8Array {
  const configurations: Record<string, ModelsConfiguration> = Object.create(null);
  const storedRuns = runs.map(run => {
    const { modelsConfiguration, ...rest } = run;
    if (modelsConfiguration === undefined) return rest;
    const serialized = JSON.stringify(modelsConfiguration);
    const ref = createHash("sha256").update(serialized).digest("hex");
    configurations[ref] ??= modelsConfiguration;
    return { ...rest, modelsConfigurationRef: ref };
  });
  return new TextEncoder().encode(JSON.stringify({ configurations, runs: storedRuns }));
}

function decodeRuns(bytes: Uint8Array, version: number): unknown {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (version === 1) return parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Workflow store");
  const { configurations, runs } = parsed as Record<string, unknown>;
  if (!configurations || typeof configurations !== "object" || Array.isArray(configurations) || !Array.isArray(runs)) throw new Error("Invalid Workflow store");
  return runs.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Workflow Run");
    const { modelsConfigurationRef, ...run } = entry as Record<string, unknown>;
    if (modelsConfigurationRef === undefined) return run;
    if (typeof modelsConfigurationRef !== "string" || !/^[a-f0-9]{64}$/u.test(modelsConfigurationRef) ||
        !Object.hasOwn(configurations, modelsConfigurationRef)) throw new Error("Invalid Workflow configuration reference");
    const configuration = (configurations as Record<string, unknown>)[modelsConfigurationRef];
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) ||
        createHash("sha256").update(JSON.stringify(configuration)).digest("hex") !== modelsConfigurationRef) throw new Error("Invalid Workflow configuration");
    return { ...run, modelsConfiguration: configuration };
  });
}

const workflowDomain: DomainSpec<void, readonly WorkflowRun[]> = {
  id: "workflow/runs", schemaVersion: 2, shape: "global", requirements: { kv: { list: false } },
  resolve: () => ({ default: { kind: "value", value: [] } }),
  encode: encodeRuns,
  decode: decodeRuns,
  migrate: ({ value, fromVersion }) => {
    if (fromVersion !== 1) throw new Error("Unsupported Workflow store version");
    return value;
  },
  validate: value => {
    if (!Array.isArray(value)) throw new Error("Invalid Workflow store");
    const runs = value.map(snapshotWorkflow);
    if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error("Duplicate Workflow Run");
    return Object.freeze(runs);
  },
};
export class DomainWorkflowStore implements WorkflowStore {
  private readonly domain;
  constructor(storage: StorageBackendResolver, backendId: string) { this.domain = new StorageDomain({ storage, backendId, spec: workflowDomain }).resolve(undefined); }
  async list() { return (await this.domain.load())!.value; }
  async get(id: string) { return (await this.list()).find(run => run.id === id); }
  async put(run: WorkflowRun, expected: number) {
    const current = (await this.domain.load())!;
    const stable = validateCommit(run, current.value.find(r => r.id === run.id), expected);
    const runs = current.value.filter(r => r.id !== run.id);
    await this.domain.save([...runs, stable], current.revision === undefined ? KV_ABSENT : { kind: "revision", revision: current.revision });
  }
  async remove(id: string) {
    const current = (await this.domain.load())!;
    if (!current.value.some(run => run.id === id)) return;
    await this.domain.save(current.value.filter(run => run.id !== id), current.revision === undefined ? KV_ABSENT : { kind: "revision", revision: current.revision });
  }
  async close() {}
}
