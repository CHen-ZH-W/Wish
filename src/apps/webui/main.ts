#!/usr/bin/env node

import { createWishHostApplication } from "../config.js";
import {
  loadWishWebUiConfiguration,
  startWishWebUiServer,
  WebToolApprovalBroker,
} from "./index.js";

try {
  const configuration = await loadWishWebUiConfiguration();
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
  process.stderr.write(`Wish WebUI API listening at ${started.url}\n`);

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`Wish WebUI API stopping after ${signal}\n`);
    void started.close().then(
      () => {
        process.exitCode = signal === "SIGINT" ? 130 : 143;
      },
      (error: unknown) => {
        process.stderr.write(
          `wish-webui: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error: unknown) {
  process.stderr.write(
    `wish-webui: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
