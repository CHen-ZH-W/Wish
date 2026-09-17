import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SettingsDocument, SettingsStore } from "../types.js";
import { settingsDocument, SettingsError } from "../validation.js";

/** Dedicated user document, deliberately independent of application Storage leases. */
export class FileSettingsStore implements SettingsStore {
  readonly writable = true;
  private closed = false;
  private writing = false;
  private uncertain = false;
  private constructor(readonly filename: string, private readonly lock: string, private readonly nonce: string, private document: SettingsDocument) {}
  static async open(filename: string): Promise<FileSettingsStore> {
    filename = resolve(filename);
    await mkdir(dirname(filename), { recursive: true });
    const lock = `${filename}.lock`, nonce = randomUUID();
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) { throw new SettingsError((error as NodeJS.ErrnoException).code === "EEXIST" ? "settings_store_locked" : "settings_store_unavailable"); }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync();
      return new FileSettingsStore(filename, lock, nonce, await readDocument(filename));
    } catch (error) { await unlink(lock); throw error; }
    finally { await handle.close(); }
  }
  read(): SettingsDocument { return this.document; }
  async save(expectedRevision: string, sections: SettingsDocument["sections"]): Promise<SettingsDocument> {
    if (this.closed || this.uncertain) throw new SettingsError("settings_store_closed");
    if (this.writing || expectedRevision !== this.document.revision) throw new SettingsError("settings_revision_conflict");
    const next = settingsDocument({ version: 1, revision: randomUUID(), sections });
    this.writing = true;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      if ((await readDocument(this.filename)).revision !== expectedRevision) throw new SettingsError("settings_revision_conflict");
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.filename); renamed = true;
      const directory = await open(dirname(this.filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.document = next; return next;
    } catch (error) {
      if (renamed) this.uncertain = true;
      if (error instanceof SettingsError) throw error;
      throw new SettingsError(renamed ? "settings_save_uncertain" : "settings_save_failed");
    } finally { await unlink(temporary).catch(() => {}); this.writing = false; }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.writing) throw new SettingsError("settings_store_busy");
    // Never remove a replacement owner's lock.
    const lock = JSON.parse(await readFile(this.lock, "utf8"));
    if (lock.nonce !== this.nonce) throw new SettingsError("settings_lock_changed");
    await unlink(this.lock); this.closed = true;
  }
}
async function readDocument(filename: string): Promise<SettingsDocument> {
  let text: string;
  try { text = await readFile(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return settingsDocument({ version: 1, revision: "initial", sections: {} });
    throw new SettingsError("settings_store_unavailable");
  }
  try {
    if (Buffer.byteLength(text) > 262144) throw new Error();
    return settingsDocument(JSON.parse(text));
  } catch { throw new SettingsError("settings_store_corrupt"); }
}
