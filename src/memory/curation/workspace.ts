import { mkdir, readdir, readFile, lstat, writeFile, rename, rm, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, memoryPath } from "../validation.js";

export type MemoryFiles = Readonly<Record<string, string>>;

/** Public Markdown workspace plus a successful-consolidation baseline. No work quotas. */
export class MemoryWorkspace {
  constructor(readonly directory: string) {}
  async files(): Promise<Record<string, string>> { return readMemoryFiles(this.directory); }
  async baseline(): Promise<Record<string, string>> {
    try {
      const path = join(this.directory, ".baseline.json");
      for (const entry of [this.directory, path]) if ((await lstat(entry)).isSymbolicLink()) throw new Error("Memory workspace symlinks are not allowed");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory workspace baseline");
      return Object.fromEntries(Object.entries(value).map(([path, body]) => {
        memoryPath(path);
        if (typeof body !== "string" || body.includes("\0")) throw new Error("Invalid memory workspace baseline");
        return [path, body];
      }));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  async inputFingerprint(): Promise<string> { return hash(changedFiles(await this.baseline(), await this.files())); }
  async scratch(files: MemoryFiles): Promise<string> {
    await mkdir(dirname(this.directory), { recursive: true });
    const directory = await mkdtemp(join(dirname(this.directory), ".memory-work-"));
    try { for (const [path, value] of Object.entries(files)) await writeMemoryFile(directory, path, value); return directory; }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async publish(files: MemoryFiles, signal: AbortSignal, before?: MemoryFiles): Promise<void> {
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const current = await this.files();
    for (const [path, value] of Object.entries(files)) {
      signal.throwIfAborted();
      if (before && current[path] !== fileContent(before, path) && current[path] !== value) continue;
      if (current[path] !== value) await writeMemoryFile(this.directory, path, value);
    }
    for (const path of Object.keys(current)) {
      signal.throwIfAborted();
      if (!Object.hasOwn(files, path) && (!before || current[path] === fileContent(before, path))) await rm(await scopedPath(this.directory, path), { force: true });
    }
    signal.throwIfAborted();
    const temporary = join(this.directory, `.baseline-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(files));
    await rename(temporary, join(this.directory, ".baseline.json"));
  }
}

/** Reject symlinks at every component, including the workspace root. */
export async function scopedPath(root: string, path: string): Promise<string> {
  const parts = memoryPath(path).split("/");
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Memory workspace symlinks are not allowed"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
export async function writeMemoryFile(root: string, path: string, value: string): Promise<void> {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Memory artifacts must be UTF-8 text");
  const target = await scopedPath(root, path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.write-${randomUUID()}`);
  try { await writeFile(temporary, value); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
export async function readMemoryFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  async function visit(directory: string, prefix: string) {
    let entries;
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("Memory workspace symlinks are not allowed");
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Memory workspace symlinks are not allowed");
      if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
      else if (entry.isFile()) files[path] = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(directory, entry.name)));
      else throw new Error("Memory workspace contains a non-regular file");
    }
  }
  await visit(root, ""); return files;
}
export function changedFiles(before: MemoryFiles, after: MemoryFiles): Readonly<Record<string, { before?: string; after?: string }>> {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => fileContent(before, path) !== fileContent(after, path))
    .map(path => [path, { ...(Object.hasOwn(before, path) ? { before: before[path] } : {}), ...(Object.hasOwn(after, path) ? { after: after[path] } : {}) }]));
}
function fileContent(files: MemoryFiles, path: string): string | undefined { return Object.hasOwn(files, path) ? files[path] : undefined; }
export function workspaceDiff(before: MemoryFiles, after: MemoryFiles): string {
  return "# Memory workspace changes since the last successful consolidation\n\n" + Object.entries(changedFiles(before, after)).map(([path, change]) =>
    `diff --memory ${path}\n--- ${change.before === undefined ? "/dev/null" : path}\n+++ ${change.after === undefined ? "/dev/null" : path}\n` +
    (change.before === undefined ? "" : change.before.split("\n").map(line => `-${line}`).join("\n") + "\n") +
    (change.after === undefined ? "" : change.after.split("\n").map(line => `+${line}`).join("\n") + "\n")).join("\n");
}
