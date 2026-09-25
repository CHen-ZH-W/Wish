import { registerManagedSessionFeature } from "../../apps/session-feature-owner.js";
import type { Context } from "@deepseek-ai/cordis";
export default { name: "tasks-session-feature", inject: ["application", "tasks", "plan"], apply(ctx: Context) {
  registerManagedSessionFeature(ctx, "tasks", {
    async inspect(sessionId) {
      const plan = await ctx.plan.get({ sessionId });
      const artifact = plan?.document?.artifacts?.find(ref => ref.kind === "tasks" && ref.id === sessionId);
      const graph = await ctx.tasks.get(sessionId, artifact?.version);
      if (!graph) return undefined;
      if (artifact && artifact.digest !== graph.digest) throw new Error("Plan task artifact mismatch");
      return { key: "tasks", title: `任务图 v${graph.version} · ${graph.state}`, titleEn: `Task graph v${graph.version} · ${graph.state}`, text: JSON.stringify(graph, null, 2), token: {}, actions: [] };
    },
    async act() { throw new Error("Task state is runtime-owned; revise task definitions in Plan mode"); },
  }, { codeReload: true });
} };
