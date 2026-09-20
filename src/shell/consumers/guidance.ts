import type { Context } from "@deepseek-ai/cordis";

/** Cross-call Bash guidance; command arguments and permissions stay in its schema. */
export const BashToolGuidance = {
  name: "bash-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    ctx.systemPrompt.register({
      id: "shell.bash",
      order: 200,
      requiredTools: ["bash"],
      content: [
        "Use bash for operations that genuinely require shell execution.",
        "Bash runs synchronously; do not detach unmanaged background processes.",
        "Declare the least permissions required by the whole command, and investigate nonzero exits, timeouts, or aborted execution before continuing.",
      ].join("\n"),
    });
  },
};

export default BashToolGuidance;
