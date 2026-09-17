import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch, parsePatch, reversePatch } from "diff";
import { applyCordisHmrPatch } from "./apply-cordis-hmr-patch.mjs";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";

test("the pinned dependency patch survives clean install, repetition and partial install; rejects drift before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-hmr-patch-"));
  try {
    const patches = parsePatch(await readFile(new URL("./patches/cordis-hmr-1.0.17.patch", import.meta.url), "utf8"));
    const originals = new Map(), patched = new Map();
    await writeFile(join(directory, "package.json"), '{"version":"1.0.17"}');
    for (const patch of patches) {
      const name = patch.newFileName.slice(2);
      const current = await readFile(new URL(`../node_modules/@deepseek-ai/cordis-plugin-hmr/${name}`, import.meta.url), "utf8");
      const original = applyPatch(current, reversePatch(patch)); assert.notEqual(original, false);
      originals.set(name, original); patched.set(name, current);
      await mkdir(dirname(join(directory, name)), { recursive: true }); await writeFile(join(directory, name), original);
    }
    applyCordisHmrPatch(directory); applyCordisHmrPatch(directory);
    for (const [name, current] of patched) assert.equal(await readFile(join(directory, name), "utf8"), current);
    const metadata = JSON.parse(await readFile(new URL("./patches/cordis-hmr-1.0.17.json", import.meta.url), "utf8"));
    for (const [name, current] of patched) {
      const previous = [...metadata[name].upgrade].reverse().reduce((value, change) => value.replace(change.to, change.from), current);
      await writeFile(join(directory, name), previous);
    }
    applyCordisHmrPatch(directory);
    for (const [name, current] of patched) assert.equal(await readFile(join(directory, name), "utf8"), current);
    await writeFile(join(directory, "src/index.ts"), originals.get("src/index.ts"));
    applyCordisHmrPatch(directory);
    assert.equal(await readFile(join(directory, "src/index.ts"), "utf8"), patched.get("src/index.ts"));
    await writeFile(join(directory, "src/index.ts"), originals.get("src/index.ts"));
    await writeFile(join(directory, "lib/index.js"), patched.get("lib/index.js") + "\n// unknown edit\n");
    assert.throws(() => applyCordisHmrPatch(directory), /Unreviewed/);
    assert.equal(await readFile(join(directory, "src/index.ts"), "utf8"), originals.get("src/index.ts"));
    await writeFile(join(directory, "package.json"), '{"version":"1.0.18"}');
    assert.throws(() => applyCordisHmrPatch(directory), /Review HMR/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Boot fails closed when the framework coordination patch is missing", async () => {
  const { bootstrap } = await import("../dist/boot/bootstrap.js");
  const marker = Hmr.coordinationVersion;
  try {
    Hmr.coordinationVersion = undefined;
    await assert.rejects(bootstrap({ surface: "cli", argv: ["--version"], environment: {} }), /coordination patch missing/);
  } finally { Hmr.coordinationVersion = marker; }
});
