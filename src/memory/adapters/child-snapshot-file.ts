import { mkdir, readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileSubagentExchange } from "../../subagents/files.js";
import { snapshotResourceManifest, type SubagentResource, type SubagentResourceManifest } from "../../subagents/resources.js";
import type { SubagentLaunchIdentity } from "../../subagents/types.js";
import { childMemoryInput, validateChildMemoryInput, MEMORY_SNAPSHOT_RESOURCE, type ChildMemoryInput } from "../child-resources.js";
import { hash } from "../validation.js";

/** The manifest pins a full snapshot on disk, rather than truncating it to fit an inline resource. */
export async function writeChildMemorySnapshot(exchange: FileSubagentExchange, identity: SubagentLaunchIdentity, value: ChildMemoryInput, signal?: AbortSignal): Promise<SubagentResource> {
  signal?.throwIfAborted();
  const input = validateChildMemoryInput(value), digest = hash(input);
  const root = exchange.childDataDirectory(identity.id);
  await mkdir(root, { recursive: true });
  const path = await snapshotPath(exchange, identity.id, digest);
  try { await writeFile(path, JSON.stringify(input), { flag: "wx", mode: 0o600, ...(signal ? { signal } : {}) }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(JSON.parse(await readFile(path, "utf8"))) !== digest) throw error; }
  signal?.throwIfAborted();
  return { type: MEMORY_SNAPSHOT_RESOURCE, schemaVersion: 2, payload: { digest } };
}

export async function readChildMemorySnapshot(exchange: FileSubagentExchange, raw: SubagentResourceManifest, signal?: AbortSignal): Promise<ChildMemoryInput> {
  signal?.throwIfAborted();
  const manifest = snapshotResourceManifest(raw);
  const resource = manifest.resources.find(item => item.type === MEMORY_SNAPSHOT_RESOURCE);
  if (resource?.schemaVersion !== 2) return childMemoryInput(manifest);
  const digest = (resource.payload as { digest?: unknown })?.digest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid child Memory file digest");
  const value: unknown = JSON.parse(await readFile(await snapshotPath(exchange, manifest.identity.id, digest), { encoding: "utf8", ...(signal ? { signal } : {}) }));
  signal?.throwIfAborted();
  if (hash(value) !== digest) throw new Error("Child Memory snapshot digest mismatch");
  const input = validateChildMemoryInput(value);
  if (input.allowProposals) throw new Error("File-backed child Memory is read-only");
  return input;
}

async function snapshotPath(exchange: FileSubagentExchange, id: string, digest: string): Promise<string> {
  const root = exchange.childDataDirectory(id), path = join(root, `memory-snapshot-${digest}.json`);
  for (const part of [root, path]) try {
    if ((await lstat(part)).isSymbolicLink()) throw new Error("Child Memory snapshot symlink is not allowed");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path;
}
