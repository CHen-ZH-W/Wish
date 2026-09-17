import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostDirectoryBrowseError, listHostDirectories } from "../dist/workspace/directory-picker/local.js";

test("Host directory browser lists folders, hidden folders and enterable symlinks without files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-directory-picker-"));
  try {
    const project = join(root, "project");
    await Promise.all([mkdir(project), mkdir(join(root, ".hidden")), writeFile(join(root, "secret.txt"), "must not list")]);
    await symlink(project, join(root, "project-link"));
    const listing = await listHostDirectories(root);
    assert.equal(listing.path, root);
    assert.deepEqual(listing.entries.map(entry => entry.name), [".hidden", "project", "project-link"]);
    assert.equal(listing.entries[0].hidden, true);
    assert.deepEqual(listing.crumbs.at(-1), { name: root.split("/").at(-1), path: root, hidden: false });
    assert.equal((await listHostDirectories(join(root, "project-link"))).path, project);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Host directory browser rejects relative, missing and file paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-directory-picker-invalid-"));
  try {
    await writeFile(join(root, "file"), "body");
    for (const path of ["relative", "", "\0"]) {
      await assert.rejects(listHostDirectories(path), error => error instanceof HostDirectoryBrowseError && error.code === "directory_invalid_path");
    }
    for (const path of [join(root, "missing"), join(root, "file")]) {
      await assert.rejects(listHostDirectories(path), error => error instanceof HostDirectoryBrowseError && error.code === "directory_unreadable");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Host directory browser bounds a large level and reports truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-directory-picker-bound-"));
  try {
    await Promise.all(Array.from({ length: 502 }, (_, index) => mkdir(join(root, `folder-${String(index).padStart(3, "0")}`))));
    const listing = await listHostDirectories(root);
    assert.equal(listing.entries.length, 500);
    assert.equal(listing.truncated, true);
    assert.equal(listing.entries[0].name, "folder-000");
  } finally { await rm(root, { recursive: true, force: true }); }
});
