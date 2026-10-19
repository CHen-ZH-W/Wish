import { PluginWorkOwner } from "../../../boot/plugin-control/work-owner.js";
import type { Context } from "@deepseek-ai/cordis";

/** Cross-call guidance for Wish-owned child Agent lifecycle Tools. */
export const SubagentToolGuidance = {
  name: "subagent-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "subagent_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "subagents.delegation",
      order: 400,
      requiredTools: ["spawn_agent"],
      content: [
        "Use child Agents for bounded work that materially benefits from independent context or parallel execution.",
        "Give each child a concrete task, avoid duplicating its work, and do not run concurrent write-capable children against overlapping files in the shared workspace.",
        "For a read-only child, select read/grep or omit availableTools so the Host assembles usable Tools. Do not request bash with permissionProfile read-only: this child has no human review surface for process.exec. If shell execution is necessary, choose a parent-permitted execution profile deliberately.",
      ].join("\n"),
    });
    ctx.systemPrompt.register({
      id: "subagents.lifecycle",
      order: 410,
      requiredTools: ["spawn_agent", "list_agents", "collect_agent"],
      content:
        "Start independent child tasks together when possible. The Host waits for their results before your next model step, so synthesize the results before giving a final answer. Do not busy-poll; use list_agents or collect_agent only when recovered output is needed.",
    });
  },
};

export default SubagentToolGuidance;
