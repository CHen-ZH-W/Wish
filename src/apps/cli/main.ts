#!/usr/bin/env node

import { bootstrap } from "../../boot/bootstrap.js";

let booted: Awaited<ReturnType<typeof bootstrap>> | undefined;

try {
  booted = await bootstrap({
    surface: "cli",
    argv: process.argv.slice(2),
  });
  process.exitCode = await booted.completion;
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wish: ${message}\n`);
  process.exitCode = 1;
} finally {
  await booted?.dispose();
}
