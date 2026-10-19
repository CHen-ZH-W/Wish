#!/usr/bin/env node

import { bootstrap } from "../../boot/bootstrap.js";
import { headlessManagement } from "../../boot/plugin-control/headless-management.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

let booted: Awaited<ReturnType<typeof bootstrap>> | undefined;

try {
  booted = await bootstrap({
    surface: "cli",
    argv: process.argv.slice(2),
    ...(process.env.WISH_MANAGED_CLI === "1" || process.argv[2] === "candidate" ? { management: headlessManagement(resolve(process.env.WISH_MANAGEMENT_DATA_DIR || join(process.env.WISH_DATA_DIR || join(homedir(), ".wish"), "management"))) } : {}),
  });
  process.exitCode = await booted.completion;
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wish: ${message}\n`);
  process.exitCode = 1;
} finally {
  await booted?.dispose();
}
