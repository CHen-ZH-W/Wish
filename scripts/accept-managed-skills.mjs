import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("shipped managed profile disables actual Skills provider and all dependent entrypoints, then restores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-managed-skills-"));
  let booted;
  try {
    await mkdir(join(directory, ".wish", "skills", "sample"), { recursive: true });
    await writeFile(join(directory, ".wish", "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Local sample\n---\nRead the sample.\n");
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const ctx = booted.surfaceContext;
    const captured = ctx.get("skills");
    assert.equal((await captured.list({ cwd: directory })).skills.length, 1);
    assert.ok(ctx.get("tools").registry.list().some(tool => tool.name === "read_skill"));
    const snapshot = booted.pluginManagement.snapshot();
    const off = await booted.pluginManagement.change({ requestId: "skills-off", revision: snapshot.revision, preference: "disabled",
      selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:skills-local"] } });
    assert.equal(off.status, "succeeded", JSON.stringify(off));
    assert.equal(ctx.get("skills"), undefined);
    assert.equal(ctx.get("tools").registry.list().some(tool => tool.name === "read_skill" || tool.name === "list_skills"), false);
    await assert.rejects(captured.list({ cwd: directory }));
    const after = booted.pluginManagement.snapshot();
    const on = await booted.pluginManagement.change({ requestId: "skills-on", revision: after.revision, preference: "enabled", selection: { instanceId: after.inspection.instanceId, entryIds: ["include:skills-local"] } });
    assert.equal(on.status, "succeeded", JSON.stringify(on));
    assert.equal((await ctx.get("skills").list({ cwd: directory })).skills.length, 1);
    assert.ok(ctx.get("tools").registry.list().some(tool => tool.name === "read_skill"));
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
