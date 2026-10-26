import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { WebUiControlRegistry } from "../dist/apps/webui/controls.js";
import { createSkillsWebUiControl } from "../dist/skills/consumers/webui-control.js";

const manifest = (name, text = "Read these instructions.", manual = false) =>
  `---\nname: ${name}\ndescription: ${name} instructions\n${manual ? "disable-model-invocation: true\n" : ""}---\n# ${name}\n\n${text}\n`;

test("default query and mutation controls are independently registerable capabilities", () => {
  const controls = new WebUiControlRegistry();
  const removeQuery = controls.register("read-library", { queryDefault() { return "read"; } });
  const removeUpdate = controls.register("import-library", { updateDefault() { return "write"; } });
  assert.equal(typeof controls.get("read-library").queryDefault, "function");
  assert.equal(typeof controls.get("import-library").updateDefault, "function");
  removeQuery(); removeUpdate();
  assert.equal(controls.get("read-library"), undefined);
  assert.equal(controls.get("import-library"), undefined);
});

test("a committed import reports a failed catalog refresh without claiming the package was rolled back", async () => {
  let committed = false;
  const skill = { name: "imported", description: "Imported instructions", source: "user", location: "/user/imported/SKILL.md",
    packageId: "package", digest: "digest", modelInvocable: true };
  const control = createSkillsWebUiControl({
    importCapabilities() { return { maxFiles: 256, maxFileBytes: 64000, maxPackageBytes: 512000 }; },
    async importPackage() { committed = true; return skill; },
    async list() { throw Error("catalog temporarily unreadable"); },
  }, { async resolve({ root }) { return { root, fingerprint: "workspace", revision: "revision" }; } });
  await assert.rejects(control.updateDefault({}, { files: [{ path: "SKILL.md", content: manifest("imported") }],
    expectedCatalogDigest: "catalog", overwrite: false }, new AbortController().signal, { workspaceRoot: "/workspace" }),
    error => error.code === "skill_import_refresh_required" && /Skill 已导入/u.test(error.message));
  assert.equal(committed, true);
});

test("the shipped library lists, reads and imports without Sessions, uses the Host workspace and survives restart", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-skills-library-"));
  const workspace = join(directory, "workspace"), users = join(directory, "user-skills");
  let booted, url, token;
  const start = async () => {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: workspace,
        WISH_SKILLS_USER_ROOT: users, WISH_SKILLS_SESSION_FEATURE_ENABLED: "0" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    url = booted.context.get("webManagementHost").url;
    token = (await (await fetch(url + "/api/management/bootstrap")).json()).token;
  };
  const get = async () => {
    const response = await fetch(url + "/api/controls/skills/default");
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).value;
  };
  const post = async (path, body, withToken = true) => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json",
      ...(withToken ? { "x-wish-management-token": token } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  try {
    await mkdir(join(workspace, ".agents", "skills", "project-skill"), { recursive: true });
    await writeFile(join(workspace, ".agents", "skills", "project-skill", "SKILL.md"), manifest("project-skill"));
    await mkdir(join(users, "manual-skill"), { recursive: true });
    await writeFile(join(users, "manual-skill", "SKILL.md"), manifest("manual-skill", "For human review.", true));
    await start();
    const sessions = booted.surfaceContext.get("sessions").manager;
    const initial = await get();
    assert.equal(initial.workspace.root, workspace, "library follows WebUI configuration rather than launch cwd or a Session");
    assert.deepEqual(initial.skills.map(skill => skill.name), ["manual-skill", "project-skill"]);
    assert.equal(initial.skills[0].modelInvocable, false);
    assert.ok(initial.import.maxFiles > 0);
    assert.equal((await sessions.list()).length, 0);

    const entry = initial.skills[0];
    const query = { name: entry.name, expectedDigest: entry.digest, expectedPackageId: entry.packageId };
    let response = await post("/api/queries/skills/default", query);
    assert.equal(response.status, 200);
    assert.match(response.value.content, /For human review/u);
    assert.equal(response.value.entry.modelInvocable, false);
    assert.equal((await post("/api/queries/skills/default", { ...query, cwd: directory })).status, 400,
      "clients cannot choose a filesystem root");
    assert.equal((await post("/api/queries/skills/default", query, false)).status, 403);

    const files = [{ path: "downloaded/SKILL.md", content: manifest("new-skill", "Imported instructions.") },
      { path: "downloaded/references/guide.md", content: "Useful reference." }];
    const request = { files, overwrite: false, expectedCatalogDigest: initial.catalogDigest };
    assert.equal((await post("/api/controls/skills/default", request, false)).status, 403);
    response = await post("/api/controls/skills/default", request);
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.value.imported.name, "new-skill");
    assert.equal(response.value.imported.source, "user");
    assert.equal(response.value.catalog.skills.length, 3);
    assert.equal(await readFile(join(users, "new-skill", "references", "guide.md"), "utf8"), "Useful reference.");
    assert.equal((await sessions.list()).length, 0, "global import must not manufacture a Session");
    const current = response.value.catalog;
    const imported = response.value.imported;
    const read = await booted.surfaceContext.get("skills").read({ cwd: workspace, name: imported.name,
      expectedDigest: imported.digest, expectedPackageId: imported.packageId, invocation: "model" });
    assert.match(read.content, /Imported instructions/u, "new imports are available through the existing Skills capability");
    assert.equal((await post("/api/controls/skills/default", request)).status, 409, "stale catalog cannot authorize another import");
    assert.equal((await post("/api/controls/skills/default", { ...request, expectedCatalogDigest: current.catalogDigest })).status, 409,
      "a current catalog still requires explicit overwrite");
    response = await post("/api/controls/skills/default", { files: [{ path: "SKILL.md", content: manifest("new-skill", "Replacement.") }],
      overwrite: true, expectedCatalogDigest: current.catalogDigest });
    assert.equal(response.status, 200, JSON.stringify(response));
    await assert.rejects(readFile(join(users, "new-skill", "references", "guide.md")), { code: "ENOENT" });

    const controls = booted.surfaceContext.get("webUiControls");
    assert.equal(typeof controls.get("skills").updateDefault, "function");
    const snapshot = booted.pluginManagement.snapshot();
    const disabled = await booted.pluginManagement.change({ requestId: "library-off", revision: snapshot.revision,
      preference: "disabled", selection: { instanceId: snapshot.inspection.instanceId, entryIds: ["include:skills-webui-control"] } });
    assert.equal(disabled.status, "succeeded", JSON.stringify(disabled));
    assert.equal(controls.get("skills"), undefined);
    assert.equal((await fetch(url + "/api/controls/skills/default")).status, 404);
    assert.equal((await booted.surfaceContext.get("skills").list({ cwd: workspace })).skills.length, 3,
      "removing the UI consumer preserves imported Skill data and capability");
    const after = booted.pluginManagement.snapshot();
    const enabled = await booted.pluginManagement.change({ requestId: "library-on", revision: after.revision,
      preference: "enabled", selection: { instanceId: after.inspection.instanceId, entryIds: ["include:skills-webui-control"] } });
    assert.equal(enabled.status, "succeeded", JSON.stringify(enabled));
    await booted.dispose(); booted = undefined;
    await start();
    const restored = await get();
    assert.equal(restored.skills.length, 3);
    const restoredEntry = restored.skills.find(skill => skill.name === "new-skill");
    response = await post("/api/queries/skills/default", { name: restoredEntry.name,
      expectedDigest: restoredEntry.digest, expectedPackageId: restoredEntry.packageId });
    assert.match(response.value.content, /Replacement/u);
    assert.equal((await booted.surfaceContext.get("sessions").manager.list()).length, 0);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
