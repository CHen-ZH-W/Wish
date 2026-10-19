import type { WishCliTerminal } from "./terminal.js";

declare module "@deepseek-ai/cordis" {
  interface Events {
    /** Optional CLI consumers claim their prefix synchronously and own the returned operation. */
    "cli/command"(argv: readonly string[], terminal: WishCliTerminal, signal: AbortSignal): Promise<number> | undefined;
  }
}
export {};
