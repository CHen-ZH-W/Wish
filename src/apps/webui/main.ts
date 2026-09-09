#!/usr/bin/env node

import { bootstrap } from "../../boot/bootstrap.js";

let booted: Awaited<ReturnType<typeof bootstrap>> | undefined;

try {
  booted = await bootstrap({
    surface: "webui",
    argv: process.argv.slice(2),
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
