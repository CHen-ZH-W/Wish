import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { loadWishHostConfiguration } from "../config.js";
import {
  createWishCli,
  NodeWishCliTerminal,
  WishCliUsageError,
} from "./index.js";

export const name = "cli-surface";
export const inject = ["launch"];

/** CLI-owned configuration supplied by its Loader row. */
export interface Config {
  readonly dataDirectory?: string;
  readonly modelsConfigurationPath?: string;
}

export const Config: s<Config> = s.object({
  dataDirectory: s.string(),
  modelsConfigurationPath: s.string(),
});

/** Run the legacy CLI behind a Loader-owned lifecycle during the G1 transition. */
export function apply(ctx: Context, config: Config): void {
  if (ctx.launch.surface !== "cli") {
    throw new Error("CLI surface was mounted for a non-CLI process");
  }

  const defaults = Object.freeze({
    ...(config.dataDirectory === undefined
      ? {}
      : { dataDirectory: resolve(ctx.launch.cwd, config.dataDirectory) }),
    ...(config.modelsConfigurationPath === undefined
      ? {}
      : {
          modelsConfigurationPath: resolve(
            ctx.launch.cwd,
            config.modelsConfigurationPath,
          ),
        }),
  });
  const terminal = new NodeWishCliTerminal();
  const cli = createWishCli({
    terminal,
    cwd: () => ctx.launch.cwd,
    homeDirectory: () => ctx.launch.homeDirectory,
    environment: ctx.launch.environment,
    loadHostConfiguration: (input) => loadWishHostConfiguration({
      ...defaults,
      ...input,
    }),
    forceExit: (code) => ctx.launch.complete(code),
  });
  let finished = false;

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

  ctx.effect(() => {
    const stopSignals = ctx.launch.onSignal((signal) => cli.interrupt(signal));
    return async () => {
      stopSignals();
      if (!finished) cli.interrupt("SIGTERM");
      terminal.close();
      await running;
    };
  }, "CLI process surface");
}
