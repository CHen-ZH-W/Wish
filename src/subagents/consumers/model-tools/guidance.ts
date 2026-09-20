import type { Context } from "@deepseek-ai/cordis";

/** Cross-call guidance for Wish-owned child Agent lifecycle Tools. */
export const SubagentToolGuidance = {
  name: "subagent-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    ctx.systemPrompt.register({
      id: "subagents.delegation",
      order: 400,
      requiredTools: ["spawn_agent"],
      content: [
        "Use child Agents for bounded work that materially benefits from independent context or parallel execution.",
        "Give each child a concrete task, avoid duplicating its work, and do not run concurrent write-capable children against overlapping files in the shared workspace.",
      ].join("\n"),
    });
    ctx.systemPrompt.register({
      id: "subagents.lifecycle",
      order: 410,
      requiredTools: ["spawn_agent", "list_agents", "collect_agent"],
      content:
        "Continue useful independent work while children run. Do not busy-poll; use list_agents or collect_agent when status or recovered output is actually needed.",
    });
  },
};

export default SubagentToolGuidance;
