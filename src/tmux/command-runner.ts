/** Exact tmux CLI invocation; executable and argv are never a shell string. */
export interface RunTmuxCommandRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface TmuxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Private injectable Port for bounded, synchronous tmux CLI calls. */
export interface TmuxCommandRunner {
  run(request: RunTmuxCommandRequest): Promise<TmuxCommandResult>;
}
