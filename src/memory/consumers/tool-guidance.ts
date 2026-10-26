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
      content: "When prior decisions or reusable workspace facts could help, read the memory summary, then use memory_search, memory_list and memory_read to inspect relevant handbook entries, rollout summaries and memory Skills. Treat memory as historical evidence; verify facts against the current workspace before relying on them. When using memory, include a <wish-memory-citation> block containing the exact rollout_summaries paths that supported your answer, so source usage can be recorded.",
    });
    ctx.systemPrompt.register({
      id: "memory.note",
      order: 610,
      requiredTools: ["memory_write"],
      content: "When the user explicitly asks to remember, update or forget something, use memory_write to record a note with the requested change and scope. Background consolidation applies it automatically without human acceptance. Report that the note was recorded, and only claim consolidation after observing the resulting memory. Do not store secrets or raw transcripts. Routine experience extraction is automatic; it does not require memory_write.",
    });
  },
};
