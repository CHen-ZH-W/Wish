#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generateModels, renderGeneratedModels } from "./generator.mjs";

const outputPath = fileURLToPath(
  new URL("../../src/models/models.generated.ts", import.meta.url),
);
const check = process.argv.slice(2).includes("--check");

try {
  const models = await generateModels();
  const output = renderGeneratedModels(models);
  if (check) {
    const existing = await readFile(outputPath, "utf8").catch(() => undefined);
    if (existing !== output) {
      throw new Error(
        "Generated Models are stale; run npm run models:generate and commit the result",
      );
    }
    process.stdout.write(`${statistics(models)}\nGenerated Models are current\n`);
  } else {
    await atomicWrite(outputPath, output);
    process.stdout.write(`${statistics(models)}\nUpdated ${outputPath}\n`);
  }
} catch (error) {
  process.stderr.write(
    `models:generate: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function atomicWrite(path, contents) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let temporaryExists = false;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    temporaryExists = true;
    await rename(temporaryPath, path);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

function statistics(models) {
  const entries = Object.entries(models);
  const count = entries.reduce((total, [, values]) => total + values.length, 0);
  return `Generated ${count} tool-capable models across ${entries.length} Providers`;
}
