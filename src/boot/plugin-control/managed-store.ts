import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ManagedPluginState } from "./managed-types.js";

export class ManagedPluginStoreError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Dedicated process control persistence: never leases the business Storage subtree. */
export class ManagedPluginStore {
  private state: ManagedPluginState;
  private closed = false;
  private writing = false;
  private uncertain = false;
  private constructor(readonly filename: string, private readonly lock: string, private readonly nonce: string, state: ManagedPluginState) { this.state = state; }

  static async open(filename: string): Promise<ManagedPluginStore> {
    filename = resolve(filename);
    await mkdir(dirname(filename), { recursive: true });
    const lock = `${filename}.lock`, nonce = randomUUID();
    // A crash leaves an explicit operator-visible lock; never guess from PID reuse.
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch { throw new ManagedPluginStoreError("management_store_locked"); }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await handle.sync();
      let state: ManagedPluginState;
      try { state = parseState(await readFile(filename, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = freeze({ schemaVersion: 1, revision: "initial", preferences: {}, pending: null, receipts: [] });
      }
      return new ManagedPluginStore(filename, lock, nonce, state);
    } catch (error) { await unlink(lock); throw error; }
    finally { await handle.close(); }
  }

  snapshot(): ManagedPluginState { return this.state; }

  async commit(expectedRevision: string, update: Omit<ManagedPluginState, "schemaVersion" | "revision">): Promise<ManagedPluginState> {
    if (this.closed || this.uncertain) throw new ManagedPluginStoreError("management_store_closed");
    if (this.writing || expectedRevision !== this.state.revision) throw new ManagedPluginStoreError("management_revision_conflict");
    this.writing = true;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      if (JSON.parse(await readFile(this.lock, "utf8")).nonce !== this.nonce) throw new ManagedPluginStoreError("management_store_locked");
      let disk: ManagedPluginState | undefined;
      try { disk = parseState(await readFile(this.filename, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((disk?.revision ?? "initial") !== expectedRevision) throw new ManagedPluginStoreError("management_revision_conflict");
      const next = parseState(JSON.stringify({ ...update, schemaVersion: 1, revision: randomUUID() }));
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.filename); renamed = true;
      const directory = await open(dirname(this.filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.state = next;
      return next;
    } catch (error) {
      if (renamed) this.uncertain = true;
      if (error instanceof ManagedPluginStoreError) throw error;
      throw new ManagedPluginStoreError(renamed ? "management_save_uncertain" : "management_save_failed");
    } finally {
      await unlink(temporary).catch(() => {});
      this.writing = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.writing) throw new ManagedPluginStoreError("management_store_busy");
    this.closed = true;
    if (JSON.parse(await readFile(this.lock, "utf8")).nonce !== this.nonce) throw new ManagedPluginStoreError("management_store_locked");
    await unlink(this.lock);
  }
}

export function managementFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseState(text: string): ManagedPluginState {
  try {
    if (Buffer.byteLength(text) > 1_048_576) throw new Error();
    const state = JSON.parse(text);
    if (state?.schemaVersion !== 1 || !id(state.revision) || !state.preferences || typeof state.preferences !== "object" ||
      Array.isArray(state.preferences) || Object.keys(state.preferences).length > 512 || !Array.isArray(state.receipts) || state.receipts.length > 100 ||
      Object.keys(state).some(key => !["schemaVersion", "revision", "preferences", "pending", "receipts"].includes(key))) throw new Error();
    for (const [key, preference] of Object.entries(state.preferences) as [string, { name: unknown; preference: unknown }][]) {
      if (!id(key) || !preference || !id(preference.name) || !["enabled", "disabled"].includes(String(preference.preference)) ||
        Object.keys(preference).some(key => !["name", "preference"].includes(key))) throw new Error();
    }
    if (state.pending !== null) {
      const pending = state.pending;
      if (!pending || !id(pending.requestId) || !id(pending.revision) || !["enabled", "disabled", "inherit"].includes(pending.preference) ||
        !id(pending.selection?.instanceId) || !Array.isArray(pending.selection?.entryIds) || !pending.selection.entryIds.length ||
        pending.selection.entryIds.length > 512 || pending.selection.entryIds.some((entry: unknown) => !id(entry)) ||
        new Set(pending.selection.entryIds).size !== pending.selection.entryIds.length ||
        Object.keys(pending).some(key => !["requestId", "revision", "preference", "selection"].includes(key)) ||
        Object.keys(pending.selection).some(key => !["instanceId", "entryIds"].includes(key))) throw new Error();
    }
    for (const receipt of state.receipts) {
      if (!receipt || !id(receipt.requestId) || !/^[a-f0-9]{64}$/u.test(receipt.fingerprint) ||
        !["succeeded", "rejected", "failed"].includes(receipt.status) || !/^[a-z][a-z0-9_]{0,79}$/u.test(receipt.code) ||
        Object.keys(receipt).some(key => !["requestId", "fingerprint", "status", "code", "operationId"].includes(key)) ||
        (receipt.operationId !== undefined && !id(receipt.operationId))) throw new Error();
    }
    return freeze(state);
  } catch { throw new ManagedPluginStoreError("management_store_corrupt"); }
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f]/u.test(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
