import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startWishWebUiServer } from "../dist/apps/webui/server.js";
import { WebToolApprovalBroker } from "../dist/apps/webui/approval.js";
import { DirectoryBrowserModel } from "../dist/workspace/consumers/webui/directory-model.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { localDirectoryBrowser } from "../dist/workspace/directory-picker/local.js";

const entry = (path, name) => ({ name, path: join(path, name), hidden: name.startsWith(".") });
const listing = (path, entries = []) => ({ path, crumbs: [{ name: "/", path: "/", hidden: false }, { name: path.slice(1), path, hidden: false }], entries, truncated: false, limit: 500 });

test("directory Client Model walks Host levels, ignores stale replies and never creates Sessions", async () => {
  const parent = listing("/work", [entry("/work", "alpha"), entry("/work", ".hidden")]);
  const alpha = listing("/work/alpha", [entry("/work/alpha", "src")]);
  const src = listing("/work/alpha/src");
  const requests = [];
  const connection = { request: async (path, body) => {
    requests.push({ path, body });
    return { listing: body.path === "/work/alpha" ? alpha : body.path === "/work/alpha/src" ? src : parent };
  } };
  const browser = new DirectoryBrowserModel(connection);
  await browser.open("/work");
  assert.equal(browser.getSnapshot().listing.path, "/work");
  assert.equal(browser.getSnapshot().showHidden, false);
  browser.toggleHidden();
  assert.equal(browser.getSnapshot().showHidden, true);
  await browser.select(parent.entries[0]);
  assert.equal(browser.getSnapshot().selected, "/work/alpha");
  assert.equal(browser.getSnapshot().child.path, "/work/alpha");
  assert.equal(browser.pickedPath(), "/work/alpha");
  await browser.select(alpha.entries[0], true);
  assert.equal(browser.getSnapshot().listing.path, "/work/alpha");
  assert.equal(browser.pickedPath(), "/work/alpha/src");
  browser.dismiss();
  assert.equal(browser.getSnapshot().open, false);
  assert.equal(requests.every(item => item.path === "/api/workspace/directories"), true);
  browser.close();
});

test("superseded directory responses cannot reopen or replace the current level", async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const connection = { request: async (_path, body) => body.path === "/slow" ? delayed : { listing: listing("/fast") } };
  const browser = new DirectoryBrowserModel(connection);
  const slow = browser.open("/slow");
  await browser.navigate("/fast");
  release({ listing: listing("/slow") });
  await slow;
  assert.equal(browser.getSnapshot().listing.path, "/fast");
  browser.dismiss();
  await browser.open("/fast");
  assert.equal(browser.getSnapshot().listing.path, "/fast");
  browser.close();
});

test("directory API is POST-only, lists Host directories and rejects bad paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-directory-api-"));
  let server;
  try {
    await mkdir(join(root, "project"));
    server = await startWishWebUiServer({ application: {}, approvals: new WebToolApprovalBroker(), workspaceRoot: root, directoryBrowser: localDirectoryBrowser, port: 0 });
    const request = (body, method = "POST") => fetch(`${server.url}/api/workspace/directories`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
    const good = await request({ path: root });
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).listing.entries.map(item => item.name), ["project"]);
    assert.equal((await (await request({})).json()).listing.path, homedir(), "empty browse starts at Host home, not the configured workspace");
    assert.equal((await request({}, "GET")).status, 404);
    const invalid = await request({ path: "relative" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "directory_invalid_path");
    const unknown = await request({ path: join(root, "missing") });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, "directory_unreadable");
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test("product Root requires its management token before listing Host directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-directory-token-"));
  let booted;
  try {
    await mkdir(join(root, "project"));
    booted = await bootstrap({ surface: "webui", cwd: root, homeDirectory: root,
      environment: { WISH_DATA_DIR: join(root, "data"), WISH_WEBUI_WORKSPACE_ROOT: root },
      management: managedWebUi({ directory: join(root, "management"), port: 0 }) });
    const url = booted.context.get("webManagementHost").url;
    const browse = token => fetch(`${url}/api/workspace/directories`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Wish-Management-Token": token } : {}) }, body: JSON.stringify({ path: root }) });
    assert.equal((await browse()).status, 403);
    const { token } = await (await fetch(`${url}/api/management/bootstrap`)).json();
    const response = await browse(token);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).listing.path, root);
  } finally { await booted?.dispose(); await rm(root, { recursive: true, force: true }); }
});
