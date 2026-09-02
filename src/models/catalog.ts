import type { ModelRef } from "../core/model/model.js";
import {
  resolveConfiguredModel,
} from "./config.js";
import type {
  ModelAvailability,
  ModelPrice,
  ModelsConfiguration,
  ProviderProfile,
} from "./types.js";

export type CatalogCapability = boolean | "unknown";
export type CatalogModelSource = "configured" | "discovered" | "both";
export type CatalogCallability = "available" | "unavailable" | "unknown";

export interface DiscoveredModel {
  readonly id: string;
  readonly name?: string;
  readonly status?: ModelAvailability;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly textInput?: boolean;
  readonly imageInput?: boolean;
  readonly reasoning?: boolean;
  readonly toolCalling?: boolean;
  readonly developerRole?: boolean;
  readonly price?: ModelPrice;
}

export interface CachedProviderCatalog {
  readonly providerId: string;
  readonly fetchedAt?: string;
  readonly checkedAt: string;
  readonly models: readonly DiscoveredModel[];
  readonly lastError?: string;
}

export interface ModelCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly providers: readonly CachedProviderCatalog[];
}

export interface ModelCatalogStore {
  load(): Promise<ModelCatalogSnapshot | undefined>;
  save(snapshot: ModelCatalogSnapshot): Promise<void>;
}

export interface CatalogProviderClient {
  readonly providerId: string;
  fetchModels(input: {
    readonly provider: ProviderProfile;
    readonly signal?: AbortSignal;
  }): Promise<readonly DiscoveredModel[]>;
  checkModel?(input: {
    readonly provider: ProviderProfile;
    readonly model: ModelRef;
    readonly signal?: AbortSignal;
  }): Promise<"available" | "unavailable">;
}

export interface CatalogModel {
  readonly ref: ModelRef;
  readonly name?: string;
  readonly status: ModelAvailability;
  readonly source: CatalogModelSource;
  readonly verification: "unverified";
  readonly callability: "unknown";
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly capabilities: {
    readonly textInput: CatalogCapability;
    readonly imageInput: CatalogCapability;
    readonly reasoning: CatalogCapability;
    readonly toolCalling: CatalogCapability;
    readonly developerRole: CatalogCapability;
  };
  readonly price?: ModelPrice;
}

export interface CatalogCheckResult {
  readonly model: ModelRef;
  readonly status: CatalogCallability;
  readonly checkedAt: string;
  readonly error?: string;
}

export interface ProviderCatalogDiff {
  readonly providerId: string;
  readonly status: "ok" | "failed";
  readonly added: readonly ModelRef[];
  readonly removed: readonly ModelRef[];
  readonly changed: readonly ModelRef[];
  readonly error?: string;
}

export interface ModelCatalogDiff {
  readonly checkedAt: string;
  readonly providers: readonly ProviderCatalogDiff[];
}

export interface ModelCatalogSyncResult {
  readonly snapshot: ModelCatalogSnapshot;
  readonly diff: ModelCatalogDiff;
}

export interface ModelCatalogOptions {
  readonly configuration: ModelsConfiguration;
  readonly store: ModelCatalogStore;
  readonly clients?: readonly CatalogProviderClient[];
  readonly now?: () => string;
}

/** Catalog is an explicit control-plane service, never a request dependency. */
export class ModelCatalog {
  private readonly clients: ReadonlyMap<string, CatalogProviderClient>;
  private readonly now: () => string;

  constructor(private readonly options: ModelCatalogOptions) {
    const clients = new Map<string, CatalogProviderClient>();
    for (const client of options.clients ?? []) {
      if (clients.has(client.providerId)) {
        throw new Error(`Catalog client for Provider "${client.providerId}" is duplicated`);
      }
      clients.set(client.providerId, client);
    }
    this.clients = clients;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(): Promise<readonly CatalogModel[]> {
    const snapshot = await this.options.store.load();
    const cached = new Map(
      (snapshot?.providers ?? []).map((provider) => [provider.providerId, provider]),
    );
    const result: CatalogModel[] = [];
    for (const provider of this.options.configuration.providers) {
      const discovered = new Map(
        (cached.get(provider.id)?.models ?? []).map((model) => [model.id, model]),
      );
      for (const configured of provider.models) {
        const found = discovered.get(configured.id);
        result.push(mergeCatalogModel(provider.id, configured, found));
        discovered.delete(configured.id);
      }
      for (const found of discovered.values()) {
        result.push(mergeCatalogModel(provider.id, undefined, found));
      }
    }
    return Object.freeze(result);
  }

  async check(
    reference: ModelRef | string,
    signal?: AbortSignal,
  ): Promise<CatalogCheckResult> {
    const resolved = resolveConfiguredModel(this.options.configuration, reference);
    const provider = this.options.configuration.providers.find(
      (item) => item.id === resolved.ref.provider,
    );
    if (provider === undefined) throw new Error("Configured Catalog Provider disappeared");
    const checkedAt = this.timestamp();
    const client = this.clients.get(provider.id);
    if (client?.checkModel === undefined) {
      return Object.freeze({
        model: freezeModelRef(resolved.ref),
        status: "unknown" as const,
        checkedAt,
      });
    }
    try {
      const status = await client.checkModel({
        provider,
        model: resolved.ref,
        ...(signal === undefined ? {} : { signal }),
      });
      if (status !== "available" && status !== "unavailable") {
        throw new Error("Catalog client returned an invalid check status");
      }
      return Object.freeze({
        model: freezeModelRef(resolved.ref),
        status,
        checkedAt,
      });
    } catch {
      return Object.freeze({
        model: freezeModelRef(resolved.ref),
        status: "unknown" as const,
        checkedAt,
        error: "Provider model check failed",
      });
    }
  }

  async diff(signal?: AbortSignal): Promise<ModelCatalogDiff> {
    const previous = await this.options.store.load();
    const fetched = await this.fetchEnabledProviders(previous, signal);
    return fetched.diff;
  }

  async sync(signal?: AbortSignal): Promise<ModelCatalogSyncResult> {
    const previous = await this.options.store.load();
    const fetched = await this.fetchEnabledProviders(previous, signal);
    await this.options.store.save(fetched.snapshot);
    return Object.freeze({ snapshot: fetched.snapshot, diff: fetched.diff });
  }

  private async fetchEnabledProviders(
    previous: ModelCatalogSnapshot | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ModelCatalogSyncResult> {
    const checkedAt = this.timestamp();
    const previousByProvider = new Map(
      (previous?.providers ?? []).map((provider) => [provider.providerId, provider]),
    );
    const nextByProvider = new Map(previousByProvider);
    const diffs: ProviderCatalogDiff[] = [];
    for (const provider of this.options.configuration.providers) {
      if (!provider.catalog.enabled) continue;
      const old = previousByProvider.get(provider.id);
      const client = this.clients.get(provider.id);
      try {
        if (client === undefined) throw new Error("Catalog client is unavailable");
        const models = snapshotDiscoveredModels(await client.fetchModels({
          provider,
          ...(signal === undefined ? {} : { signal }),
        }));
        const next = Object.freeze({
          providerId: provider.id,
          fetchedAt: checkedAt,
          checkedAt,
          models,
        });
        nextByProvider.set(provider.id, next);
        diffs.push(compareProviderCatalog(provider.id, old?.models ?? [], models));
      } catch {
        const error = "Provider catalog synchronization failed";
        nextByProvider.set(provider.id, Object.freeze({
          providerId: provider.id,
          ...(old?.fetchedAt === undefined ? {} : { fetchedAt: old.fetchedAt }),
          checkedAt,
          models: old?.models ?? Object.freeze([]),
          lastError: error,
        }));
        diffs.push(Object.freeze({
          providerId: provider.id,
          status: "failed" as const,
          added: Object.freeze([]),
          removed: Object.freeze([]),
          changed: Object.freeze([]),
          error,
        }));
      }
    }
    const snapshot = Object.freeze({
      schemaVersion: 1 as const,
      updatedAt: checkedAt,
      providers: Object.freeze([...nextByProvider.values()]),
    });
    const diff = Object.freeze({
      checkedAt,
      providers: Object.freeze(diffs),
    });
    return Object.freeze({ snapshot, diff });
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value))) {
      throw new Error("Catalog clock must return a timestamp");
    }
    return value;
  }
}

export function snapshotCatalog(
  value: unknown,
): ModelCatalogSnapshot {
  const root = plainRecord(value, "Model Catalog");
  if (root.schemaVersion !== 1) throw new Error("Unknown Model Catalog schemaVersion");
  const updatedAt = stringValue(root.updatedAt, "Catalog updatedAt");
  timestamp(updatedAt, "Catalog updatedAt");
  if (!Array.isArray(root.providers)) throw new Error("Catalog providers must be an array");
  const providers = root.providers.map((value) => {
    const provider = plainRecord(value, "Catalog Provider");
    const providerId = stringValue(provider.providerId, "Catalog Provider id");
    const checkedAt = stringValue(provider.checkedAt, "Catalog checkedAt");
    identifier(providerId, "Catalog Provider id");
    timestamp(checkedAt, "Catalog checkedAt");
    const fetchedAt = provider.fetchedAt === undefined
      ? undefined
      : stringValue(provider.fetchedAt, "Catalog fetchedAt");
    if (fetchedAt !== undefined) timestamp(fetchedAt, "Catalog fetchedAt");
    const lastError = provider.lastError === undefined
      ? undefined
      : stringValue(provider.lastError, "Catalog lastError");
    return Object.freeze({
      providerId,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      checkedAt,
      models: snapshotDiscoveredModels(provider.models),
      ...(lastError === undefined ? {} : { lastError }),
    });
  });
  rejectDuplicateIds(providers.map((provider) => provider.providerId), "Catalog Provider");
  return Object.freeze({
    schemaVersion: 1 as const,
    updatedAt,
    providers: Object.freeze(providers),
  });
}

function snapshotDiscoveredModels(
  models: unknown,
): readonly DiscoveredModel[] {
  if (!Array.isArray(models)) throw new Error("Discovered models must be an array");
  const result = models.map((value) => {
    const model = plainRecord(value, "Discovered model");
    const id = stringValue(model.id, "Discovered model id");
    identifier(id, "Discovered model id");
    const name = optionalStringValue(model.name, "Discovered model name");
    const status = model.status === undefined
      ? undefined
      : availability(model.status, "Discovered model status");
    const contextWindowTokens = optionalPositiveInteger(
      model.contextWindowTokens,
      "contextWindowTokens",
    );
    const maxOutputTokens = optionalPositiveInteger(
      model.maxOutputTokens,
      "maxOutputTokens",
    );
    const textInput = optionalBooleanValue(model.textInput, "textInput");
    const imageInput = optionalBooleanValue(model.imageInput, "imageInput");
    const reasoning = optionalBooleanValue(model.reasoning, "reasoning");
    const toolCalling = optionalBooleanValue(model.toolCalling, "toolCalling");
    const developerRole = optionalBooleanValue(model.developerRole, "developerRole");
    const price = model.price === undefined ? undefined : snapshotPrice(model.price);
    return Object.freeze({
      id,
      ...(name === undefined ? {} : { name }),
      ...(status === undefined ? {} : { status }),
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(textInput === undefined ? {} : { textInput }),
      ...(imageInput === undefined ? {} : { imageInput }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(toolCalling === undefined ? {} : { toolCalling }),
      ...(developerRole === undefined ? {} : { developerRole }),
      ...(price === undefined ? {} : { price }),
    });
  });
  rejectDuplicateIds(result.map((model) => model.id), "Discovered model");
  return Object.freeze(result);
}

function mergeCatalogModel(
  providerId: string,
  configured: ModelsConfiguration["providers"][number]["models"][number] | undefined,
  discovered: DiscoveredModel | undefined,
): CatalogModel {
  const id = configured?.id ?? discovered?.id;
  if (id === undefined) throw new Error("Catalog model has no identity");
  const name = configured?.name ?? discovered?.name;
  const contextWindowTokens = configured?.contextWindowTokens ??
    discovered?.contextWindowTokens;
  const maxOutputTokens = configured?.maxOutputTokens ??
    discovered?.maxOutputTokens;
  const price = configured?.price ?? discovered?.price;
  return Object.freeze({
    ref: Object.freeze({ provider: providerId, model: id }),
    ...(name === undefined ? {} : { name }),
    status: configured?.status === undefined || configured.status === "unknown"
      ? discovered?.status ?? "unknown"
      : configured.status,
    source: configured !== undefined && discovered !== undefined
      ? "both" as const
      : configured !== undefined ? "configured" as const : "discovered" as const,
    verification: "unverified" as const,
    callability: "unknown" as const,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: Object.freeze({
      textInput: configured?.input.text ?? discovered?.textInput ?? "unknown",
      imageInput: configured?.input.image ?? discovered?.imageInput ?? "unknown",
      reasoning: configured?.reasoning ?? discovered?.reasoning ?? "unknown",
      toolCalling: configured?.toolCalling ?? discovered?.toolCalling ?? "unknown",
      developerRole: configured?.developerRole ?? discovered?.developerRole ?? "unknown",
    }),
    ...(price === undefined ? {} : { price }),
  });
}

function compareProviderCatalog(
  providerId: string,
  previous: readonly DiscoveredModel[],
  next: readonly DiscoveredModel[],
): ProviderCatalogDiff {
  const oldById = new Map(previous.map((model) => [model.id, model]));
  const nextById = new Map(next.map((model) => [model.id, model]));
  const added = next.filter((model) => !oldById.has(model.id))
    .map((model) => freezeModelRef({ provider: providerId, model: model.id }));
  const removed = previous.filter((model) => !nextById.has(model.id))
    .map((model) => freezeModelRef({ provider: providerId, model: model.id }));
  const changed = next.filter((model) => {
    const old = oldById.get(model.id);
    return old !== undefined && JSON.stringify(old) !== JSON.stringify(model);
  }).map((model) => freezeModelRef({ provider: providerId, model: model.id }));
  return Object.freeze({
    providerId,
    status: "ok" as const,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
  });
}

function freezeModelRef(model: ModelRef): ModelRef {
  return Object.freeze({ provider: model.provider, model: model.model });
}

function identifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
}

function timestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a timestamp`);
  }
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalStringValue(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const result = stringValue(value, label);
  identifier(result, label);
  return result;
}

function optionalBooleanValue(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function availability(value: unknown, label: string): ModelAvailability {
  if (
    value === "active" || value === "deprecated" ||
    value === "unavailable" || value === "unknown"
  ) return value;
  throw new Error(`${label} is invalid`);
}

function snapshotPrice(value: unknown): ModelPrice {
  const price = plainRecord(value, "Catalog model price");
  const version = stringValue(price.version, "Catalog price version");
  const currency = stringValue(price.currency, "Catalog price currency");
  identifier(version, "Catalog price version");
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new Error("Catalog price currency must be a three-letter uppercase code");
  }
  const effectiveFrom = optionalStringValue(
    price.effectiveFrom,
    "Catalog price effectiveFrom",
  );
  if (effectiveFrom !== undefined) timestamp(effectiveFrom, "Catalog price effectiveFrom");
  const cachedInputPerMillionTokens = optionalNonNegativeNumber(
    price.cachedInputPerMillionTokens,
    "cachedInputPerMillionTokens",
  );
  const cacheWriteInputPerMillionTokens = optionalNonNegativeNumber(
    price.cacheWriteInputPerMillionTokens,
    "cacheWriteInputPerMillionTokens",
  );
  return Object.freeze({
    version,
    currency,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    inputPerMillionTokens: nonNegativeNumber(
      price.inputPerMillionTokens,
      "inputPerMillionTokens",
    ),
    ...(cachedInputPerMillionTokens === undefined
      ? {}
      : { cachedInputPerMillionTokens }),
    ...(cacheWriteInputPerMillionTokens === undefined
      ? {}
      : { cacheWriteInputPerMillionTokens }),
    outputPerMillionTokens: nonNegativeNumber(
      price.outputPerMillionTokens,
      "outputPerMillionTokens",
    ),
  });
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(value, label);
}

function rejectDuplicateIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} "${value}" is duplicated`);
    seen.add(value);
  }
}
