import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { subagentRecordOutput } from "../../subagents/consumers/model-tools/tools.js";
import type {} from "../../subagents/consumers/model-tools/dispatch.js";

/** Optional dispatch strategy. It never owns or duplicates the Subagent model Tools. */
export default { name: "workflow-subagent-tools", inject: ["subagentToolDispatch", "subagents", "workflowScheduler"], apply(ctx: Context) {
  let active = ctx.root.get("codeReload") === undefined;
  let unregister = () => {};
  const work = new PluginWorkOwner(ctx, { code: "workflow_subagent_dispatch", codeReload: true,
    beforeDrain: () => { active = false; }, close: () => unregister() });
  unregister = ctx.subagentToolDispatch.register({
    id: "workflow",
    active: () => active,
    dispatch: (request, context, grant) => work.run(async () => {
      const profile = request.permissionProfile ?? context.permissions.profile;
      if (profile !== context.permissions.profile && profile !== "read-only") throw new Error("Child permission profile cannot exceed its parent");
      const scope = context.permissions.delegation ?? { availableTools: context.permissions.availableTools, allowedCapabilities: context.permissions.ceiling.allowedCapabilities };
      const availableTools = request.availableTools ?? scope.availableTools;
      if (availableTools.some(name => !scope.availableTools.includes(name))) throw new Error("Child tools cannot exceed the Host delegation ceiling");
      const run = await ctx.workflowScheduler.children.submit({
        key: `child/${request.parentSessionId}/${request.parentRunId}/${grant.subject.id}`, kind: "subagent", owner: {
          parentAgentId: request.parentAgentId, parentSessionId: request.parentSessionId, parentRunId: request.parentRunId, workspaceRoot: request.workspaceRoot,
        }, tasks: [{ id: "child", title: request.task, dependencies: [], execution: { role: request.role ?? "worker", readOnly: profile === "read-only", timeoutMs: 30 * 60_000 } }],
        permissionProfile: profile, availableTools,
        allowedCapabilities: scope.allowedCapabilities,
        ...(request.model ? { model: request.model } : {}), ...(request.modelsConfiguration ? { modelsConfiguration: request.modelsConfiguration } : {}),
      });
      const childId = run.steps[0]?.attempts.at(-1)?.childId;
      if (context.runContinuation) ctx.workflowScheduler.children.watch(run.id, context.runContinuation, request.signal, request.parentRunId);
      if (!childId) return { content: [{ type: "text" as const, text: `Workflow ${run.id} ${run.status}: ${run.failureDigest ?? "queued within host concurrency limits; inspect with workflow_read, do not submit a duplicate"}` }] };
      const record = await ctx.subagents.inspect({ ...request, id: childId });
      if (!record) throw new Error(`Workflow ${run.id} child unavailable`);
      return subagentRecordOutput("Started", record);
    }),
  });
  const reload = ctx.root.get("codeReload");
  if (reload) reload.startWhenReady(ctx, () => { active = true; });
} };
