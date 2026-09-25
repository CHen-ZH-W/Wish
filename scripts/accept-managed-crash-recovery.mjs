import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";

const cases = [
  ["fencing", "activated\n"],
  ["draining", "activated\ncleanup-started\n"],
  ["switching", "activated\ncleanup-started\ncleanup-finished\n"],
];

for (const [phase, effects] of cases) test(`SIGKILL during ${phase} restarts quarantined without replay`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-crash-"));
  let child;
  const spawn = mode => fork(new URL("./support/managed-crash-child.mjs", import.meta.url), [directory, mode], { silent: true });
  try {
    await writeFile(join(directory, "cordis.json"), JSON.stringify([{ id: "feature", name: "cordis:feature", management: { class: "managed" } }]));
    child = spawn(phase);
    assert.equal((await once(child, "message"))[0].phase, phase);
    const crashed = JSON.parse(await readFile(join(directory, "plugins.json"), "utf8"));
    assert.equal(crashed.pending.requestId, "crash-stop");
    assert.equal(crashed.operations.find(operation => operation.requestId === "crash-stop").phase, phase);
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
    child = spawn("recover");
    const exited = once(child, "exit");
    const recovered = (await once(child, "message"))[0];
    assert.deepEqual(recovered, { phase: "recovered", activations: 0, before: "recovery-required", pendingBefore: "crash-stop",
      operationBefore: "recovery-required", operationCodeBefore: "management_recovery_required",
      preference: "disabled", code: "management_recovered_disabled", enabled: false });
    assert.equal((await exited)[0], 0);
    assert.equal(await readFile(join(directory, "effects.log"), "utf8"), effects);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    await rm(directory, { recursive: true, force: true });
  }
});
