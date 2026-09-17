import type {
  StorageBackendRequirement,
  StorageBackendResolver,
} from "./backend.js";
import { StorageCorruptionError } from "./errors.js";
import type {
  KvDeleteResult,
  KvPrecondition,
  KvStorageBackend,
} from "./kv.js";

export type DomainShape = "global" | "keyed";

export type DomainDefault<Value> =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: Value };

export interface ResolvedDomainSpec<Value> {
  /** Required only for keyed domains. Global domains use one reserved logical key. */
  readonly key?: string;
  readonly default: DomainDefault<Value>;
}

/** Domain-owned codec, validation, migration, defaults, and Backend requirements. */
export interface DomainSpec<Request, Value> {
  readonly id: string;
  readonly schemaVersion: number;
  readonly shape: DomainShape;
  readonly requirements: StorageBackendRequirement;

  resolve(request: Request): ResolvedDomainSpec<Value>;
  encode(value: Value): Uint8Array;
  decode(payload: Uint8Array, schemaVersion: number): unknown;
  validate(value: unknown): Value;
  migrate?(input: {
    readonly value: unknown;
    readonly fromVersion: number;
    readonly toVersion: number;
  }): unknown;
}

export interface DomainReadResult<Value> {
  readonly value: Value;
  readonly persisted: boolean;
  readonly revision?: string;
}

export interface DomainCommitEvent {
  readonly type: "storage.domain.committed";
  readonly backendId: string;
  readonly domainId: string;
  readonly key: string;
  readonly operation: "put" | "delete";
  readonly revision?: string;
}

export interface DomainEventPublisher {
  publish(event: DomainCommitEvent): void;
}

export interface StorageDomainOptions<Request, Value> {
  readonly storage: StorageBackendResolver;
  readonly backendId: string;
  readonly spec: DomainSpec<Request, Value>;
  readonly events?: DomainEventPublisher;
  readonly onEventError?: (error: unknown, event: DomainCommitEvent) => void;
}

export interface ResolvedStorageDomain<Value> {
  readonly backendId: string;
  readonly domainId: string;
  readonly key: string;

  load(signal?: AbortSignal): Promise<DomainReadResult<Value> | undefined>;
  save(
    value: Value,
    precondition: KvPrecondition,
    signal?: AbortSignal,
  ): Promise<DomainReadResult<Value>>;
  delete(
    precondition: KvPrecondition,
    signal?: AbortSignal,
  ): Promise<KvDeleteResult>;
}

interface StoredDomainEnvelope {
  readonly schemaVersion: 1;
  readonly type: "wish_storage_domain";
  readonly domainId: string;
  readonly domainSchemaVersion: number;
  readonly payloadBase64: string;
}

const GLOBAL_DOMAIN_KEY = "global";
const DOMAIN_WRITE_TAILS = new WeakMap<
  KvStorageBackend,
  Map<string, Promise<void>>
>();

/** Provider-neutral Domain Form backed by one required KV facet. */
export class StorageDomain<Request, Value> {
  readonly backendId: string;
  readonly spec: DomainSpec<Request, Value>;

  private readonly kv: KvStorageBackend;
  private readonly events: DomainEventPublisher | undefined;
  private readonly onEventError: (
    error: unknown,
    event: DomainCommitEvent,
  ) => void;
  private readonly tails: Map<string, Promise<void>>;
  private readonly cache = new Map<string, DomainReadResult<Value>>();

  constructor(options: StorageDomainOptions<Request, Value>) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("Storage Domain options must be an object");
    }
    this.spec = validateDomainSpec(options.spec);
    this.backendId = options.backendId;
    const backend = options.storage.backend(
      options.backendId,
      mergeKvRequirement(this.spec.requirements),
    );
    if (backend.kv === undefined) {
      throw new Error("Storage Backend requirement validation lost the KV facet");
    }
    this.kv = backend.kv;
    this.tails = domainWriteTails(this.kv);
    this.events = options.events;
    this.onEventError = options.onEventError ?? (() => undefined);
  }

  /** Resolve defaults and logical identity before any IO is attempted. */
  resolve(request: Request): ResolvedStorageDomain<Value> {
    const resolved = validateResolution(this.spec, this.spec.resolve(request));
    const key = this.spec.shape === "global" ? GLOBAL_DOMAIN_KEY : resolved.key!;
    const defaultValue = resolved.default.kind === "absent"
      ? resolved.default
      : Object.freeze({
        kind: "value" as const,
        value: this.spec.validate(resolved.default.value),
      });
    const domain = this;
    return Object.freeze({
      backendId: this.backendId,
      domainId: this.spec.id,
      key,
      load(signal?: AbortSignal) {
        return domain.load(key, defaultValue, signal);
      },
      save(value: Value, precondition: KvPrecondition, signal?: AbortSignal) {
        return domain.save(key, value, precondition, signal);
      },
      delete(precondition: KvPrecondition, signal?: AbortSignal) {
        return domain.delete(key, precondition, signal);
      },
    });
  }

  private async load(
    key: string,
    defaultValue: DomainDefault<Value>,
    signal: AbortSignal | undefined,
  ): Promise<DomainReadResult<Value> | undefined> {
    const stored = await this.kv.get({
      namespace: this.spec.id,
      key,
      ...(signal === undefined ? {} : { signal }),
    });
    if (stored === undefined) {
      if (defaultValue.kind === "absent") return undefined;
      const fallback = Object.freeze({
        value: defaultValue.value,
        persisted: false,
      });
      this.cache.set(key, fallback);
      return fallback;
    }
    const value = this.decode(stored.value, key);
    const result = Object.freeze({
      value,
      persisted: true,
      revision: stored.revision,
    });
    this.cache.set(key, result);
    return result;
  }

  private save(
    key: string,
    value: Value,
    precondition: KvPrecondition,
    signal: AbortSignal | undefined,
  ): Promise<DomainReadResult<Value>> {
    const stable = this.spec.validate(value);
    const bytes = this.encode(stable);
    return this.serial(key, async () => {
      const written = await this.kv.put({
        namespace: this.spec.id,
        key,
        value: bytes,
        precondition,
        ...(signal === undefined ? {} : { signal }),
      });
      const result = Object.freeze({
        value: stable,
        persisted: true,
        revision: written.revision,
      });
      this.cache.set(key, result);
      this.publish(Object.freeze({
        type: "storage.domain.committed" as const,
        backendId: this.backendId,
        domainId: this.spec.id,
        key,
        operation: "put" as const,
        revision: written.revision,
      }));
      return result;
    });
  }

  private delete(
    key: string,
    precondition: KvPrecondition,
    signal: AbortSignal | undefined,
  ): Promise<KvDeleteResult> {
    return this.serial(key, async () => {
      const deleted = await this.kv.delete({
        namespace: this.spec.id,
        key,
        precondition,
        ...(signal === undefined ? {} : { signal }),
      });
      if (deleted.deleted) {
        this.cache.delete(key);
        this.publish(Object.freeze({
          type: "storage.domain.committed" as const,
          backendId: this.backendId,
          domainId: this.spec.id,
          key,
          operation: "delete" as const,
        }));
      }
      return deleted;
    });
  }

  private encode(value: Value): Uint8Array {
    const payload = this.spec.encode(value);
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError(`Storage Domain "${this.spec.id}" codec must return bytes`);
    }
    const envelope: StoredDomainEnvelope = Object.freeze({
      schemaVersion: 1,
      type: "wish_storage_domain",
      domainId: this.spec.id,
      domainSchemaVersion: this.spec.schemaVersion,
      payloadBase64: Buffer.from(payload).toString("base64"),
    });
    return new TextEncoder().encode(JSON.stringify(envelope));
  }

  private decode(bytes: Uint8Array, key: string): Value {
    const context = {
      backendId: this.backendId,
      facet: "kv" as const,
      namespace: this.spec.id,
      key,
    };
    let parsed: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new StorageCorruptionError(
        `Storage Domain "${this.spec.id}" envelope is invalid`,
        context,
        { cause: error },
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StorageCorruptionError(
        `Storage Domain "${this.spec.id}" envelope must be an object`,
        context,
      );
    }
    const envelope = parsed as Record<string, unknown>;
    if (
      envelope.schemaVersion !== 1 || envelope.type !== "wish_storage_domain" ||
      envelope.domainId !== this.spec.id ||
      !Number.isSafeInteger(envelope.domainSchemaVersion) ||
      (envelope.domainSchemaVersion as number) < 1 ||
      typeof envelope.payloadBase64 !== "string"
    ) {
      throw new StorageCorruptionError(
        `Storage Domain "${this.spec.id}" envelope schema is invalid`,
        context,
      );
    }
    const storedVersion = envelope.domainSchemaVersion as number;
    if (storedVersion > this.spec.schemaVersion) {
      throw new StorageCorruptionError(
        `Storage Domain "${this.spec.id}" schemaVersion is newer than supported`,
        context,
      );
    }
    let payload: Uint8Array;
    try {
      payload = decodeBase64(envelope.payloadBase64);
    } catch (error: unknown) {
      throw new StorageCorruptionError(
        `Storage Domain "${this.spec.id}" payload is invalid base64`,
        context,
        { cause: error },
      );
    }
    try {
      let value = this.spec.decode(payload, storedVersion);
      if (storedVersion !== this.spec.schemaVersion) {
        if (this.spec.migrate === undefined) {
          throw new Error("no migration is defined");
        }
        value = this.spec.migrate({
          value,
          fromVersion: storedVersion,
          toVersion: this.spec.schemaVersion,
        });
      }
      return this.spec.validate(value);
    } catch (error: unknown) {
      if (error instanceof StorageCorruptionError) throw error;
      throw new StorageCorruptionError(
        `Storage Domain "${this.spec.id}" payload is corrupted`,
        context,
        { cause: error },
      );
    }
  }

  private serial<T>(_key: string, operation: () => Promise<T>): Promise<T> {
    const identity = this.spec.id;
    const previous = this.tails.get(identity) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(identity, settled);
    void settled.then(() => {
      if (this.tails.get(identity) === settled) this.tails.delete(identity);
    });
    return result;
  }

  private publish(event: DomainCommitEvent): void {
    if (this.events === undefined) return;
    try {
      this.events.publish(event);
    } catch (error: unknown) {
      try {
        this.onEventError(error, event);
      } catch {
        // Observation failures cannot turn an already durable commit into failure.
      }
    }
  }
}

function domainWriteTails(
  kv: KvStorageBackend,
): Map<string, Promise<void>> {
  let tails = DOMAIN_WRITE_TAILS.get(kv);
  if (tails === undefined) {
    tails = new Map();
    DOMAIN_WRITE_TAILS.set(kv, tails);
  }
  return tails;
}

function validateDomainSpec<Request, Value>(
  spec: DomainSpec<Request, Value>,
): DomainSpec<Request, Value> {
  if (spec === null || typeof spec !== "object") {
    throw new TypeError("Storage Domain spec must be an object");
  }
  if (
    typeof spec.id !== "string" || spec.id.length === 0 ||
    spec.id !== spec.id.trim()
  ) throw new TypeError("Storage Domain id must be non-empty trimmed text");
  if (!Number.isSafeInteger(spec.schemaVersion) || spec.schemaVersion < 1) {
    throw new TypeError("Storage Domain schemaVersion must be a positive integer");
  }
  if (spec.shape !== "global" && spec.shape !== "keyed") {
    throw new TypeError("Storage Domain shape is invalid");
  }
  if (
    typeof spec.resolve !== "function" || typeof spec.encode !== "function" ||
    typeof spec.decode !== "function" || typeof spec.validate !== "function"
  ) throw new TypeError("Storage Domain spec is incomplete");
  return spec;
}

function validateResolution<Request, Value>(
  spec: DomainSpec<Request, Value>,
  resolved: ResolvedDomainSpec<Value>,
): ResolvedDomainSpec<Value> {
  if (resolved === null || typeof resolved !== "object") {
    throw new TypeError(`Storage Domain "${spec.id}" resolve() must return a spec`);
  }
  if (
    resolved.default === null || typeof resolved.default !== "object" ||
    (resolved.default.kind !== "absent" && resolved.default.kind !== "value")
  ) throw new TypeError(`Storage Domain "${spec.id}" default is invalid`);
  if (spec.shape === "global") {
    if (resolved.key !== undefined) {
      throw new TypeError(`Global Storage Domain "${spec.id}" cannot resolve a key`);
    }
  } else if (typeof resolved.key !== "string" || resolved.key.length === 0) {
    throw new TypeError(`Keyed Storage Domain "${spec.id}" must resolve a key`);
  }
  return resolved;
}

function mergeKvRequirement(
  requirement: StorageBackendRequirement,
): StorageBackendRequirement {
  return Object.freeze({
    ...requirement,
    kv: Object.freeze({
      ...(requirement.kv ?? {}),
    }),
  });
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) throw new Error("invalid base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("invalid base64");
  return Uint8Array.from(decoded);
}

export const DOMAIN_ABSENT: DomainDefault<never> = Object.freeze({
  kind: "absent",
});
