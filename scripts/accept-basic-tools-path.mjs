import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  expandPath,
  resolveReadPath,
  resolveToCwd,
} from "../dist/filesystem/consumers/model-tools/path.js";

test("expands home and normalizes Unicode spaces without stripping @", () => {
  assert.equal(expandPath("~"), homedir());
  assert.equal(expandPath("~/Documents/file.txt"), `${homedir()}/Documents/file.txt`);
  assert.equal(expandPath("file\u00A0name\u3000copy.txt"), "file name copy.txt");
  assert.equal(expandPath("@scope/file.txt"), "@scope/file.txt");
});

test("resolves relative paths against cwd and preserves absolute paths", () => {
  const cwd = resolve(tmpdir(), "wish-path-cwd");
  assert.equal(resolveToCwd("nested/../file.txt", cwd), join(cwd, "file.txt"));
  assert.equal(resolveToCwd("/absolute/../file.txt", cwd), "/absolute/../file.txt");
});

test("resolves readable macOS filename variants in a stable order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-tools-path-"));
  try {
    const screenshot = "Screenshot 2026-09-03 at 10.00.00\u202FPM.png";
    const nfdName = "filee\u0301.txt";
    const curlyName = "Capture d\u2019ecran.txt";
    const combinedName = "Capture d\u2019e\u0301cran.txt";
    await Promise.all([
      writeFile(join(directory, screenshot), "screenshot"),
      writeFile(join(directory, nfdName), "nfd"),
      writeFile(join(directory, curlyName), "curly"),
      writeFile(join(directory, combinedName), "combined"),
    ]);

    assert.equal(
      resolveReadPath("Screenshot 2026-09-03 at 10.00.00 PM.png", directory),
      join(directory, screenshot),
    );
    assert.equal(resolveReadPath("file\u00E9.txt", directory), join(directory, nfdName));
    assert.equal(resolveReadPath("Capture d'ecran.txt", directory), join(directory, curlyName));
    assert.equal(
      resolveReadPath("Capture d'\u00E9cran.txt", directory),
      join(directory, combinedName),
    );
    assert.equal(
      resolveReadPath("missing.txt", directory),
      join(directory, "missing.txt"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
