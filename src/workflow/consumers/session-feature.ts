import type { Context } from "@deepseek-ai/cordis";
import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
export default { name: "workflow-session-feature", inject: ["application", "workflow", "workflowScheduler"], apply(ctx: Context) {
  registerManagedSessionFeature(ctx, "workflow", {
    async beforeRemoval(sessionId) {
      const runs = (await ctx.workflow.state.list()).filter(run => run.owner.parentSessionId === sessionId);
      if (runs.some(run => !["completed", "failed", "cancelled"].includes(run.status) || run.steps.some(step => step.attempts.some(attempt => ["prepared", "dispatched", "running"].includes(attempt.status) || (attempt.status === "interrupted" && attempt.disposition === "needs-reconciliation"))))) {
        throw new Error("关联 Workflow 尚未结束或需要核对，请先处理 Workflow。 ");
      }
    },
    async inspect(sessionId) {
      const runs = (await ctx.workflow.state.list()).filter(run => run.owner.parentSessionId === sessionId);
      if (!runs.length) return undefined;
      const uncertain = runs.flatMap(run => run.steps.flatMap(step => step.attempts.filter(attempt => attempt.status === "interrupted" && attempt.disposition === "needs-reconciliation").map(attempt => ({ runId: run.id, stepId: step.task.id, attemptId: attempt.id }))));
      const target = uncertain[0];
      return { key: "workflow", title: "Workflow 执行账本", titleEn: "Workflow execution ledger", text: JSON.stringify({ schedulerError: ctx.workflowScheduler.children.lastError, runs }, null, 2),
        token: target ? { ...target } : {}, actions: target ? [
          { name: "completed", label: "已确认完成", labelEn: "Confirmed complete", feedback: true }, { name: "not-completed", label: "确认可安全重试", labelEn: "Safe to retry", feedback: true }, { name: "unknown", label: "无法确认，停止此任务", labelEn: "Unknown; stop this task", feedback: true },
        ] : [],
      };
    },
    async act(sessionId, action, token, evidence) {
      if (!["completed", "not-completed", "unknown"].includes(action) || typeof token.runId !== "string" || typeof token.stepId !== "string" || typeof token.attemptId !== "string" || !evidence?.trim()) throw new Error("Reconciliation requires the Attempt identity and human evidence");
      const run = await ctx.workflow.state.get(token.runId);
      if (!run || run.owner.parentSessionId !== sessionId) throw new Error("Workflow not found in this Session");
      await ctx.workflow.state.reconcile({ runId: token.runId, stepId: token.stepId, attemptId: token.attemptId }, action as "completed" | "not-completed" | "unknown", "human-session-surface", evidence);
      await ctx.workflowScheduler.children.tick();
    },
  }, { codeReload: true });
} };
