import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import type { InteractionState, InteractionStore } from "./types.js";
import { InteractionError, state } from "./validation.js";

export const INTERACTION_DOMAIN = "interactions/sessions";
export class MemoryInteractionStore implements InteractionStore {
  private readonly values = new Map<string, InteractionState>();
  async get(id: string) { return this.values.get(id); }
  async list() { return [...this.values.values()]; }
  async put(value: InteractionState, expected: number) {
    if ((this.values.get(value.sessionId)?.revision ?? 0) !== expected || value.revision !== expected + 1) throw new InteractionError("interaction_conflict");
    this.values.set(value.sessionId, state(value));
  }
  async delete(id: string) { this.values.delete(id); }
}
export class DomainInteractionStore implements InteractionStore {
  private readonly domain: StorageDomain<string, InteractionState>;
  constructor(private readonly storage: StorageBackendResolver, private readonly backendId: string) {
    const spec: DomainSpec<string, InteractionState> = { id: INTERACTION_DOMAIN, schemaVersion: 1, shape: "keyed", requirements: { writerConcurrency: "process-local", kv: { list: true } },
      resolve: key => ({ key, default: DOMAIN_ABSENT }), encode: v => new TextEncoder().encode(JSON.stringify(v)),
      decode: bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), validate: state };
    this.domain = new StorageDomain({ storage, backendId, spec });
  }
  async get(id: string) { return (await this.domain.resolve(id).load())?.value; }
  async list() {
    const keys = await this.storage.resolve(this.backendId, "kv").list!({ namespace: INTERACTION_DOMAIN });
    const values = await Promise.all(keys.map(k => this.get(k.key)));
    return values.filter((v): v is InteractionState => v !== undefined);
  }
  async put(value: InteractionState, expected: number) {
    const target = this.domain.resolve(value.sessionId), current = await target.load();
    if ((current?.value.revision ?? 0) !== expected || value.revision !== expected + 1) throw new InteractionError("interaction_conflict");
    await target.save(state(value), current ? { kind: "revision", revision: current.revision! } : { kind: "absent" });
  }
  async delete(id: string) { await this.domain.resolve(id).delete({ kind: "any" }); }
}
