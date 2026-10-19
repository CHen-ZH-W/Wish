import { mkdir, open, readFile, unlink, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StorageDomain, DOMAIN_ABSENT, type DomainSpec } from "../storage/domain.js";
import { FileStorageBackend } from "../storage/providers/file/backend.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { canonical, index, snapshot, fail } from "./codec.js";
import type { PluginStateIndex, PluginStatePersistence, PluginStateSnapshot } from "./types.js";

/** Root-owned provider: reuses StorageDomain/CAS, and survives business Storage replacement. */
export class FilePluginStatePersistence implements PluginStatePersistence {
  private closing: Promise<void> | undefined;
  private constructor(private readonly backend: FileStorageBackend,
    private readonly indices: StorageDomain<string, PluginStateIndex>,
    private readonly snapshots: StorageDomain<string, PluginStateSnapshot>, private readonly unlock: () => Promise<void>) {}
  static async open(directory: string): Promise<FilePluginStatePersistence> {
    await mkdir(directory, { recursive: true });
    const lock = join(directory, "writer.lock"), nonce = randomUUID();
    let identity: string | null = null;
    try { identity = JSON.stringify([hostname(), (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), await readlink("/proc/self/ns/pid")]); } catch { /* Unknown owners cannot be stolen. */ }
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !identity) fail("plugin_state_store_locked");
      let recovery;
      try { recovery = await open(`${lock}.recover`, "wx", 0o600); } catch { fail("plugin_state_store_locked"); }
      try {
        const bytes = await readFile(lock, "utf8"), owner = JSON.parse(bytes);
        if (owner.identity !== identity || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) fail("plugin_state_store_locked");
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        if (!dead || await readFile(lock, "utf8") !== bytes) fail("plugin_state_store_locked");
        await unlink(lock); handle = await open(lock, "wx", 0o600);
      } finally { await recovery.close(); await unlink(`${lock}.recover`); }
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, identity, nonce })); await handle.sync(); }
    finally { await handle.close(); }
    const backend = new FileStorageBackend({ rootDirectory: directory, id: "plugin-private-state" });
    const resolver = { backend: () => backend } as unknown as StorageBackendResolver;
    const domain = <T>(id: string, validate: (value: unknown) => T) => new StorageDomain<string, T>({ storage: resolver, backendId: backend.id,
      spec: { id, schemaVersion: 1, shape: "keyed", requirements: { kv: {} }, resolve: key => ({ key, default: DOMAIN_ABSENT }),
        encode: value => Buffer.from(canonical(value)), decode: value => JSON.parse(Buffer.from(value).toString("utf8")), validate } as DomainSpec<string, T> });
    return new FilePluginStatePersistence(backend, domain("plugin-private-state/index/v1", index), domain("plugin-private-state/snapshots/v1", snapshot), async () => {
      if (JSON.parse(await readFile(lock, "utf8")).nonce === nonce) await unlink(lock);
    });
  }
  async readIndex() { const found = await this.indices.resolve("index").load(); return found ? { value: found.value, revision: found.revision! } : { value: { heads: {}, pending: null } }; }
  async writeIndex(value: PluginStateIndex, revision: string | undefined): Promise<string> {
    return (await this.indices.resolve("index").save(index(value), revision ? { kind: "revision", revision } : { kind: "absent" })).revision!;
  }
  async readSnapshot(hash: string): Promise<PluginStateSnapshot> {
    const found = await this.snapshots.resolve(hash).load();
    if (!found || found.value.digest !== hash) fail("plugin_state_snapshot_missing"); return found.value;
  }
  async writeSnapshot(value: PluginStateSnapshot): Promise<void> {
    const checked = snapshot(value), record = this.snapshots.resolve(checked.digest), old = await record.load();
    if (!old) await record.save(checked, { kind: "absent" });
    else if (canonical(old.value) !== canonical(checked)) fail("plugin_state_corrupt");
  }
  close(): Promise<void> { return this.closing ??= this.backend.close().then(() => this.unlock()); }
}
