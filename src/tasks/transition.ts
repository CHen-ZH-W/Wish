import type { Task, TaskStatus } from "./types.js";

export function transitionTask(task: Task, status: TaskStatus, attemptId: string, result?: string): Task {
  if (!attemptId.trim()) throw new Error("Task transition requires Attempt identity");
  if (task.status === status && task.attemptId === attemptId && task.result === result) return task;
  const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
    pending: ["running", "blocked", "cancelled"], running: ["completed", "failed", "blocked", "cancelled"],
    failed: ["running", "blocked", "cancelled"], blocked: ["running", "cancelled"], completed: [], cancelled: [],
  };
  if (!allowed[task.status]?.includes(status)) throw new Error(`Illegal task transition ${task.status} -> ${status}`);
  if (task.status === "running" && task.attemptId !== attemptId) throw new Error("Stale task Attempt");
  const { result: _result, ...rest } = task;
  return Object.freeze({ ...rest, status, attemptId, ...(result === undefined ? {} : { result }) });
}
