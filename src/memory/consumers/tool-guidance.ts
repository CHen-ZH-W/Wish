import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

export default {
  name: "memory-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "memory_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "memory.retrieval",
      order: 600,
      requiredTools: ["memory_search", "memory_read"],
      content: "When prior decisions or reusable workspace facts could help, use memory_search and read relevant versioned entries. Treat memory as historical evidence; verify facts against the current workspace before relying on them.",
    });
    ctx.systemPrompt.register({
      id: "memory.proposal",
      order: 610,
      requiredTools: ["memory_write"],
      content: "When the user requests durable retention or a verified reusable lesson merits review, use memory_write to propose it with source, applicability and reason. It awaits human review; do not claim acceptance or store secrets or raw transcripts.",
    });
  },
};
