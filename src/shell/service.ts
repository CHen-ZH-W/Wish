import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ResolveShellCommandRequest,
  RunShellCommandRequest,
  Shell,
  ShellCommandPreflight,
  ShellCommandSpec,
  ShellExecutionResult,
  ShellPolicy,
  PreflightShellCommandRequest,
} from "./types.js";

/** Service Definition implemented by replaceable process-enforcement providers. */
export abstract class ShellService extends Service implements Shell {
  abstract readonly policy: ShellPolicy;

  constructor(ctx: Context) {
    super(ctx, "shell");
  }

  abstract preflight(
    request: PreflightShellCommandRequest,
  ): Promise<ShellCommandPreflight>;

  abstract resolve(
    request: ResolveShellCommandRequest,
  ): Promise<ShellCommandSpec>;

  abstract run(request: RunShellCommandRequest): Promise<ShellExecutionResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    shell: ShellService;
  }
}

export default ShellService;
