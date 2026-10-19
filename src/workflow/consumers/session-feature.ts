import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { SessionFeature } from "../../apps/session-features.js";
import { activeAttempt } from "../transition.js";
import type { Workflow, WorkflowRun } from "../types.js";

/** Archiving fences execution and uncertain effects, not an explicitly retryable idle ledger. */
export function workflowBlocksSessionRemoval(run: WorkflowRun): boolean {
  if (run.status === "running" || run.status === "interrupted") return true;
  return run.steps.some(step => step.attempts.some(attempt => activeAttempt(attempt) ||
    (attempt.status === "interrupted" && attempt.disposition !== "retry-safe" && attempt.disposition !== "terminal-failed")));
}

type WorkflowSessionScheduler = {
  readonly lastError: string | undefined;
  tick(): Promise<void>;
  cancel(id: string, reason: string): Promise<void>;
};

export function createWorkflowSessionFeature(workflow: Pick<Workflow, "list" | "get" | "reconcile" | "remove">,
  scheduler: WorkflowSessionScheduler | (() => WorkflowSessionScheduler | undefined)): SessionFeature {
  const currentScheduler = typeof scheduler === "function" ? scheduler : () => scheduler;
  const owned = async (sessionId: string) => (await workflow.list()).filter(run => run.owner.parentSessionId === sessionId);
  const purge = async (runs: readonly WorkflowRun[]) => {
    if (!runs.length) return;
    const active = runs.filter(run => !["completed", "failed", "cancelled"].includes(run.status));
    const available = currentScheduler();
    if (active.length && !available) throw new Error("Workflow scheduler is unavailable; owned work cannot be stopped");
    if (available) {
      for (const run of active) await available.cancel(run.id, "Owner Run stopped or Session deleted");
      await available.tick();
    }
    for (const run of runs) await workflow.remove(run.id);
  };
  return {
    purgeOrder: 10,
    async purgeRun(sessionId, runId) { await purge((await owned(sessionId)).filter(run => run.owner.parentRunId === runId)); },
    async purgeSession(sessionId) { await purge(await owned(sessionId)); },
    async beforeRemoval(sessionId, operation) {
      const runs = await owned(sessionId);
      if (operation === "delete") {
        // Deleting the owner is an explicit request to end its background work.
        // Keep the ledger until purgeSession has confirmed quiescence and removed it.
        const active = runs.filter(workflowBlocksSessionRemoval);
        const needsScheduler = runs.some(run => !["completed", "failed", "cancelled"].includes(run.status));
        const available = needsScheduler ? currentScheduler() : undefined;
        if (needsScheduler && !available) throw new Error("Workflow scheduler is unavailable; owned work cannot be stopped");
        for (const run of active) await available!.cancel(run.id, "Owner Session deleted");
        if ((await owned(sessionId)).some(workflowBlocksSessionRemoval)) throw new Error("关联 Workflow 仍在运行，请稍后重试删除。");
        return;
      }
      if (runs.some(workflowBlocksSessionRemoval)) throw new Error("关联 Workflow 尚未结束或需要核对，请先处理 Workflow。");
    },
    async inspect(sessionId) {
      const runs = await owned(sessionId);
      if (!runs.length) return undefined;
      const uncertain = runs.flatMap(run => run.steps.flatMap(step => step.attempts.filter(attempt => attempt.status === "interrupted" && attempt.disposition === "needs-reconciliation").map(attempt => ({ runId: run.id, stepId: step.task.id, attemptId: attempt.id }))));
      const target = uncertain[0];
      return { key: "workflow", title: "Workflow 执行账本", titleEn: "Workflow execution ledger", text: JSON.stringify({ schedulerError: currentScheduler()?.lastError, runs }, null, 2),
        token: target ? { ...target } : {}, actions: target ? [
          { name: "completed", label: "已确认完成", labelEn: "Confirmed complete", feedback: true }, { name: "not-completed", label: "确认可安全重试", labelEn: "Safe to retry", feedback: true }, { name: "unknown", label: "无法确认，停止此任务", labelEn: "Unknown; stop this task", feedback: true },
        ] : [],
      };
    },
    async act(sessionId, action, token, evidence) {
      if (!["completed", "not-completed", "unknown"].includes(action) || typeof token.runId !== "string" || typeof token.stepId !== "string" || typeof token.attemptId !== "string" || !evidence?.trim()) throw new Error("Reconciliation requires the Attempt identity and human evidence");
      const run = await workflow.get(token.runId);
      if (!run || run.owner.parentSessionId !== sessionId) throw new Error("Workflow not found in this Session");
      await workflow.reconcile({ runId: token.runId, stepId: token.stepId, attemptId: token.attemptId }, action as "completed" | "not-completed" | "unknown", "human-session-surface", evidence);
      await currentScheduler()?.tick();
    },
  };
}

export default { name: "workflow-session-feature", inject: ["application", "workflow"], apply(ctx: Context) {
  registerManagedSessionFeature(ctx, "workflow", createWorkflowSessionFeature(ctx.workflow.state, () => ctx.get("workflowScheduler")?.children), { codeReload: true });
} };
