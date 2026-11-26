import { StorageDomain, type DomainSpec } from "../storage/domain.js";
import { KV_ABSENT } from "../storage/kv.js";
import type { StorageBackendResolver } from "../storage/backend.js";

interface ActivationState { readonly version: 1; readonly disabled: readonly string[] }
const spec: DomainSpec<void, ActivationState> = {
  id: "skills/activation", schemaVersion: 1, shape: "global", requirements: { kv: { list: false } },
  resolve: () => ({ default: { kind: "value", value: { version: 1, disabled: [] } } }),
  encode: value => new TextEncoder().encode(JSON.stringify(value)),
  decode: bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  validate(value) {
    const state = value as ActivationState;
    if (!state || state.version !== 1 || !Array.isArray(state.disabled) || state.disabled.length > 10000 ||
      state.disabled.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)) ||
      new Set(state.disabled).size !== state.disabled.length) throw new Error("Invalid Skills activation state");
    return Object.freeze({ version: 1, disabled: Object.freeze([...state.disabled]) });
  },
};

/** Wish preferences survive package edits, Memory consolidation and Provider replacement. */
export class SkillActivationStore {
  private readonly domain: StorageDomain<void, ActivationState>;
  constructor(storage: StorageBackendResolver, backendId: string) { this.domain = new StorageDomain({ storage, backendId, spec }); }
  async read(signal?: AbortSignal) { return (await this.domain.resolve(undefined).load(signal))!; }
  async set(packageId: string, enabled: boolean, before: Awaited<ReturnType<SkillActivationStore["read"]>>, signal?: AbortSignal) {
    const disabled = new Set(before.value.disabled);
    if (enabled) disabled.delete(packageId); else disabled.add(packageId);
    await this.domain.resolve(undefined).save({ version: 1, disabled: [...disabled].sort() },
      before.persisted ? { kind: "revision", revision: before.revision! } : KV_ABSENT, signal);
  }
}
