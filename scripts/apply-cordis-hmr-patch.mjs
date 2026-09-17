import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch } from "diff";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = value => createHash("sha256").update(value).digest("hex");

/** Version/content-pinned package patch, not a runtime monkey-patch. */
export function applyCordisHmrPatch(dependency = join(repository, "node_modules/@deepseek-ai/cordis-plugin-hmr")) {
  const manifest = JSON.parse(readFileSync(join(dependency, "package.json"), "utf8"));
  if (manifest.version !== "1.0.17") throw Error(`Review HMR coordination patch for ${manifest.version}`);
  const metadata = JSON.parse(readFileSync(join(repository, "scripts/patches/cordis-hmr-1.0.17.json"), "utf8"));
  const patches = parsePatch(readFileSync(join(repository, "scripts/patches/cordis-hmr-1.0.17.patch"), "utf8"));
  if (patches.length !== 3) throw Error("Incomplete HMR patch");
  // Validate all files before writing any; tolerate a partially applied install,
  // never a different upstream revision or local changes outside the patch.
  const writes = patches.map(patch => {
    const name = patch.newFileName.slice(2), expected = metadata[name];
    if (!["src/index.ts", "lib/index.js", "lib/types/index.d.ts"].includes(name) || !expected) throw Error("Unexpected patch target");
    const path = join(dependency, name), source = readFileSync(path, "utf8"), digest = hash(source);
    if (digest === expected.after) return { path, source };
    if (digest === expected.previous) {
      const next = expected.upgrade.reduce((value, change) => {
        if (value.split(change.from).length !== 2) throw Error(`Ambiguous HMR patch upgrade: ${name}`);
        return value.replace(change.from, change.to);
      }, source);
      if (hash(next) !== expected.after) throw Error(`Invalid HMR patch upgrade: ${name}`);
      return { path, source: next };
    }
    if (digest !== expected.before) throw Error(`Unreviewed HMR package contents: ${name}`);
    const next = applyPatch(source, patch, { fuzzFactor: 0 });
    if (next === false || hash(next) !== expected.after) throw Error(`Invalid HMR patch: ${name}`);
    return { path, source: next };
  });
  for (const { path, source } of writes) if (readFileSync(path, "utf8") !== source) writeFileSync(path, source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) applyCordisHmrPatch();
