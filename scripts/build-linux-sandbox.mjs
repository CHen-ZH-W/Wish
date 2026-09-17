import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  process.stdout.write("Skipping Linux Native Shell build on non-Linux platform\n");
  process.exit(0);
}

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDirectory, "..");
const outputDirectory = join(root, "native", "bin");
const output = join(outputDirectory, "wish-linux-sandbox");
mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync(
  process.env.CC ?? "cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    output,
    join(root, "native", "wish-linux-sandbox.c"),
  ],
  { stdio: "inherit" },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`Built ${output}\n`);
