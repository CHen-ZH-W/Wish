import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl, WebUiControlError } from "../../apps/webui/controls.js";
import { WorkspaceFilesError } from "../providers/local.js";

export const WORKSPACE_FILES_WEBUI_CONTROL = "workspace-files";

export default {
  name: "workspace-files-webui-control",
  inject: ["workspaceFiles", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, WORKSPACE_FILES_WEBUI_CONTROL, {
      async querySession(application, sessionId, body, signal) {
        const session = await application.getSession({ sessionId, signal });
        try {
          const operation = field(body, "operation");
          const path = optionalField(body, "path") ?? ".";
          if (operation === "list") return ctx.workspaceFiles.list(session.scope, path, signal);
          if (operation === "read") return ctx.workspaceFiles.read(session.scope, path, signal);
          if (operation === "read-bytes") return ctx.workspaceFiles.readBytes(session.scope, path, signal);
          throw new WebUiControlError(400, "invalid_request", "Unknown Workspace Files operation");
        } catch (error) {
          if (error instanceof WebUiControlError) throw error;
          if (error instanceof WorkspaceFilesError) throw new WebUiControlError(400, `workspace_files_${error.code}`, error.message);
          throw error;
        }
      },
    });
  },
};

function field(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key]; if (typeof value !== "string" || !value.trim()) throw new WebUiControlError(400, "invalid_request", `${key} is required`); return value;
}
function optionalField(body: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = body[key]; if (value === undefined) return undefined; if (typeof value !== "string") throw new WebUiControlError(400, "invalid_request", `${key} must be a string`); return value;
}
