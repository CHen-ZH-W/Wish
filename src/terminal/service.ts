import { Service, type Context } from "@deepseek-ai/cordis";
import type { CreateUserTerminalRequest, UserTerminalFrame, UserTerminalPort, UserTerminalView } from "./types.js";
import type { UserTerminalShellChoice } from "./types.js";

export abstract class UserTerminalService extends Service implements UserTerminalPort {
  constructor(ctx: Context) { super(ctx, "userTerminal"); }
  abstract listShells(signal?: AbortSignal): Promise<readonly UserTerminalShellChoice[]>;
  abstract list(ownerSessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<readonly UserTerminalView[]>;
  abstract create(request: CreateUserTerminalRequest): Promise<UserTerminalView>;
  abstract follow(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, signal: AbortSignal): AsyncIterable<UserTerminalFrame>;
  abstract write(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, text: string, signal?: AbortSignal): Promise<void>;
  abstract resize(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, columns: number, rows: number, signal?: AbortSignal): Promise<void>;
  abstract close(ownerSessionId: string, workspaceRoot: string, terminalId: string, signal?: AbortSignal): Promise<void>;
}

declare module "@deepseek-ai/cordis" { interface Context { userTerminal: UserTerminalService; } }
export default UserTerminalService;
