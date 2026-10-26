import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceSnapshot, WorkspaceSnapshotFile } from "./types.js";
import { bytesDigest, digest, freezeJson, requireDevelopment } from "./validation.js";

/** Exclusions are part of the snapshot identity and visible to the operator. */
export const DEVELOPMENT_SNAPSHOT_EXCLUDED = Object.freeze([".git", "node_modules", ".wish", ".env", ".env.*", ".aws", ".ssh", ".codex", ".agents"]);
const excluded = (name: string): boolean => DEVELOPMENT_SNAPSHOT_EXCLUDED.includes(name) || name.startsWith(".env.");
export interface WorkspaceSnapshotOptions { readonly maxFiles?: number; readonly maxBytes?: number; readonly maxFileBytes?: number }
export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  requireDevelopment(typeof root === "string" && isAbsolute(root), "development_invalid_workspace");
  const requested = resolve(root), canonical = await realpath(requested);
  requireDevelopment(canonical === requested && (await lstat(requested)).isDirectory(), "development_workspace_symlink", "Workspace must be a canonical directory without symlink aliases");
  return canonical;
}
export async function captureWorkspaceSnapshot(workspaceRoot: string, options: WorkspaceSnapshotOptions = {}): Promise<WorkspaceSnapshot> {
  const root = await canonicalWorkspaceRoot(workspaceRoot);
  const maxFiles = options.maxFiles ?? 20_000, maxBytes = options.maxBytes ?? 128 * 1024 * 1024, maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  requireDevelopment([maxFiles, maxBytes, maxFileBytes].every(value => Number.isSafeInteger(value) && value > 0), "development_invalid_snapshot_limits");
  const files: WorkspaceSnapshotFile[] = [];
  let totalBytes = 0, entries = 0;
  const scan = async (directory: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (excluded(name)) continue;
      requireDevelopment(++entries <= maxFiles * 2, "development_snapshot_limit", "Workspace has too many entries");
      const path = join(directory, name), local = relative(root, path);
      requireDevelopment(local && !isAbsolute(local) && !local.split(sep).includes(".."), "development_snapshot_escape");
      const before = await lstat(path);
      requireDevelopment(!before.isSymbolicLink(), "development_snapshot_symlink", `Snapshot refuses symbolic link: ${local}`);
      requireDevelopment(await realpath(path) === path, "development_snapshot_escape");
      if (before.isDirectory()) { await scan(path); continue; }
      requireDevelopment(before.isFile(), "development_snapshot_special_file", `Snapshot refuses special file: ${local}`);
      requireDevelopment(files.length < maxFiles && before.size <= maxFileBytes && totalBytes + before.size <= maxBytes, "development_snapshot_limit", "Workspace snapshot exceeds its file or byte limit");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        requireDevelopment(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.mtimeMs === before.mtimeMs, "development_snapshot_changed");
        // Allocate only after the bound check, then detect growth before retaining bytes.
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); requireDevelopment(part.bytesRead > 0, "development_snapshot_changed"); offset += part.bytesRead; }
        const extra = Buffer.alloc(1), tail = await handle.read(extra, 0, 1, bytes.length), after = await handle.stat(), named = await lstat(path);
        requireDevelopment(tail.bytesRead === 0 && after.size === opened.size && after.mtimeMs === opened.mtimeMs && named.dev === opened.dev && named.ino === opened.ino && !named.isSymbolicLink() && await realpath(path) === path, "development_snapshot_changed");
        files.push({ path: local.split(sep).join("/"), bytes: bytes.length, digest: bytesDigest(bytes) }); totalBytes += bytes.length;
      } finally { await handle.close(); }
    }
    const after = (await readdir(directory)).sort().filter(name => !excluded(name));
    requireDevelopment(JSON.stringify(after) === JSON.stringify(names.filter(name => !excluded(name))), "development_snapshot_changed");
  };
  await scan(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const content = { schemaVersion: 1 as const, workspaceRoot: root, files, totalBytes, excluded: [...DEVELOPMENT_SNAPSHOT_EXCLUDED] };
  return freezeJson({ ...content, digest: digest(content) });
}
