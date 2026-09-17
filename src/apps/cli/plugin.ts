import type { Context } from "@deepseek-ai/cordis";

import {
  createWishCli,
  NodeWishCliTerminal,
  WishCliUsageError,
} from "./index.js";

export const name = "cli-surface";
export const inject = ["launch", "approval", "application"];

/** Run the CLI through the injected Application service. */
export function apply(ctx: Context): void {
  if (ctx.launch.surface !== "cli") {
    throw new Error("CLI surface was mounted for a non-CLI process");
  }

  const terminal = new NodeWishCliTerminal();
  const cli = createWishCli({
    terminal,
    cwd: () => ctx.launch.cwd,
    openApplication: (input) => ctx.application.open(input),
    registerApproval: (approval) => {
      ctx.approval.register(approval, {
        id: "cli-surface",
        replace: true,
      });
    },
    forceExit: (code) => ctx.launch.complete(code),
  });
  let finished = false;

  ctx.effect(() => {
    const stopSignals = ctx.launch.onSignal((signal) => cli.interrupt(signal));
    const running = (async () => {
      try {
        ctx.launch.complete(await cli.run(ctx.launch.argv));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await terminal.writeError(`wish: ${message}\n`);
        if (error instanceof WishCliUsageError) {
          await terminal.writeError("Run \"wish --help\" for usage.\n");
        }
        ctx.launch.complete(1);
      } finally {
        finished = true;
      }
    })().catch((error: unknown) => ctx.launch.fail(error));

    return async () => {
      stopSignals();
      if (!finished) cli.interrupt("SIGTERM");
      const retirement = cli.retire({
        reason: "Cordis released the CLI Run generation",
        onDrainTimeout: (error) => ctx.launch.fail(error),
      });
      terminal.close();
      await Promise.all([running, retirement]);
    };
  }, "CLI process surface");
}
