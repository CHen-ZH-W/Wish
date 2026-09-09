import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { createWishHostApplication } from "../config.js";
import {
  loadWishWebUiConfiguration,
  startWishWebUiServer,
  WebToolApprovalBroker,
} from "./index.js";

export const name = "webui-surface";
export const inject = ["launch"];

/** WebUI-owned configuration supplied by its Loader row. */
export interface Config {
  readonly host?: string;
  readonly port?: number;
  readonly workspaceRoot?: string;
  readonly dataDirectory?: string;
  readonly modelsConfigurationPath?: string;
}

export const Config: s<Config> = s.object({
  host: s.string(),
  port: s.number().step(1).min(1).max(65_535),
  workspaceRoot: s.string(),
  dataDirectory: s.string(),
  modelsConfigurationPath: s.string(),
});

/** Run the legacy WebUI behind a Loader-owned lifecycle during the G1 transition. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.launch.surface !== "webui") {
    throw new Error("WebUI surface was mounted for a non-WebUI process");
  }

  const configuration = await loadWishWebUiConfiguration({
    cwd: ctx.launch.cwd,
    homeDirectory: ctx.launch.homeDirectory,
    environment: ctx.launch.environment,
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: resolve(ctx.launch.cwd, config.workspaceRoot) }),
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
  const approvals = new WebToolApprovalBroker();
  const application = createWishHostApplication(configuration.application, {
    approval: approvals,
  });
  const started = await startWishWebUiServer({
    application,
    approvals,
    workspaceRoot: configuration.workspaceRoot,
    host: configuration.host,
    port: configuration.port,
  });
  let stopping = false;

  ctx.effect(() => {
    const stopSignals = ctx.launch.onSignal((signal) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`Wish WebUI API stopping after ${signal}\n`);
      const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
      ctx.launch.complete(exitCode);
    });
    return async () => {
      stopSignals();
      await started.close();
    };
  }, "WebUI process surface");

  process.stderr.write(`Wish WebUI API listening at ${started.url}\n`);
}
