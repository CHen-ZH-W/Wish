#!/usr/bin/env node

import { bootstrap } from "../../boot/bootstrap.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { managedWebUi } from "./host/composition.js";

let booted: Awaited<ReturnType<typeof bootstrap>> | undefined;

try {
  if (process.env.WISH_WEBUI_HOST && process.env.WISH_WEBUI_HOST !== "127.0.0.1") {
    throw new Error("WebUI currently requires WISH_WEBUI_HOST=127.0.0.1");
  }
  booted = await bootstrap({
    surface: "webui",
    argv: process.argv.slice(2),
    management: managedWebUi({
      directory: resolve(process.env.WISH_MANAGEMENT_DATA_DIR || join(process.env.WISH_DATA_DIR || join(homedir(), ".wish"), "management")),
      port: Number(process.env.WISH_WEBUI_PORT || 8790),
    }),
  });
  process.exitCode = await booted.completion;
} catch (error: unknown) {
  process.stderr.write(
    `wish-webui: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await booted?.dispose();
}
