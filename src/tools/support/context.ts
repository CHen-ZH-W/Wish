/** Execution context shared by the basic Tools for one Runtime Step. */
export interface BasicToolContext {
  readonly cwd: string;
  readonly modelSupportsImages?: boolean;
}
