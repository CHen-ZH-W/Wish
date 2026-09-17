import { createHash } from "node:crypto";
import type { WorkflowAttempt, WorkflowRun, WorkflowStep } from "./types.js";
export function fingerprint(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export function activeAttempt(attempt: WorkflowAttempt): boolean { return ["prepared", "dispatched", "running"].includes(attempt.status); }
export function deriveRun(run: WorkflowRun): WorkflowRun {
  if (run.status === "cancelled") return run;
  const candidates = run.steps.map(step => step.status === "blocked" && !step.attempts.length ? { ...step, status: "pending" as const } : step);
  const blocked = new Set(candidates.filter((step) => ["blocked", "failed", "cancelled"].includes(step.status)).map((step) => step.task.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of candidates) if (step.status === "pending" && !blocked.has(step.task.id) && step.task.dependencies.some((id) => blocked.has(id))) { blocked.add(step.task.id); changed = true; }
  }
  const steps = candidates.map((step) => step.status === "pending" && blocked.has(step.task.id) ? { ...step, status: "blocked" as const } : step);
  const status = steps.every((step) => step.status === "completed") ? "completed"
    : steps.some((step) => step.status === "running") ? "running"
    : steps.some((step) => step.status === "interrupted") ? "interrupted"
    : steps.some((step) => step.status === "failed" || step.status === "blocked") ? "blocked" : "running";
  return { ...run, status, steps };
}
export function replaceStep(run: WorkflowRun, stepId: string, fn: (step: WorkflowStep) => WorkflowStep): WorkflowRun {
  if (!run.steps.some((step) => step.task.id === stepId)) throw new Error("Workflow step not found");
  return deriveRun({ ...run, steps: run.steps.map((step) => step.task.id === stepId ? fn(step) : step) });
}
