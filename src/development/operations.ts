import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import { digest, freezeJson, requireDevelopment } from "./validation.js";

export interface DevelopmentOperation {
  readonly id: string; readonly fingerprint: string; readonly sessionId: string;
  readonly status: "pending" | "completed" | "failed"; readonly projectId?: string; readonly runId?: string;
  readonly errorCode?: string; readonly errorMessage?: string;
}
export interface DevelopmentOperations {
  get(id: string): Promise<DevelopmentOperation | undefined>;
  create(operation: DevelopmentOperation): Promise<void>;
  finish(id: string, result: Pick<DevelopmentOperation, "status" | "projectId" | "runId" | "errorCode" | "errorMessage">): Promise<void>;
}
function validate(value: unknown): DevelopmentOperation {
  const item = value as DevelopmentOperation;
  requireDevelopment(item && typeof item.id === "string" && typeof item.sessionId === "string" && /^[a-f0-9]{64}$/u.test(item.fingerprint) && ["pending", "completed", "failed"].includes(item.status), "development_invalid_operation");
  return freezeJson(item);
}
export class MemoryDevelopmentOperations implements DevelopmentOperations {
  private readonly records = new Map<string, DevelopmentOperation>();
  async get(id: string) { return this.records.get(id); }
  async create(operation: DevelopmentOperation) { requireDevelopment(!this.records.has(operation.id), "development_operation_conflict"); this.records.set(operation.id, validate(operation)); }
  async finish(id: string, result: Parameters<DevelopmentOperations["finish"]>[1]) { const current = this.records.get(id); requireDevelopment(current?.status === "pending", "development_operation_conflict"); this.records.set(id, validate({ ...current, ...result })); }
}
/** Durable intent is written before a product action can dispatch a Run. A
 * pending record after a crash requires reconciliation, never blind replay. */
export class DomainDevelopmentOperations implements DevelopmentOperations {
  private readonly domain: StorageDomain<string, DevelopmentOperation>;
  constructor(storage: StorageBackendResolver, backendId: string) {
    const spec: DomainSpec<string, DevelopmentOperation> = { id: "development/operations", schemaVersion: 1, shape: "keyed", requirements: { kv: { list: false } },
      resolve: key => ({ key, default: DOMAIN_ABSENT }), encode: item => new TextEncoder().encode(JSON.stringify(validate(item))),
      decode: bytes => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), validate };
    this.domain = new StorageDomain({ storage, backendId, spec });
  }
  async get(id: string) { return (await this.domain.resolve(id).load())?.value; }
  async create(operation: DevelopmentOperation) { await this.domain.resolve(operation.id).save(validate(operation), { kind: "absent" }); }
  async finish(id: string, result: Parameters<DevelopmentOperations["finish"]>[1]) {
    const target = this.domain.resolve(id), current = await target.load();
    requireDevelopment(current?.value.status === "pending", "development_operation_conflict");
    await target.save(validate({ ...current.value, ...result }), { kind: "revision", revision: current.revision! });
  }
}
export function operationIdentity(sessionId: string, body: Readonly<Record<string, unknown>>) {
  return { id: digest({ sessionId, requestId: body.requestId }), fingerprint: digest({ sessionId, body }) };
}
