import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("product graph persists a Session reasoning choice across Host restart", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-reasoning-product-"));
  let booted;
  const start = () => bootstrap({
    surface: "webui", cwd: directory, homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
    management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
  });
  try {
    booted = await start();
    const sessions = booted.surfaceContext.get("sessions").manager;
    let url = booted.context.get("webManagementHost").url;
    let response = await fetch(url + "/api/model-reasoning/default");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selection.model.model, "deepseek-flash");
    assert.equal((await sessions.list()).length, 0, "pre-Session capability discovery does not create a Session");
    await sessions.create({ sessionId: "reasoning-session", agentId: booted.surfaceContext.get("agents").agentId, scope: directory });
    const path = "/api/sessions/reasoning-session/model-reasoning";
    response = await fetch(url + path);
    assert.equal(response.status, 200);
    const first = (await response.json()).selection;
    assert.equal(first.model.model, "deepseek-flash");
    assert.deepEqual(first.control.efforts, ["none", "low", "high", "max"]);
    const bootstrapResponse = await fetch(url + "/api/management/bootstrap");
    const { token } = await bootstrapResponse.json();
    response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", "x-wish-management-token": token },
      body: JSON.stringify({ model: first.model, effort: "low" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selection.selected, "low");
    await booted.dispose(); booted = undefined;
    booted = await start();
    url = booted.context.get("webManagementHost").url;
    response = await fetch(url + path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selection.selected, "low");
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
