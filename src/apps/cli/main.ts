#!/usr/bin/env node

import { bootstrap } from "../../boot/bootstrap.js";
import { headlessManagement } from "../../boot/plugin-control/headless-management.js";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

let booted: Awaited<ReturnType<typeof bootstrap>> | undefined;

try {
  const directory = resolve(process.env.WISH_PLUGIN_POLICY_DIR || process.env.WISH_MANAGEMENT_DATA_DIR ||
    join(process.env.WISH_DATA_DIR || join(homedir(), ".wish"), "management"));
  booted = await bootstrap({
    surface: "cli",
    argv: process.argv.slice(2),
    ...(process.env.WISH_MANAGED_CLI === "1" || process.argv[2] === "candidate"
      ? { management: headlessManagement(directory) }
      : { pluginPolicyDirectory: directory }),
  });
  if (booted.plugins.inspect().entries.find(entry => entry.id === "include:cli")?.phase !== "active") {
    throw new Error("system_plugin_required_entry_unavailable:include:cli");
  }
  process.exitCode = await booted.completion;
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wish: ${message}\n`);
  process.exitCode = 1;
} finally {
  await booted?.dispose();
}
