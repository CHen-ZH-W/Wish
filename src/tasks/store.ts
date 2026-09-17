import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { KV_ABSENT } from "../storage/kv.js";
import { graphDigest, normalizeTasks } from "./graph.js";
import type { TaskCollection, TaskStore } from "./types.js";

export function snapshotCollection(value: unknown): TaskCollection {
  const state = value as TaskCollection;
  if (!state || state.schemaVersion !== 1 || typeof state.sessionId !== "string" || !state.sessionId.trim() || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Array.isArray(state.graphs) || !state.graphs.length || state.graphs.length > 100) throw new Error("Invalid Tasks state");
  const graphs = state.graphs.map((graph, index) => {
    const specs = normalizeTasks(graph.tasks);
    if (graph.sessionId !== state.sessionId || graph.version !== index + 1 || graph.digest !== graphDigest(specs) || !["draft", "frozen"].includes(graph.state) || !Number.isFinite(Date.parse(graph.createdAt))) throw new Error("Invalid Task graph identity");
    if (graph.state === "frozen" && !/^[a-f0-9]{64}$/u.test(graph.approvedPlanDigest ?? "")) throw new Error("Frozen graph lacks approval");
    const tasks = specs.map((spec, i) => {
      const task = graph.tasks[i]!;
      if (!["pending", "running", "completed", "failed", "blocked", "cancelled"].includes(task.status) ||
          (graph.state === "draft" && task.status !== "pending") ||
          (task.status !== "pending" && (typeof task.attemptId !== "string" || !task.attemptId))) throw new Error("Invalid task execution state");
      return Object.freeze({ ...spec, status: task.status, ...(task.attemptId === undefined ? {} : { attemptId: task.attemptId }), ...(task.result === undefined ? {} : { result: task.result }) });
    });
    return Object.freeze({ ...graph, tasks: Object.freeze(tasks) });
  });
  return Object.freeze({ schemaVersion: 1, sessionId: state.sessionId, revision: state.revision, graphs: Object.freeze(graphs) });
}

export const taskDomain: DomainSpec<string, TaskCollection> = {
  id: "tasks/sessions", schemaVersion: 1, shape: "keyed", requirements: { kv: { list: false } },
  resolve: key => ({ key, default: DOMAIN_ABSENT }),
  encode: value => new TextEncoder().encode(JSON.stringify(snapshotCollection(value))),
  decode: value => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)), validate: snapshotCollection,
};
export class DomainTaskStore implements TaskStore {
  private readonly domain: StorageDomain<string, TaskCollection>;
  constructor(storage: StorageBackendResolver, backendId: string) { this.domain = new StorageDomain({ storage, backendId, spec: taskDomain }); }
  async get(sessionId: string) { return (await this.domain.resolve(sessionId).load())?.value; }
  async put(state: TaskCollection, expectedRevision: number) {
    const target = this.domain.resolve(state.sessionId), current = await target.load();
    if ((current?.value.revision ?? 0) !== expectedRevision) throw new Error("Tasks store conflict");
    await target.save(state, current ? { kind: "revision", revision: current.revision! } : KV_ABSENT);
  }
  async close() {}
}
export class MemoryTaskStore implements TaskStore {
  private states = new Map<string, TaskCollection>();
  async get(sessionId: string) { return this.states.get(sessionId); }
  async put(state: TaskCollection, expectedRevision: number) {
    if ((this.states.get(state.sessionId)?.revision ?? 0) !== expectedRevision) throw new Error("Tasks store conflict");
    this.states.set(state.sessionId, snapshotCollection(state));
  }
  async close() {}
}
