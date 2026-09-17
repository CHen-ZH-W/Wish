/** Stable caller-selected identity of one transparent tmux workload. */
export type TmuxSessionId = string;

/** Exact executable launched in the first pane of a tmux session. */
export interface TmuxCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Complete environment additions fixed for this workload. */
  readonly environment?: Readonly<Record<string, string>>;
}

/** Metadata kept in tmux user options so live work remains discoverable. */
export interface TmuxSessionMetadata {
  readonly workspaceRoot: string;
  readonly label?: string;
}

export interface StartTmuxSessionRequest {
  readonly sessionId: TmuxSessionId;
  readonly windowName: string;
  readonly command: TmuxCommand;
  readonly metadata: TmuxSessionMetadata;
  readonly columns?: number;
  readonly rows?: number;
  readonly signal?: AbortSignal;
}

/** Public tmux address returned to models, applications, and operators. */
export interface TmuxTarget {
  readonly sessionId: TmuxSessionId;
  readonly session: string;
  readonly window: string;
  readonly pane: string;
  readonly target: string;
  readonly socketPath?: string;
  readonly attachCommand: string;
  readonly captureCommand: string;
}

export interface TmuxSessionSnapshot {
  readonly target: TmuxTarget;
  readonly metadata: TmuxSessionMetadata;
  readonly createdAt: string;
  readonly active: boolean;
  readonly exitCode?: number;
  readonly currentCommand?: string;
  readonly panePid?: number;
}

export interface ListTmuxSessionsRequest {
  readonly workspaceRoot?: string;
  readonly signal?: AbortSignal;
}

export interface CaptureTmuxPaneRequest {
  readonly target: TmuxTarget;
  readonly lines?: number;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

export interface SendTmuxKeysRequest {
  readonly target: TmuxTarget;
  readonly text: string;
  readonly enter?: boolean;
  readonly signal?: AbortSignal;
}

export interface StopTmuxSessionRequest {
  readonly target: TmuxTarget;
  readonly signal?: AbortSignal;
}

/** Provider-neutral transparent terminal-session capability. */
export interface Tmux {
  start(request: StartTmuxSessionRequest): Promise<TmuxSessionSnapshot>;
  list(request?: ListTmuxSessionsRequest): Promise<readonly TmuxSessionSnapshot[]>;
  inspect(target: TmuxTarget, signal?: AbortSignal): Promise<TmuxSessionSnapshot | undefined>;
  capture(request: CaptureTmuxPaneRequest): Promise<string>;
  send(request: SendTmuxKeysRequest): Promise<void>;
  stop(request: StopTmuxSessionRequest): Promise<void>;
}
