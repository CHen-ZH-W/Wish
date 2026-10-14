import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";

/** Cross-call guidance for explicit, recoverable long-running terminals. */
export const TmuxToolGuidance = {
  name: "tmux-tool-guidance",
  inject: ["systemPrompt"],
  apply(ctx: Context): void {
    new PluginWorkOwner(ctx, { code: "tmux_guidance", codeReload: true });
    ctx.systemPrompt.register({
      id: "tmux.lifecycle",
      order: 210,
      requiredTools: ["bash", "tmux_start", "tmux_list"],
      content: [
        "Use synchronous bash for bounded commands that finish during the current Tool call.",
        "Use tmux_start for long-running servers, watchers, debuggers, or interactive programs; do not use shell &, nohup, or an unmanaged raw tmux server.",
        "Use tmux_list after context compaction, tmux_capture for bounded output, tmux_send for input, and tmux_stop only when the terminal should be removed.",
        "A completed terminal keeps its final screen until tmux_stop or explicit deletion in the session sidebar.",
      ].join("\n"),
    });
  },
};

export default TmuxToolGuidance;
