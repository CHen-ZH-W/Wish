export interface UserTerminalShellChoice {
  readonly path: string;
  readonly name: string;
}

export interface UserTerminalView {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly active: boolean;
  /** This PTY runs with the Wish Host process user's operating-system authority. */
  readonly authority: "host-user";
  /** Interactive Shell executable selected from the Host environment. */
  readonly shell: string;
  readonly columns: number;
  readonly rows: number;
  readonly exitCode?: number;
}

/** Ordered frames for one detachable browser attachment. */
export type UserTerminalFrame =
  | { readonly type: "snapshot"; readonly sequence: number; readonly screen: string; readonly terminal: UserTerminalView; readonly writable: boolean }
  | { readonly type: "output"; readonly sequence: number; readonly data: string }
  | { readonly type: "state"; readonly terminal: UserTerminalView; readonly writable: boolean };

export interface CreateUserTerminalRequest {
  readonly ownerSessionId: string;
  readonly workspaceRoot: string;
  readonly label?: string;
  readonly shellPath?: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly signal?: AbortSignal;
}

export interface UserTerminalPort {
  listShells(signal?: AbortSignal): Promise<readonly UserTerminalShellChoice[]>;
  list(ownerSessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<readonly UserTerminalView[]>;
  create(request: CreateUserTerminalRequest): Promise<UserTerminalView>;
  follow(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, signal: AbortSignal): AsyncIterable<UserTerminalFrame>;
  write(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, text: string, signal?: AbortSignal): Promise<void>;
  resize(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, columns: number, rows: number, signal?: AbortSignal): Promise<void>;
  close(ownerSessionId: string, workspaceRoot: string, terminalId: string, signal?: AbortSignal): Promise<void>;
}
