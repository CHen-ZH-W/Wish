import { resolve } from "node:path";

import type {
  StorageBackend,
  StorageBackendCapabilities,
} from "../../backend.js";
import { FileBlobStorageBackend } from "./blob.js";
import {
  FileJournalStorageBackend,
  type FileJournalTornTailRecovery,
  type FileJournalWarning,
} from "./journal.js";
import { FileKvStorageBackend } from "./kv.js";

export interface FileStorageBackendOptions {
  readonly id?: string;
  readonly rootDirectory: string;
  readonly revision?: () => string;
  readonly temporaryId?: () => string;
  readonly journalRevision?: (lastCursor: number) => string;
  readonly journalTornTailRecovery?: FileJournalTornTailRecovery;
  readonly onJournalWarning?: (warning: FileJournalWarning) => void;
}

/** File Backend exposes process-local KV, immutable Blob, and fsynced Journal. */
export class FileStorageBackend implements StorageBackend {
  readonly id: string;
  readonly rootDirectory: string;
  readonly capabilities: StorageBackendCapabilities;
  readonly kv: FileKvStorageBackend;
  readonly blob: FileBlobStorageBackend;
  readonly journal: FileJournalStorageBackend;
  private closed = false;

  constructor(options: FileStorageBackendOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("File Storage Backend options must be an object");
    }
    this.id = requireBackendId(options.id ?? "file");
    if (
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.length === 0 ||
      options.rootDirectory !== options.rootDirectory.trim()
    ) throw new TypeError("File Storage Backend requires a rootDirectory");
    this.rootDirectory = resolve(options.rootDirectory);
    this.capabilities = Object.freeze({
      writerConcurrency: "process-local" as const,
      kv: Object.freeze({ list: true }),
      blob: Object.freeze({ contentAddressed: true as const }),
      journal: Object.freeze({
        atomicBatch: true as const,
        durability: "fsync" as const,
      }),
    });
    this.kv = new FileKvStorageBackend({
      backendId: this.id,
      rootDirectory: this.rootDirectory,
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      ...(options.temporaryId === undefined
        ? {}
        : { temporaryId: options.temporaryId }),
    });
    this.blob = new FileBlobStorageBackend({
      backendId: this.id,
      rootDirectory: this.rootDirectory,
      ...(options.temporaryId === undefined
        ? {}
        : { temporaryId: options.temporaryId }),
    });
    this.journal = new FileJournalStorageBackend({
      backendId: this.id,
      rootDirectory: this.rootDirectory,
      ...(options.journalRevision === undefined
        ? {}
        : { revision: options.journalRevision }),
      ...(options.journalTornTailRecovery === undefined
        ? {}
        : { tornTailRecovery: options.journalTornTailRecovery }),
      ...(options.onJournalWarning === undefined
        ? {}
        : { onWarning: options.onJournalWarning }),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      this.kv.close(),
      this.blob.close(),
      this.journal.close(),
    ]);
  }
}

function requireBackendId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw new TypeError("File Storage Backend id must be a valid identifier");
  return value;
}

export default FileStorageBackend;
