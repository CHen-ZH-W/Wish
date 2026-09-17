import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials } from "../dist/credentials/credentials.js";
import { FileCredentialStore } from "../dist/credentials/providers/file.js";

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-credentials-"));
  try { await run(join(directory, "credentials.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("credentials are write-only, durable, and environment values stay authoritative", () => fixture(async filename => {
  const credentials = new Credentials(await FileCredentialStore.open(filename), { ENV_KEY: "from-launch" });
  try {
    assert.deepEqual(credentials.describe(["STORED_KEY", "ENV_KEY"]), [
      { reference: "STORED_KEY", configured: false, source: "missing", writable: true },
      { reference: "ENV_KEY", configured: true, source: "environment", writable: false },
    ]);
    const status = await credentials.set("STORED_KEY", "secret-value");
    assert.deepEqual(status, { reference: "STORED_KEY", configured: true, source: "stored", writable: true });
    assert.equal(JSON.stringify(status).includes("secret-value"), false);
    assert.equal(credentials.resolve("STORED_KEY"), "secret-value");
    assert.equal(credentials.resolve("ENV_KEY"), "from-launch");
    await assert.rejects(credentials.set("ENV_KEY", "shadow"), { code: "credentials_read_only" });
  } finally { await credentials.close(); }
  assert.equal((await stat(filename)).mode & 0o077, 0);
  assert.equal((await readFile(filename, "utf8")).includes("secret-value"), true);
  const reopened = new Credentials(await FileCredentialStore.open(filename), {});
  try { assert.equal(reopened.describe(["STORED_KEY"])[0].configured, true); }
  finally { await reopened.close(); }
}));

test("unsafe values and overly broad existing files fail closed without echoing values", () => fixture(async filename => {
  const credentials = new Credentials(await FileCredentialStore.open(filename), {});
  try {
    for (const value of ["", "A_KEY=value", "'quoted'", "line\nbreak"]) {
      assert.throws(() => credentials.set("VALID_KEY", value), { code: "credentials_invalid_value" });
    }
  } finally { await credentials.close(); }
  await writeFile(filename, JSON.stringify({ version: 1, revision: "x", values: { VALID_KEY: "private" } }));
  if (process.platform !== "win32") {
    await chmod(filename, 0o644);
    await assert.rejects(FileCredentialStore.open(filename), { code: "credentials_store_permissions" });
  }
}));
