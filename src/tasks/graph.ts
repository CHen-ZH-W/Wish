import { createHash } from "node:crypto";
import type { TaskGraph, TaskSpec } from "./types.js";

export function normalizeTasks(input: readonly TaskSpec[]): readonly TaskSpec[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Task list must contain at most 100 tasks");
  const tasks = input.map((task) => {
    if (!task || typeof task !== "object") throw new Error("Invalid task");
    const execution = task.execution;
    if (!execution || typeof execution.readOnly !== "boolean" || !Number.isSafeInteger(execution.timeoutMs) || execution.timeoutMs < 1 || execution.timeoutMs > 86_400_000) throw new Error("Invalid task execution limits");
    if (!Array.isArray(task.dependencies)) throw new Error("Task dependencies must be an array");
    const dependencies = task.dependencies.map(id);
    if (new Set(dependencies).size !== dependencies.length) throw new Error("Duplicate dependency");
    return Object.freeze({ id: id(task.id), title: text(task.title),
      ...(task.description === undefined ? {} : { description: text(task.description) }),
      dependencies: Object.freeze(dependencies),
      execution: Object.freeze({ role: id(execution.role), readOnly: execution.readOnly, timeoutMs: execution.timeoutMs }),
    });
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("Duplicate task id");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) throw new Error("Task dependency cycle");
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) throw new Error(`Unknown dependency: ${taskId}`);
    visiting.add(taskId); task.dependencies.forEach(visit); visiting.delete(taskId); visited.add(taskId);
  };
  tasks.forEach((task) => visit(task.id));
  return Object.freeze(tasks);
}

export function graphDigest(tasks: readonly TaskSpec[]): string {
  return createHash("sha256").update(JSON.stringify(normalizeTasks(tasks))).digest("hex");
}

export function readyTasks(graph: TaskGraph) {
  const done = new Set(graph.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return graph.tasks.filter((task) => task.status === "pending" && task.dependencies.every((dep) => done.has(dep)));
}

function id(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(value)) throw new Error("Invalid task identifier");
  return value;
}
function text(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) throw new Error("Invalid task text");
  return value;
}
