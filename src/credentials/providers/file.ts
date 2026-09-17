import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CredentialsError, requireReference } from "../credentials.js";
import type { CredentialDocument, CredentialStore } from "../types.js";

const MAX_DOCUMENT_BYTES = 262_144;

/** Owner-only atomic JSON store. Error messages never contain secret values. */
export class FileCredentialStore implements CredentialStore {
  private closed = false;
  private writing = false;
  private uncertain = false;
  private constructor(
    readonly filename: string,
    private readonly lock: string,
    private readonly nonce: string,
    private document: CredentialDocument,
  ) {}

  static async open(filename: string): Promise<FileCredentialStore> {
    filename = resolve(filename);
    await mkdir(dirname(filename), { recursive: true });
    await assertOwnerOnly(filename);
    const lock = `${filename}.lock`, nonce = randomUUID();
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      throw new CredentialsError((error as NodeJS.ErrnoException).code === "EEXIST"
        ? "credentials_store_locked" : "credentials_store_unavailable");
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
      await handle.sync();
      return new FileCredentialStore(filename, lock, nonce, await readDocument(filename));
    } catch (error) {
      await unlink(lock).catch(() => {});
      throw error;
    } finally { await handle.close(); }
  }

  read(): CredentialDocument { return this.document; }

  async save(expectedRevision: string, values: CredentialDocument["values"]): Promise<CredentialDocument> {
    if (this.closed || this.uncertain) throw new CredentialsError("credentials_store_closed");
    if (this.writing || expectedRevision !== this.document.revision) throw new CredentialsError("credentials_revision_conflict");
    const next = credentialDocument({ version: 1, revision: randomUUID(), values });
    this.writing = true;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      if ((await readDocument(this.filename)).revision !== expectedRevision) throw new CredentialsError("credentials_revision_conflict");
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.filename);
      renamed = true;
      const directory = await open(dirname(this.filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.document = next;
      return next;
    } catch (error) {
      if (renamed) this.uncertain = true;
      if (error instanceof CredentialsError) throw error;
      throw new CredentialsError(renamed ? "credentials_save_uncertain" : "credentials_save_failed");
    } finally {
      await unlink(temporary).catch(() => {});
      this.writing = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.writing) throw new CredentialsError("credentials_store_busy");
    let lock: unknown;
    try { lock = JSON.parse(await readFile(this.lock, "utf8")); }
    catch { throw new CredentialsError("credentials_lock_changed"); }
    if (!lock || typeof lock !== "object" || (lock as { nonce?: unknown }).nonce !== this.nonce) {
      throw new CredentialsError("credentials_lock_changed");
    }
    await unlink(this.lock);
    this.closed = true;
  }
}

async function assertOwnerOnly(filename: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const info = await stat(filename);
    if ((info.mode & 0o077) !== 0) throw new CredentialsError("credentials_store_permissions");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readDocument(filename: string): Promise<CredentialDocument> {
  let text: string;
  try { text = await readFile(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return credentialDocument({ version: 1, revision: "initial", values: {} });
    }
    throw new CredentialsError("credentials_store_unavailable");
  }
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new CredentialsError("credentials_store_corrupt");
  try { return credentialDocument(JSON.parse(text)); }
  catch (error) {
    if (error instanceof CredentialsError) throw error;
    throw new CredentialsError("credentials_store_corrupt");
  }
}

function credentialDocument(input: unknown): CredentialDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CredentialsError("credentials_store_corrupt");
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.revision !== "string" || !value.revision.length || value.revision.length > 100 ||
    !value.values || typeof value.values !== "object" || Array.isArray(value.values) ||
    Object.keys(value).some(key => !["version", "revision", "values"].includes(key))) {
    throw new CredentialsError("credentials_store_corrupt");
  }
  const entries: Record<string, string> = {};
  const values = value.values as Record<string, unknown>;
  if (Object.keys(values).length > 128) throw new CredentialsError("credentials_store_corrupt");
  for (const [reference, secret] of Object.entries(values)) {
    requireReference(reference);
    if (typeof secret !== "string" || !secret.length || secret.length > 8192) throw new CredentialsError("credentials_store_corrupt");
    entries[reference] = secret;
  }
  const document = Object.freeze({ version: 1 as const, revision: value.revision, values: Object.freeze(entries) });
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES) throw new CredentialsError("credentials_store_corrupt");
  return document;
}
