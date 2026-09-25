import { PluginWorkOwner } from "../../../boot/plugin-control/work-owner.js";
import type { Context } from "@deepseek-ai/cordis";

/** Cross-call filesystem guidance; parameter semantics remain in Tool schemas. */
export const FilesystemToolGuidance = {
  name: "filesystem-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "filesystem_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "filesystem.inspect",
      order: 100,
      requiredTools: ["grep", "read"],
      content:
        "Use grep to locate relevant text and read to inspect the surrounding file content before drawing conclusions.",
    });
    ctx.systemPrompt.register({
      id: "filesystem.edit",
      order: 110,
      requiredTools: ["read", "edit"],
      content:
        "Inspect the relevant file before changing it. Use edit for focused changes that preserve unrelated content.",
    });
    ctx.systemPrompt.register({
      id: "filesystem.write",
      order: 120,
      requiredTools: ["read", "write"],
      content:
        "Use write for new files or deliberate complete replacements. Inspect an existing file before replacing it.",
    });
    ctx.systemPrompt.register({
      id: "filesystem.prefer-edit",
      order: 130,
      requiredTools: ["edit", "write"],
      content:
        "Prefer edit when only part of an existing file needs to change; use write when replacing the complete file is intentional.",
    });
  },
};

export default FilesystemToolGuidance;
