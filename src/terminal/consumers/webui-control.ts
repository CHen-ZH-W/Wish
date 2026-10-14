import type { Context } from "@deepseek-ai/cordis";
import { registerManagedWebUiControl, WebUiControlError } from "../../apps/webui/controls.js";
import { UserTerminalError } from "../errors.js";

export const USER_TERMINAL_WEBUI_CONTROL = "user-terminal";

export default {
  name: "user-terminal-webui-control",
  inject: ["userTerminal", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, USER_TERMINAL_WEBUI_CONTROL, {
      async inspectSession(application, sessionId, signal) {
        const session = await application.getSession({ sessionId, signal });
        return Object.freeze({ schemaVersion: 2 as const, sessionId, authority: "host-user" as const, terminals: await ctx.userTerminal.list(sessionId, session.scope, signal) });
      },
      async *streamSession(application, sessionId, query, signal) {
        const session = await application.getSession({ sessionId, signal });
        const terminalId = queryField(query, "terminalId");
        const attachmentId = queryField(query, "attachmentId");
        try {
          for await (const frame of ctx.userTerminal.follow(sessionId, session.scope, terminalId, attachmentId, signal)) {
            yield Object.freeze({ event: `terminal.${frame.type}`, data: frame, ...(frame.type === "output" ? { id: String(frame.sequence) } : {}) });
          }
        } catch (error) { throw terminalControlError(error); }
      },
      async updateSession(application, sessionId, body, signal) {
        const session = await application.getSession({ sessionId, signal });
        try {
          const action = stringField(body, "action");
          if (action === "shells") {
            return Object.freeze({ shells: await ctx.userTerminal.listShells(signal) });
          }
          if (action === "create") {
            const label = optionalString(body, "label"), shellPath = optionalString(body, "shellPath"), columns = optionalInteger(body, "columns"), rows = optionalInteger(body, "rows");
            return ctx.userTerminal.create({ ownerSessionId: sessionId, workspaceRoot: session.scope, ...(label === undefined ? {} : { label }), ...(shellPath === undefined ? {} : { shellPath }), ...(columns === undefined ? {} : { columns }), ...(rows === undefined ? {} : { rows }), signal });
          }
          const terminalId = stringField(body, "terminalId");
          if (action === "write") {
            await ctx.userTerminal.write(sessionId, session.scope, terminalId, stringField(body, "attachmentId"), stringField(body, "text", true), signal);
            return Object.freeze({ accepted: true });
          }
          if (action === "resize") {
            await ctx.userTerminal.resize(sessionId, session.scope, terminalId, stringField(body, "attachmentId"), integerField(body, "columns"), integerField(body, "rows"), signal);
            return Object.freeze({ accepted: true });
          }
          if (action === "close") {
            await ctx.userTerminal.close(sessionId, session.scope, terminalId, signal);
            return Object.freeze({ closed: true });
          }
          throw new WebUiControlError(400, "invalid_request", "Unknown User Terminal action");
        } catch (error) {
          if (error instanceof WebUiControlError) throw error;
          if (error instanceof UserTerminalError) throw terminalControlError(error);
          throw error;
        }
      },
    });
  },
};

function stringField(body: Readonly<Record<string, unknown>>, key: string, allowEmpty = false): string { const value = body[key]; if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new WebUiControlError(400, "invalid_request", `${key} must be a string`); return value; }
function optionalString(body: Readonly<Record<string, unknown>>, key: string): string | undefined { const value = body[key]; return value === undefined ? undefined : stringField(body, key); }
function integerField(body: Readonly<Record<string, unknown>>, key: string): number { const value = body[key]; if (!Number.isSafeInteger(value)) throw new WebUiControlError(400, "invalid_request", `${key} must be an integer`); return value as number; }
function optionalInteger(body: Readonly<Record<string, unknown>>, key: string): number | undefined { return body[key] === undefined ? undefined : integerField(body, key); }
function queryField(query: Readonly<Record<string, string>>, key: string): string { const value = query[key]; if (typeof value !== "string" || !value.trim()) throw new WebUiControlError(400, "invalid_request", `${key} is required`); return value; }
function terminalControlError(error: unknown): WebUiControlError {
  if (error instanceof WebUiControlError) return error;
  if (error instanceof UserTerminalError) return new WebUiControlError(error.code === "not_found" ? 404 : error.code === "unavailable" ? 503 : error.code === "not_active" || error.code === "limit_reached" || error.code === "control_unavailable" ? 409 : 400, `terminal_${error.code}`, error.message);
  return new WebUiControlError(503, "terminal_unavailable", error instanceof Error ? error.message : String(error));
}
