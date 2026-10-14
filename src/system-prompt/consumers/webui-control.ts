import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl } from "../../apps/webui/controls.js";
import type { SessionSystemPromptHistoryView } from "./webui-types.js";

export const SYSTEM_PROMPT_HISTORY_WEBUI_CONTROL = "system-prompt-history";

/** Read-only adapter; System Prompt history does not belong to WebUI Core. */
export default {
  name: "system-prompt-history-webui-control",
  inject: ["systemPromptHistory", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, SYSTEM_PROMPT_HISTORY_WEBUI_CONTROL, {
      async inspectSession(_application, sessionId, signal): Promise<SessionSystemPromptHistoryView> {
        return Object.freeze({
          schemaVersion: 1,
          sessionId,
          snapshots: await ctx.systemPromptHistory.list(sessionId, signal),
        });
      },
    });
  },
};
