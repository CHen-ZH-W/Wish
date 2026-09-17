import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, parse, resolve, sep } from "node:path";
import { MAX_SUBAGENT_RESOURCE_BYTES } from "./resources.js";

const ENVELOPE_LIMIT = MAX_SUBAGENT_RESOURCE_BYTES + 32_000;

/** File IO for fixed Host-derived resource addresses, never arbitrary model paths. */
export async function readResourceFile(path: string, signal?: AbortSignal): Promise<unknown | undefined> {
  signal?.throwIfAborted();
  try { await checkDirectory(dirname(path), false); } catch (error) { if (nodeError(error, "ENOENT")) return undefined; throw error; }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > ENVELOPE_LIMIT) throw new Error("Invalid or oversized Subagent resource file");
    const buffer = Buffer.alloc(ENVELOPE_LIMIT + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > ENVELOPE_LIMIT) throw new Error("Subagent resource file exceeds byte limit");
    signal?.throwIfAborted();
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } catch (error) { if (nodeError(error, "ENOENT")) return undefined; throw error; }
  finally { await handle?.close(); }
}

export async function writeResourceFile(path: string, value: unknown, replace: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > ENVELOPE_LIMIT) throw new Error("Subagent resource file exceeds byte limit");
  await checkDirectory(dirname(path), true);
  const target = replace ? `${path}.tmp-${randomUUID()}` : path;
  let created = false;
  try {
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    if (replace) {
      await checkDirectory(dirname(path), false);
      try { const prior = await lstat(path); if (!prior.isFile() || prior.isSymbolicLink()) throw new Error("Subagent resource target is not a regular file"); }
      catch (error) { if (!nodeError(error, "ENOENT")) throw error; }
      await rename(target, path);
    }
  } catch (error) {
    if (created) await unlink(target).catch(() => undefined);
    throw error;
  }
}

export async function removeResourceFile(path: string): Promise<void> {
  try { await checkDirectory(dirname(path), false); await unlink(path); }
  catch (error) { if (!nodeError(error, "ENOENT")) throw error; }
}

async function checkDirectory(path: string, create: boolean): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (!nodeError(error, "EEXIST")) throw error; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Subagent resource directory must not traverse symbolic links");
  }
}

function nodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
