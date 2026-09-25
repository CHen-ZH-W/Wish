import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
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
  let running: Promise<void> = Promise.resolve();
  let closeSurface: () => Promise<void> = async () => {};
  const work = new PluginWorkOwner(ctx, {
    code: "cli_surface",
    codeReload: true,
    replacement: "generation",
    beforeDrain: () => { if (!finished) cli.interrupt("SIGTERM"); },
    close: () => closeSurface(),
  });

  ctx.effect(() => {
    const stopSignals = ctx.launch.onSignal((signal) => cli.interrupt(signal));
    const start = () => {
      running = work.run(async () => {
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
      }).catch((error: unknown) => ctx.launch.fail(error));
    };
    const reload = ctx.root.get("codeReload");
    if (reload) reload.startWhenReady(ctx, start);
    else start();

    let closing: Promise<void> | undefined;
    closeSurface = () => closing ??= (async () => {
      stopSignals();
      if (!finished) cli.interrupt("SIGTERM");
      const retirement = cli.retire({
        reason: "Cordis released the CLI Run generation",
        onDrainTimeout: (error) => ctx.launch.fail(error),
      });
      terminal.close();
      await Promise.all([running, retirement]);
    })();
    return () => closeSurface();
  }, "CLI process surface");
}
