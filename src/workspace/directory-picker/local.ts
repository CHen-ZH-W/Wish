import { opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { homedir } from "node:os";
import { HostDirectoryBrowseError, type HostDirectoryBrowser, type HostDirectoryEntry, type HostDirectoryListing } from "./types.js";

const MAX_ENTRIES = 500;

export { HostDirectoryBrowseError } from "./types.js";

function crumbs(path: string): HostDirectoryEntry[] {
  const result: HostDirectoryEntry[] = [];
  let current = path;
  for (;;) {
    const parent = dirname(current);
    result.unshift({ name: parent === current ? parse(current).root : basename(current), path: current, hidden: false });
    if (parent === current) return result;
    current = parent;
  }
}

/** Read-only Host directory picking; independent of Workspace's Step snapshot resolver. */
export async function listHostDirectories(path = homedir(), signal?: AbortSignal): Promise<HostDirectoryListing> {
  if (!path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) {
    throw new HostDirectoryBrowseError("directory_invalid_path");
  }
  signal?.throwIfAborted();
  let current: string;
  try {
    current = await realpath(path);
    if (!(await stat(current)).isDirectory()) throw new Error("not a directory");
  } catch {
    signal?.throwIfAborted();
    throw new HostDirectoryBrowseError("directory_unreadable");
  }

  // Keep a sorted bounded window, including symlinks that may point to folders.
  // The Host never serializes file names from ordinary files or file contents.
  const candidates: { name: string; directory: boolean }[] = [];
  let truncated = false;
  try {
    const directory = await opendir(current);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = { name: entry.name, directory: entry.isDirectory() };
      if (candidates.length > MAX_ENTRIES && candidate.name.localeCompare(candidates[MAX_ENTRIES]!.name) >= 0) {
        truncated = true;
        continue;
      }
      let low = 0, high = candidates.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (candidate.name.localeCompare(candidates[middle]!.name) < 0) high = middle;
        else low = middle + 1;
      }
      candidates.splice(low, 0, candidate);
      if (candidates.length > MAX_ENTRIES + 1) { candidates.pop(); truncated = true; }
    }
  } catch {
    signal?.throwIfAborted();
    throw new HostDirectoryBrowseError("directory_unreadable");
  }

  const entries: HostDirectoryEntry[] = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (!candidate.directory) {
      try { if (!(await stat(join(current, candidate.name))).isDirectory()) continue; }
      catch { continue; } // Broken or inaccessible symlink is not enterable.
    }
    if (entries.length === MAX_ENTRIES) { truncated = true; break; }
    entries.push({ name: candidate.name, path: join(current, candidate.name), hidden: candidate.name.startsWith(".") });
  }
  return { path: current, crumbs: crumbs(current), entries, truncated, limit: MAX_ENTRIES };
}

export const localDirectoryBrowser: HostDirectoryBrowser = Object.freeze({ list: listHostDirectories });
