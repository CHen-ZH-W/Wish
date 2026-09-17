export type TaskStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export interface TaskSpec {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly dependencies: readonly string[];
  readonly execution: { readonly role: string; readonly readOnly: boolean; readonly timeoutMs: number };
}
export interface Task extends TaskSpec {
  readonly status: TaskStatus;
  readonly attemptId?: string;
  readonly result?: string;
}
export interface TaskGraphRef { readonly sessionId: string; readonly version: number; readonly digest: string }
export interface TaskGraph extends TaskGraphRef {
  readonly state: "draft" | "frozen";
  readonly tasks: readonly Task[];
  readonly createdAt: string;
  readonly approvedPlanDigest?: string;
}
export interface TaskCollection {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly graphs: readonly TaskGraph[];
}
export interface TaskStore {
  get(sessionId: string): Promise<TaskCollection | undefined>;
  put(state: TaskCollection, expectedRevision: number): Promise<void>;
  close(): Promise<void>;
}
export interface Tasks {
  get(sessionId: string, version?: number): Promise<TaskGraph | undefined>;
  replace(sessionId: string, tasks: readonly TaskSpec[], expectedVersion: number): Promise<TaskGraph>;
  freeze(ref: TaskGraphRef, approvedPlanDigest: string): Promise<TaskGraph>;
  transition(ref: TaskGraphRef, taskId: string, status: TaskStatus, attemptId: string, result?: string): Promise<TaskGraph>;
  close(): Promise<void>;
}
