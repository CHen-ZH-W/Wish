import assert from "node:assert/strict";
import test from "node:test";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { SkillsClientModel } from "../dist/skills/consumers/webui/model.js";

const entry = (name, digest = `${name}-v1`) => ({ packageId: `user:${name}`, name, description: `${name} instructions`, source: "user", digest, modelInvocable: true });
const first = entry("first"), second = entry("second"), imported = entry("imported");
const catalog = (skills = [first, second], digest = "catalog-v1") => ({ schemaVersion: 1,
  workspace: { root: "/fixture/workspace", fingerprint: "workspace", revision: "workspace-v1" },
  catalogDigest: digest, skills, issues: [], import: { maxFiles: 100, maxFileBytes: 200_000, maxPackageBytes: 1_000_000 } });
const document = item => ({ schemaVersion: 1, entry: item, content: `# ${item.name}\n\nInstructions for ${item.digest}.` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

class Connection extends SnapshotStore {
  calls = [];
  invalidations = new Set();
  handler = async (path, body) => {
    if (path.startsWith("/api/queries/")) return { value: document([first, second, imported].find(item => item.name === body.name)) };
    return { value: catalog() };
  };
  constructor() { super({ online: true, businessAvailable: true, instanceId: "host-one", error: null }); }
  request = async (path, body) => { this.calls.push({ path, body }); return this.handler(path, body); };
  onInvalidation = callback => { this.invalidations.add(callback); return () => this.invalidations.delete(callback); };
  state(patch) { this.publish({ ...this.getSnapshot(), ...patch }); }
  invalidate() { for (const listener of this.invalidations) listener({ topics: ["controls"] }); }
}

test("Skills browses and imports without any Session model, binding reads and writes to the displayed catalog", async () => {
  const connection = new Connection(), model = new SkillsClientModel(connection);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().available, true);
    assert.deepEqual(model.getSnapshot().skills.map(item => item.name), ["first", "second"]);
    await model.select("first");
    assert.equal(model.getSnapshot().selected.entry.name, "first");
    assert.deepEqual(connection.calls.find(call => call.path === "/api/queries/skills/default").body,
      { name: "first", expectedDigest: first.digest, expectedPackageId: first.packageId });
    connection.handler = async (path, body) => {
      if (path === "/api/controls/skills/default" && body) return { value: { schemaVersion: 1, catalog: catalog([first, second, imported], "catalog-v2"), imported } };
      if (path.startsWith("/api/queries/")) return { value: document(imported) };
      return { value: catalog([first, second, imported], "catalog-v2") };
    };
    const files = [{ path: "SKILL.md", content: "---\nname: imported\ndescription: Imported instructions\n---\n# Imported\n" }];
    await model.importPackage(files, true);
    assert.deepEqual(connection.calls.find(call => call.path === "/api/controls/skills/default" && call.body).body,
      { files, expectedCatalogDigest: "catalog-v1", overwrite: true });
    assert.equal(model.getSnapshot().selected.entry.name, "imported", "a successful import opens the imported instructions");
    assert.equal(model.getSnapshot().catalog.catalogDigest, "catalog-v2");
    assert.ok(connection.calls.every(call => !call.path.includes("/sessions/")), "Skills transport never depends on a selected Session");
  } finally { model.close(); }
});

test("the most recently selected Skill keeps its document when an older read finishes late", async () => {
  const connection = new Connection(), model = new SkillsClientModel(connection), old = deferred();
  try {
    await model.refresh();
    connection.handler = async (path, body) => path.startsWith("/api/queries/")
      ? body.name === "first" ? old.promise : { value: document(second) }
      : { value: catalog() };
    const firstRead = model.select("first");
    await model.select("second");
    old.resolve({ value: document(first) }); await firstRead;
    assert.equal(model.getSnapshot().selected.entry.name, "second");
    assert.match(model.getSnapshot().selected.content, /second-v1/);
  } finally { old.resolve({ value: document(first) }); model.close(); }
});

test("a catalog read started before import cannot roll back the successful imported catalog", async () => {
  const connection = new Connection(), model = new SkillsClientModel(connection), old = deferred();
  let delayed = true;
  try {
    await model.refresh();
    connection.handler = async (path, body) => {
      if (path.startsWith("/api/queries/")) return { value: document(imported) };
      if (body) { delayed = false; return { value: { schemaVersion: 1, catalog: catalog([first, second, imported], "catalog-v2"), imported } }; }
      return delayed ? old.promise : { value: catalog([first, second, imported], "catalog-v2") };
    };
    const refresh = model.refresh();
    await model.importPackage([{ path: "SKILL.md", content: "# Imported" }]);
    old.resolve({ value: catalog() }); await refresh;
    assert.equal(model.getSnapshot().catalog.catalogDigest, "catalog-v2");
    assert.equal(model.getSnapshot().selected.entry.name, "imported");
    assert.ok(model.getSnapshot().skills.some(item => item.name === "imported"));
  } finally { old.resolve({ value: catalog() }); model.close(); }
});

test("disconnect blocks reads and imports; reconnect refreshes current authority before writes", async () => {
  const connection = new Connection(), model = new SkillsClientModel(connection);
  try {
    await model.refresh(); await model.select("first");
    connection.state({ online: false, error: "offline" });
    const calls = connection.calls.length;
    await model.select("second");
    await assert.rejects(model.importPackage([{ path: "SKILL.md", content: "# Offline" }]));
    assert.equal(connection.calls.length, calls, "offline admission rejects locally without attempting transport");
    assert.equal(model.getSnapshot().available, false);
    connection.handler = async () => ({ value: catalog([second], "catalog-reconnected") });
    connection.state({ online: true, error: null });
    await model.refresh();
    assert.equal(model.getSnapshot().available, true);
    assert.equal(model.getSnapshot().catalog.catalogDigest, "catalog-reconnected");
    assert.equal(model.getSnapshot().error, null);
    assert.equal(model.getSnapshot().selected, null, "a vanished Skill is no longer actionable after reconnection");
  } finally { model.close(); }
});

test("Host replacement rejects the previous Host's late read and import result", async () => {
  const connection = new Connection(), model = new SkillsClientModel(connection), oldRead = deferred(), oldImport = deferred();
  try {
    await model.refresh();
    connection.handler = async (path, body) => path.startsWith("/api/queries/") ? oldRead.promise : body ? oldImport.promise : { value: catalog() };
    const read = model.select("first");
    const mutation = model.importPackage([{ path: "SKILL.md", content: "# Old Host" }]).catch(() => {});
    connection.handler = async () => ({ value: catalog([second], "new-host-catalog") });
    connection.state({ instanceId: "host-two" });
    await model.refresh();
    oldRead.resolve({ value: document(first) }); oldImport.resolve({ value: { schemaVersion: 1, catalog: catalog([imported], "old-host-catalog"), imported } });
    await Promise.all([read, mutation]);
    assert.equal(model.getSnapshot().catalog.catalogDigest, "new-host-catalog");
    assert.deepEqual(model.getSnapshot().skills.map(item => item.name), ["second"]);
    assert.equal(model.getSnapshot().selected, null);
  } finally {
    oldRead.resolve({ value: document(first) }); oldImport.resolve({ value: { schemaVersion: 1, catalog: catalog([imported], "old-host-catalog"), imported } }); model.close();
  }
});

test("closing Skills detaches subscriptions and prevents late responses from publishing", async () => {
  const connection = new Connection(), model = new SkillsClientModel(connection), old = deferred();
  await model.refresh();
  connection.handler = () => old.promise;
  const pending = model.select("first");
  let publications = 0; const remove = model.subscribe(() => { publications++; });
  model.close(); const closedSnapshot = model.getSnapshot();
  old.resolve({ value: document(first) }); await pending;
  connection.invalidate(); connection.state({ instanceId: "after-close" }); await tick();
  assert.equal(model.getSnapshot(), closedSnapshot);
  assert.equal(publications, 0);
  assert.equal(connection.invalidations.size, 0);
  remove();
});
