import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { Context } from "@deepseek-ai/cordis";

/** Cross-call Bash guidance; command arguments and permissions stay in its schema. */
export const BashToolGuidance = {
  name: "bash-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "shell_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "shell.bash",
      order: 200,
      requiredTools: ["bash"],
      content: [
        "Use bash for operations that genuinely require shell execution.",
        "Bash runs synchronously; do not detach unmanaged background processes.",
        "Declare the least permissions required by the whole command, and investigate nonzero exits, timeouts, or aborted execution before continuing.",
        "When a check's failure matters, do not let a later command or pipeline hide its exit status; check the relevant status explicitly.",
      ].join("\n"),
    });
  },
};

export default BashToolGuidance;
