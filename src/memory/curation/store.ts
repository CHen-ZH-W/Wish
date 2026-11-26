import { StorageDomain, type DomainSpec } from "../../storage/domain.js";
import { KV_ABSENT } from "../../storage/kv.js";
import type { StorageBackendResolver } from "../../storage/backend.js";
import type { CurationState, CurationStore } from "./types.js";
import { snapshotCurationState } from "./validation.js";
import { withMemoryLock } from "../file-lock.js";

export class CurationStateConflictError extends Error { constructor() { super("Curation state conflict"); } }

const domain: DomainSpec<string, CurationState> = {
  id: "memory/curation", schemaVersion: 1, shape: "keyed", requirements: { kv: { list: false } },
  resolve: libraryId => ({ key: libraryId, default: { kind: "value", value: { schemaVersion: 1, libraryId, revision: 0, jobs: [] } } }),
  encode: value => new TextEncoder().encode(JSON.stringify(snapshotCurationState(value))),
  decode: value => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)), validate: snapshotCurationState,
};
export class DomainCurationStore implements CurationStore {
  private readonly domain: StorageDomain<string, CurationState>;
  constructor(storage: StorageBackendResolver, backendId: string, private readonly libraryId: string, private readonly lockDirectory?: string) {
    this.domain = new StorageDomain({ storage, backendId, spec: domain });
  }
  async read(signal?: AbortSignal) { const state = (await this.domain.resolve(this.libraryId).load(signal))!.value;
    if (state.libraryId !== this.libraryId) throw new Error("Curation library identity mismatch"); return state; }
  async commit(value: CurationState, expectedRevision: number, signal?: AbortSignal) {
    if (this.lockDirectory) return withMemoryLock(this.lockDirectory, "curation-state", () => this.save(value, expectedRevision, signal), signal);
    return this.save(value, expectedRevision, signal);
  }
  private async save(value: CurationState, expectedRevision: number, signal?: AbortSignal) {
    const state = snapshotCurationState(value), target = this.domain.resolve(this.libraryId), current = (await target.load(signal))!;
    if (state.libraryId !== this.libraryId || state.revision !== expectedRevision + 1 || current.value.revision !== expectedRevision) throw new CurationStateConflictError();
    await target.save(state, current.persisted ? { kind: "revision", revision: current.revision! } : KV_ABSENT, signal);
  }
  async close() {}
}
