import type { StorageBackendResolver } from "../storage/backend.js";
import { StorageDomain, DOMAIN_ABSENT, type DomainSpec } from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { canonical, digest, freezeJson, AgentProfileError } from "./validation.js";

/** One Domain per collection; immutable records and mutable records both use explicit CAS. */
export class ProfileRecordStore<T> {
  private readonly domain: StorageDomain<string, T>;
  constructor(private readonly storage: StorageBackendResolver, private readonly backendId: string, readonly namespace: string, validate: (value: unknown) => T) {
    const spec: DomainSpec<string, T> = {
      id: namespace, schemaVersion: 1, shape: "keyed", requirements: { kv: { list: true } },
      resolve: key => ({ key, default: DOMAIN_ABSENT }),
      encode: value => new TextEncoder().encode(canonical(value)),
      decode: value => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)), validate,
    };
    this.domain = new StorageDomain({ storage, backendId, spec });
  }
  async get(key: string): Promise<T | undefined> { return (await this.domain.resolve(key).load())?.value; }
  async list(): Promise<readonly T[]> {
    const keys = await this.storage.resolve(this.backendId, "kv").list!({ namespace: this.namespace });
    const values = await Promise.all(keys.map(item => this.get(item.key)));
    const result: T[] = [];
    for (const value of values) if (value !== undefined) result.push(value as T);
    return result;
  }
  async create(key: string, value: T, allowExisting = true): Promise<T> {
    const stable = freezeJson(value);
    try { await this.domain.resolve(key).save(stable, { kind: "absent" }); }
    catch (error) {
      if (!(error instanceof StorageConflictError)) throw error;
      if (!allowExisting) throw new AgentProfileError("profile_record_exists", `Record ${key} already exists`);
      const current = await this.get(key);
      if (current === undefined || digest(current) !== digest(stable)) throw new AgentProfileError("profile_immutable_conflict", `Record ${key} already has different content`);
      return current;
    }
    return stable;
  }
  async update(key: string, mutate: (value: T) => T): Promise<T> {
    const handle = this.domain.resolve(key);
    const current = await handle.load();
    if (!current) throw new AgentProfileError("profile_record_missing");
    const value = freezeJson(mutate(current.value));
    await handle.save(value, { kind: "revision", revision: current.revision! });
    return value;
  }
}
