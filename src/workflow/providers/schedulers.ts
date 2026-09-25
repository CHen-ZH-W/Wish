import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { WorkflowSchedulerService } from "../service.js";
import { ChildWorkflowScheduler } from "../child-scheduler.js";
import { registerPluginOwner } from "../../boot/plugin-control/owner-registry.js";
import type {} from "./continuations.js";
import type {} from "../../boot/plugin-control/code-reload.js";
export interface Config { readonly maxConcurrent?: number }
export const Config: s<Config> = s.object({ maxConcurrent: s.number().step(1).min(1).max(256) });

export default class WorkflowSchedulers extends WorkflowSchedulerService {
  static readonly inject = ["workflow", "workflowContinuations", "subagents", "permissions", "workspace", "agents"];
  static readonly Config = Config;
  readonly children: ChildWorkflowScheduler;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.children = new ChildWorkflowScheduler({ workflow: ctx.workflow.state, subagents: ctx.subagents,
      continuations: ctx.workflowContinuations.state,
      ...(config.maxConcurrent === undefined ? {} : { maxConcurrent: config.maxConcurrent }),
      admit: async (run, step) => {
        const workspace = await ctx.workspace.resolve({ root: run.owner.workspaceRoot });
        if (workspace.root !== run.owner.workspaceRoot) throw new Error("Workflow workspace identity changed");
        const subject = { agentId: run.owner.parentAgentId, sessionId: run.owner.parentSessionId, runId: run.owner.parentRunId, userTurnId: run.id, stepId: step.task.id };
        const host = await ctx.permissions.resolve({ workspace, subject, agent: ctx.agents.permissions, registeredTools: run.availableTools });
        const hostScope = host.delegation ?? { availableTools: host.availableTools, allowedCapabilities: host.ceiling.allowedCapabilities };
        if ((host.profile !== run.permissionProfile && host.profile !== "full-access" && run.permissionProfile !== "read-only") ||
            run.availableTools.some(name => !hostScope.availableTools.includes(name)) || run.allowedCapabilities.some(kind => !hostScope.allowedCapabilities.includes(kind))) throw new Error("Current Host ceiling no longer admits this Workflow");
        const permissions = await ctx.permissions.resolve({ workspace,
          subject,
          agent: { profile: run.permissionProfile, availableTools: run.availableTools, allowedCapabilities: run.allowedCapabilities }, registeredTools: run.availableTools });
        const scope = permissions.delegation ?? { availableTools: permissions.availableTools, allowedCapabilities: permissions.ceiling.allowedCapabilities };
        if (run.availableTools.some(name => !scope.availableTools.includes(name))) throw new Error("Workflow authority narrowed; re-plan before dispatch");
        if (run.allowedCapabilities.some(kind => !scope.allowedCapabilities.includes(kind))) throw new Error("Workflow capability ceiling narrowed; reconcile before dispatch");
      },
    });
    const children = this.children;
    let closing: Promise<void> | undefined;
    // Seal child dispatch synchronously and drain every admitted request before
    // Cordis may activate a successor against the same durable state.
    const close = () => closing ??= children.close();
    ctx.effect(() => close, "workflow.schedulers.close");
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: async signal => {
        const snapshot = await this.children.lifecycleSnapshot(signal);
        const busy = snapshot.activeRequests > 0 || snapshot.pendingTicks > 0 || snapshot.waitingParents > 0 ||
          snapshot.unsettledRuns > 0 || snapshot.activeAttempts > 0;
        return { disposition: snapshot.closed || closing ? "blocked" : busy ? "drain" : "direct", code: snapshot.closed || closing ? "workflow_closing"
          : busy ? "workflow_unsettled_work" : "workflow_idle",
        counts: { active_requests: snapshot.activeRequests, pending_ticks: snapshot.pendingTicks, waiting_parents: snapshot.waitingParents,
          unsettled_runs: snapshot.unsettledRuns, active_attempts: snapshot.activeAttempts } };
      },
      prepare: change => {
        const resumeChildren = children.suspendAdmission();
        return {
          drained: children.drain(),
          deactivate: change.kind === "replace" ? async () => {} : close,
          release: () => { if (!closing) resumeChildren(); },
        };
      },
    });
  }
  async [Service.init]() {
    await this.children.reconcile();
    const resumeChildren = this.children.suspendAdmission();
    const start = () => { resumeChildren(); this.children.start(); };
    const reload = this.ctx.root.get("codeReload");
    if (reload) reload.startWhenReady(this.ctx, start);
    else start();
  }
}
