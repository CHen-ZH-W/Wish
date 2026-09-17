import type { Context } from "@deepseek-ai/cordis";

import {
  type BlobReference,
  type DomainSpec,
  type Journal,
  type KvReadResult,
  type KvStorageBackend,
  StorageDomain,
  type StorageBackend,
  type StorageBackendLease,
  type StorageBackendRegistration,
  StorageHub,
} from "../src/storage/index.js";
import { FileStorageBackend } from "../src/storage/providers/file/backend.js";

declare const ctx: Context;

const hub: StorageHub = ctx.storage;
const file: StorageBackend = new FileStorageBackend({
  id: "file",
  rootDirectory: ".wish/storage",
});
const registration: StorageBackendRegistration = hub.register(file);
const lease: StorageBackendLease = hub.acquire("file", {
  journal: { atomicBatch: true, durability: "fsync" },
});
const kv: KvStorageBackend = hub.resolve("file", "kv");
const blobReference: Promise<BlobReference> = file.blob!.put({
  namespace: "tool-results",
  value: new TextEncoder().encode("complete"),
});
const journal: Journal = file.journal!.open({ namespace: "runtime" });
const journalCommit = journal.append({
  idempotencyKey: "run-1:prepared",
  entries: [new TextEncoder().encode("prepared")],
}, { kind: "any" });
const read: Promise<KvReadResult | undefined> = kv.get({
  namespace: "models/catalog",
  key: "global",
});
interface FixtureValue {
  readonly label: string;
}

const fixtureSpec: DomainSpec<{ readonly id: string }, FixtureValue> = {
  id: "fixture/domain",
  schemaVersion: 1,
  shape: "keyed",
  requirements: { kv: { list: false } },
  resolve(request) {
    return { key: request.id, default: { kind: "absent" } };
  },
  encode(value) {
    return new TextEncoder().encode(value.label);
  },
  decode(value) {
    return { label: new TextDecoder().decode(value) };
  },
  validate(value) {
    return value as FixtureValue;
  },
};
const fixture = new StorageDomain({
  storage: hub,
  backendId: "file",
  spec: fixtureSpec,
}).resolve({ id: "one" });

void registration;
const lifecycle = registration.snapshot();
// @ts-expect-error Observations cannot change lease ownership.
lifecycle.leases = 0;
void lease.release();
void read;
void blobReference;
void journalCommit;
void fixture;
