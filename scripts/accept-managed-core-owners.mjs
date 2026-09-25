import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const shared = [
  ["include:storage", "storage/service.js"],
  ["include:storage-file", "storage/providers/file/plugin.js"],
  ["include:runtime-lifecycle-journal", "core/runtime/durability/providers/journal.js"],
  ["include:session-persistence", "sessions/providers/file/plugin.js"],
  ["include:sessions", "sessions/service.js"],
  ["include:approval-hub", "approval/service.js"],
  ["include:models", "models/service.js"],
  ["include:workflow-continuations", "workflow/providers/continuations.js"],
  ["include:runtime", "composition/runtime-service.js"],
  ["include:agents", "composition/agent-service.js"],
  ["include:application", "apps/service.js"],
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

async function fixture(surface, run) {
  const directory = await mkdtemp(join(tmpdir(), `wish-core-${surface}-`));
  let booted;
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    const options = {
      surface,
      argv: surface === "cli" ? ["--version"] : [],
      cwd: directory,
      homeDirectory: directory,
      environment: { CORDIS_HMR: "1", WISH_DATA_DIR: join(directory, "data") },
    };
    if (surface === "webui") {
      const { managedWebUi } = await import(pathToFileURL(join(directory, "dist/apps/webui/host/composition.js")));
      options.management = managedWebUi({ directory: join(directory, "management"), port: 0 });
    } else options.management = {
      directory: join(directory, "management"),
      async start() { return async () => {}; },
    };
    booted = await bootstrap(options);
    if (surface === "cli") assert.equal(await booted.completion, 0);
    await run({ booted, directory });
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function change(booted, entryId, preference) {
  const before = booted.pluginManagement.snapshot();
  const receipt = await booted.pluginManagement.change({
    requestId: randomUUID(),
    revision: before.revision,
    preference,
    selection: { instanceId: before.inspection.instanceId, entryIds: [entryId] },
  });
  assert.equal(receipt.status, "succeeded", `${entryId} ${preference}: ${JSON.stringify(receipt)}`);
  return booted.pluginManagement.snapshot();
}

function assertOnline(booted, entryId) {
  const protocol = booted.pluginManagement.snapshot().protocols.find(item => item.entryId === entryId);
  assert.deepEqual(protocol, { entryId, conformance: "online", stop: "online", codeUpdate: "online" });
}

test("all shared core owners stop and re-enable in one WebUI Host without restart", { timeout: 30000 }, () => fixture("webui", async ({ booted }) => {
  for (const [entryId] of shared) {
    const entry = booted.context.loader.resolve(entryId), previous = entry.fiber;
    assertOnline(booted, entryId);
    await change(booted, entryId, "disabled");
    assert.equal(entry.fiber, undefined, `${entryId} remained active after disable`);
    assert.equal(previous.state, 4, `${entryId} old Fiber was not disposed`);
    await change(booted, entryId, "enabled");
    assert.notEqual(entry.fiber, previous, `${entryId} reused its old Fiber`);
    assert.equal(entry.fiber.state, 2, `${entryId} successor is not active`);
    assertOnline(booted, entryId);
  }
}));

test("all shared core owners perform native code replacement and renew their Fiber", { timeout: 45000 }, () => fixture("webui", async ({ booted, directory }) => {
  for (const [entryId, relative] of shared) {
    const entry = booted.context.loader.resolve(entryId), previous = entry.fiber;
    const revision = booted.codeReload.snapshot().revision;
    const filename = join(directory, "dist", relative);
    await writeFile(filename, `${await readFile(filename, "utf8")}\n// managed core replacement ${entryId}\n`);
    await until(() => booted.codeReload.snapshot().revision > revision &&
      ["succeeded", "rejected", "recovery-required"].includes(booted.codeReload.snapshot().phase), entryId);
    assert.deepEqual({ phase: booted.codeReload.snapshot().phase, code: booted.codeReload.snapshot().code },
      { phase: "succeeded", code: "code_reload_applied" }, `${entryId}: ${JSON.stringify(booted.codeReload.snapshot())}`);
    assert.notEqual(entry.fiber, previous, `${entryId} did not renew its Fiber`);
    assert.equal(previous.state, 4, `${entryId} old Fiber was not disposed`);
    assert.equal(entry.fiber.state, 2, `${entryId} successor is not active`);
    assertOnline(booted, entryId);
  }
}));

test("the WebUI business owner stops, re-enables and replaces while the Root host stays live", { timeout: 20000 }, () => fixture("webui", async ({ booted, directory }) => {
  const entryId = "include:webui", entry = booted.context.loader.resolve(entryId), first = entry.fiber;
  const url = booted.context.webManagementHost.url;
  assert.equal((await fetch(`${url}/api/management/bootstrap`)).status, 200);
  await change(booted, entryId, "disabled");
  assert.equal((await fetch(`${url}/api/management/bootstrap`)).status, 200);
  assert.equal((await (await fetch(`${url}/api/management/bootstrap`)).json()).businessAvailable, false);
  await change(booted, entryId, "enabled");
  assert.notEqual(entry.fiber, first);
  assert.equal((await (await fetch(`${url}/api/management/bootstrap`)).json()).businessAvailable, true);
  const previous = entry.fiber, revision = booted.codeReload.snapshot().revision;
  const filename = join(directory, "dist/apps/webui/plugin.js");
  await writeFile(filename, `${await readFile(filename, "utf8")}\n// managed WebUI replacement\n`);
  await until(() => booted.codeReload.snapshot().revision > revision &&
    ["succeeded", "rejected", "recovery-required"].includes(booted.codeReload.snapshot().phase), entryId);
  assert.equal(booted.codeReload.snapshot().phase, "succeeded", JSON.stringify(booted.codeReload.snapshot()));
  assert.notEqual(entry.fiber, previous);
  assert.equal((await (await fetch(`${url}/api/management/bootstrap`)).json()).businessAvailable, true);
  assertOnline(booted, entryId);
}));
