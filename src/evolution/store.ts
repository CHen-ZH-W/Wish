import type { StorageBackendLease } from "../storage/backend.js";
import { StorageDomain, DOMAIN_ABSENT, type DomainSpec } from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { canonical, EvolutionError, validateCampaign } from "./validation.js";
import type { EvolutionCampaign, EvolutionStore } from "./types.js";

export class MemoryEvolutionStore implements EvolutionStore {
  private readonly records = new Map<string, EvolutionCampaign>();
  async read(id: string): Promise<EvolutionCampaign | undefined> { return this.records.get(id); }
  async list(): Promise<readonly EvolutionCampaign[]> { return [...this.records.values()]; }
  async create(value: EvolutionCampaign): Promise<EvolutionCampaign> {
    if (this.records.has(value.id)) throw new EvolutionError("evolution_conflict");
    const checked = validateCampaign(value); this.records.set(value.id, checked); return checked;
  }
  async compareAndSwap(id: string, expectedRevision: number, value: EvolutionCampaign): Promise<EvolutionCampaign> {
    const current = this.records.get(id); checkUpdate(id, expectedRevision, current, value);
    const checked = validateCampaign(value); this.records.set(id, checked); return checked;
  }
}
/** Owns the supplied lease. All records use the evolution domain's KV namespace. */
export class StorageEvolutionStore implements EvolutionStore {
  private readonly domain: StorageDomain<string, EvolutionCampaign>;
  private closed = false;
  readonly namespace = "evolution/campaigns/v1";
  constructor(private readonly lease: StorageBackendLease) {
    const spec: DomainSpec<string, EvolutionCampaign> = {
      id: this.namespace, schemaVersion: 1, shape: "keyed", requirements: { kv: { list: true } },
      resolve: key => ({ key, default: DOMAIN_ABSENT }),
      encode: value => new TextEncoder().encode(canonical(value)),
      decode: bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), validate: validateCampaign,
    };
    this.domain = new StorageDomain({ storage: lease, backendId: lease.id, spec });
  }
  private assertOpen(): void { if (this.closed) throw new EvolutionError("evolution_store_closed"); }
  async read(id: string): Promise<EvolutionCampaign | undefined> { this.assertOpen(); return (await this.domain.resolve(id).load())?.value; }
  async list(): Promise<readonly EvolutionCampaign[]> {
    this.assertOpen(); const keys = await this.lease.resolve(this.lease.id, "kv").list!({ namespace: this.namespace });
    const values = await Promise.all(keys.map(item => this.read(item.key))); return values.filter((value): value is EvolutionCampaign => value !== undefined);
  }
  async create(value: EvolutionCampaign): Promise<EvolutionCampaign> {
    this.assertOpen(); const checked = validateCampaign(value);
    try { await this.domain.resolve(value.id).save(checked, { kind: "absent" }); }
    catch (error) { if (error instanceof StorageConflictError) throw new EvolutionError("evolution_conflict"); throw error; }
    return checked;
  }
  async compareAndSwap(id: string, expectedRevision: number, value: EvolutionCampaign): Promise<EvolutionCampaign> {
    this.assertOpen(); const handle = this.domain.resolve(id), current = await handle.load();
    checkUpdate(id, expectedRevision, current?.value, value); const checked = validateCampaign(value);
    try { await handle.save(checked, { kind: "revision", revision: current!.revision! }); }
    catch (error) { if (error instanceof StorageConflictError) throw new EvolutionError("evolution_conflict"); throw error; }
    return checked;
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.lease.release(); } }
}
function checkUpdate(id: string, revision: number, current: EvolutionCampaign | undefined, value: EvolutionCampaign): void {
  if (!current) throw new EvolutionError("evolution_not_found");
  if (current.revision !== revision) throw new EvolutionError("evolution_conflict");
  if (value.id !== id || value.revision !== revision + 1 || value.requestId !== current.requestId || value.specDigest !== current.specDigest) throw new EvolutionError("evolution_invalid_update");
}
