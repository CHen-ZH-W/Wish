import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

for (const surface of ["cli", "webui"]) test(`${surface} business owners declare lifecycle and code replacement policy`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-coverage-")); let booted;
  try {
    booted = await bootstrap({ surface, argv: surface === "cli" ? ["--version"] : [], cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0", WISH_WEB_FETCH_ENABLED: "1", WISH_MEMORY_CURATION_ENABLED: "1" },
      management: surface === "webui" ? managedWebUi({ directory: join(directory, "management"), port: 0 }) : {
        directory: join(directory, "management"),
        async start() { return async () => {}; },
      },
    });
    const snapshot = booted.pluginManagement?.snapshot(), inspection = booted.plugins.inspect();
    const owners = inspection.fibers.filter(fiber => fiber.phase === "active" && fiber.entryId &&
      inspection.entries.find(entry => entry.id === fiber.entryId)?.kind === "plugin" &&
      !["include", "include:timer", "include:hmr"].includes(fiber.entryId)); // Native process infrastructure, not Wish owners.
    assert.ok(owners.length >= 60);
    assert.ok(snapshot, "managed bootstrap must expose the Host coverage snapshot");
    const activeEntries = inspection.entries.filter(entry => entry.kind === "plugin" && entry.phase === "active");
    const activeManaged = new Set(activeEntries.filter(entry => entry.managementClass === "managed").map(entry => entry.id));
    const activeManagedFibers = new Set(inspection.fibers.filter(fiber => fiber.phase === "active" &&
      fiber.entryId !== null && activeManaged.has(fiber.entryId)).map(fiber => fiber.id));
    const debt = {
      noncompliant: activeEntries.filter(entry => entry.managementClass === "noncompliant").map(entry => entry.id).sort(),
      compatibility: snapshot.owners.filter(owner => activeManagedFibers.has(owner.fiberId) && owner.declaration !== "canonical")
        .map(owner => owner.fiberId).sort((a, b) => a - b),
      restart: snapshot.protocols.filter(item => activeManaged.has(item.entryId) && item.conformance === "restart")
        .map(item => ({ entryId: item.entryId, stop: item.stop, codeUpdate: item.codeUpdate })).sort((a, b) => a.entryId.localeCompare(b.entryId)),
      incomplete: snapshot.protocols.filter(item => activeManaged.has(item.entryId) && item.conformance === "incomplete")
        .map(item => ({ entryId: item.entryId, stop: item.stop, codeUpdate: item.codeUpdate })).sort((a, b) => a.entryId.localeCompare(b.entryId)),
    };
    assert.deepEqual(snapshot.protocols.find(item => item.entryId === "include:tool-read"), {
      entryId: "include:tool-read", conformance: "online", stop: "online", codeUpdate: "online",
    });
    assert.deepEqual(debt, { noncompliant: [], compatibility: [], restart: [], incomplete: [] },
      `managed plugins must support same-process stop and replacement:\n${JSON.stringify(debt, null, 2)}`);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
