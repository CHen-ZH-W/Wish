import { graphDigest, normalizeTasks } from "./graph.js";
import { transitionTask } from "./transition.js";
import type { TaskGraph, TaskGraphRef, TaskSpec, TaskStatus, TaskStore, Tasks } from "./types.js";

export class TaskRuntime implements Tasks {
  private tail = Promise.resolve();
  private closed = false;
  constructor(private readonly store: TaskStore) {}
  async get(sessionId: string, version?: number): Promise<TaskGraph | undefined> {
    await this.tail;
    const collection = await this.store.get(sessionId);
    return version === undefined ? collection?.graphs.at(-1) : collection?.graphs.find((graph) => graph.version === version);
  }
  replace(sessionId: string, input: readonly TaskSpec[], expectedVersion: number): Promise<TaskGraph> {
    const tasks = normalizeTasks(input);
    return this.serial(async () => {
      const current = await this.store.get(sessionId);
      const latest = current?.graphs.at(-1);
      if ((latest?.version ?? 0) !== expectedVersion) throw new Error("Task graph version conflict");
      if ((current?.graphs.length ?? 0) >= 100) throw new Error("Task graph revision limit reached");
      const graph: TaskGraph = Object.freeze({ sessionId, version: expectedVersion + 1,
        state: "draft", digest: graphDigest(tasks), createdAt: new Date().toISOString(),
        tasks: Object.freeze(tasks.map((task) => Object.freeze({ ...task, status: "pending" as const }))),
      });
      await this.store.put({ schemaVersion: 1, sessionId, revision: (current?.revision ?? 0) + 1,
        graphs: [...current?.graphs ?? [], graph] }, current?.revision ?? 0);
      return graph;
    });
  }
  freeze(ref: TaskGraphRef, approvedPlanDigest: string): Promise<TaskGraph> {
    if (!/^[a-f0-9]{64}$/u.test(approvedPlanDigest)) throw new Error("Invalid approved Plan digest");
    return this.change(ref, (graph) => {
      if (graph.state === "frozen") {
        if (graph.approvedPlanDigest !== approvedPlanDigest) throw new Error("Task graph already belongs to another approval");
        return graph;
      }
      return Object.freeze({ ...graph, state: "frozen", approvedPlanDigest });
    });
  }
  transition(ref: TaskGraphRef, taskId: string, status: TaskStatus, attemptId: string, result?: string): Promise<TaskGraph> {
    return this.change(ref, (graph) => {
      if (graph.state !== "frozen") throw new Error("Only a frozen graph accepts execution transitions");
      const task = graph.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("Task not found");
      if (status === "running" && !task.dependencies.every((dep) => graph.tasks.some((item) => item.id === dep && item.status === "completed"))) throw new Error("Task dependencies are not complete");
      return Object.freeze({ ...graph, tasks: Object.freeze(graph.tasks.map((item) => item === task ? transitionTask(task, status, attemptId, result) : item)) });
    });
  }
  async close(): Promise<void> { this.closed = true; await this.tail; await this.store.close(); }
  private change(ref: TaskGraphRef, fn: (graph: TaskGraph) => TaskGraph): Promise<TaskGraph> {
    return this.serial(async () => {
      const current = await this.store.get(ref.sessionId);
      const graph = current?.graphs.find((item) => item.version === ref.version);
      if (!current || !graph || graph.digest !== ref.digest) throw new Error("Task graph identity conflict");
      const next = fn(graph);
      if (next !== graph) await this.store.put({ ...current, revision: current.revision + 1,
        graphs: current.graphs.map((item) => item === graph ? next : item) }, current.revision);
      return next;
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Tasks service closed"));
    const result = this.tail.then(fn); this.tail = result.then(() => {}, () => {}); return result;
  }
}
