import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}

test("managed tmux disable fences new commands and drains the admitted command before re-enable", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-tmux-drain-"));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let booted, admitted, disabling;
  try {
    booted = await bootstrap({
      surface: "webui",
      cwd: directory,
      homeDirectory: directory,
      environment: {
        CORDIS_HMR: "0",
        WISH_DATA_DIR: join(directory, "data"),
        WISH_SUBAGENTS_ENABLED: "0",
      },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    const entryId = "include:tmux-local", entry = booted.context.loader.resolve(entryId);
    const previousFiber = entry.fiber, previous = booted.surfaceContext.get("tmux");
    previous.backend.list = async () => {
      entered.resolve();
      await release.promise;
      return Object.freeze([]);
    };
    admitted = previous.list();
    await entered.promise;

    const selection = {
      instanceId: booted.pluginManagement.snapshot().inspection.instanceId,
      entryIds: [entryId],
    };
    const observation = await booted.context.pluginLifecycle.collect(selection);
    const owner = observation.owners.find(item => item.fiberId === previousFiber.uid);
    assert.deepEqual(owner?.status, {
      disposition: "drain",
      code: "tmux_commands_active",
      counts: { active_requests: 1 },
    });

    const before = booted.pluginManagement.snapshot();
    let settled = false;
    disabling = booted.pluginManagement.change({
      requestId: randomUUID(),
      revision: before.revision,
      preference: "disabled",
      selection,
    }).finally(() => { settled = true; });
    await until(() => previous.suspended === true &&
      booted.context.pluginChanges.snapshot().active?.phase === "draining", "tmux admission fence");
    await assert.rejects(previous.list(), /closed/i);
    await delay(20);
    assert.equal(settled, false, "disable must wait for the admitted command");

    release.resolve();
    assert.deepEqual(await admitted, []);
    const disabled = await disabling;
    assert.equal(disabled.status, "succeeded", JSON.stringify(disabled));
    assert.equal(entry.fiber, undefined);
    assert.equal(previousFiber.state, 4);
    assert.equal(booted.surfaceContext.get("tmux"), undefined);
    await assert.rejects(previous.list(), /closed/i);

    const afterDisable = booted.pluginManagement.snapshot();
    const enabled = await booted.pluginManagement.change({
      requestId: randomUUID(),
      revision: afterDisable.revision,
      preference: "enabled",
      selection: { instanceId: afterDisable.inspection.instanceId, entryIds: [entryId] },
    });
    assert.equal(enabled.status, "succeeded", JSON.stringify(enabled));
    assert.notEqual(entry.fiber, previousFiber);
    assert.equal(entry.fiber.state, 2);
    assert.notEqual(booted.surfaceContext.get("tmux"), previous);
    await assert.rejects(previous.list(), /closed/i);
  } finally {
    release.resolve();
    await Promise.allSettled([admitted, disabling]);
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
