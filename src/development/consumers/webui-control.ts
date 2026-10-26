import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl, WebUiControlError, type WebUiControl } from "../../apps/webui/controls.js";
import type { WishApplication } from "../../apps/types.js";
import type { DevelopmentProject } from "../types.js";

export const DEVELOPMENT_WEBUI_CONTROL = "wish-development";
export interface DevelopmentControlPort {
  list(): Promise<readonly DevelopmentProject[]>;
  inspect(sessionId: string): Promise<{ readonly project: DevelopmentProject | null }>;
  control(application: WishApplication, sessionId: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ readonly project: DevelopmentProject | null; readonly runId?: string }>;
}

/** The product owner interprets actions; the HTTP adapter only carries a bounded envelope. */
export function createDevelopmentWebUiControl(development: DevelopmentControlPort): WebUiControl {
  return {
    async inspectDefault() { return translate(async () => ({ projects: await development.list() })); },
    async inspectSession(application, sessionId, signal) {
      return translate(async () => { await application.getSession({ sessionId, signal }); return development.inspect(sessionId); });
    },
    async updateSession(application, sessionId, body, signal) {
      return translate(async () => {
        if (Object.keys(body).some(key => !["action", "requestId", "projectId", "expectedRevision", "data"].includes(key))
          || typeof body.action !== "string" || !body.action || typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 256
          || (body.projectId !== undefined && (typeof body.projectId !== "string" || !body.projectId))
          || (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0))
          || (body.data !== undefined && (!body.data || typeof body.data !== "object" || Array.isArray(body.data)))) {
          throw new WebUiControlError(400, "development_invalid_request", "A development action and request identity are required");
        }
        const session = await application.getSession({ sessionId, signal });
        if (session.status !== "active") throw new WebUiControlError(409, "session_archived", "Archived Session is read-only");
        return development.control(application, sessionId, body, signal);
      });
    },
  };
}

async function translate<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof WebUiControlError) throw error;
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && (error.code.startsWith("development_") || error.code === "storage_conflict")) {
      const code = error.code === "storage_conflict" ? "development_revision_conflict" : error.code;
      throw new WebUiControlError(code.includes("invalid") ? 400 : 409, code, error instanceof Error ? error.message : code);
    }
    throw error;
  }
}

export default {
  name: "development-webui-control", inject: ["wishDevelopment", "webUiControls"],
  apply(ctx: Context): void { registerManagedWebUiControl(ctx, DEVELOPMENT_WEBUI_CONTROL, createDevelopmentWebUiControl(ctx.wishDevelopment)); },
};
