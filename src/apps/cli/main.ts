#!/usr/bin/env node

import {
  createWishCli,
  NodeWishCliTerminal,
  WishCliUsageError,
  type WishCliInterruptSignal,
} from "./index.js";

const terminal = new NodeWishCliTerminal();
const cli = createWishCli({ terminal });
const handlers = new Map<WishCliInterruptSignal, () => void>();
const signals: WishCliInterruptSignal[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"];

for (const signal of signals) {
  const handler = () => cli.interrupt(signal);
  handlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  process.exitCode = await cli.run(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await terminal.writeError(`wish: ${message}\n`);
  if (error instanceof WishCliUsageError) {
    await terminal.writeError("Run \"wish --help\" for usage.\n");
  }
  process.exitCode = 1;
} finally {
  for (const [signal, handler] of handlers) process.off(signal, handler);
  terminal.close();
}
