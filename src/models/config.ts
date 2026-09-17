import { readFile } from "node:fs/promises";

import type { ModelRef } from "../core/model/model.js";
import type {
  DeveloperRoleStrategy,
  ModelAvailability,
  ModelConfigurationSource,
  ModelInputCapabilities,
  ModelPrice,
  ModelReasoningControl,
  ModelReasoningEffort,
  ModelRequestCompatibility,
  ModelSpec,
  ModelsConfiguration,
  PartialModelRequestCompatibility,
  ProviderAuth,
  ProviderCatalogConfiguration,
  ProviderHeaderValue,
  ProviderProfile,
  ResolvedModel,
} from "./types.js";
import { createDefaultModelsConfigurationSource } from "./defaults.js";

const BUILTIN_PROTOCOLS = Object.freeze([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);
const PROTECTED_EXTRA_BODY_FIELDS = new Set([
  "model",
  "input",
  "messages",
  "tools",
  "stream",
  "stream_options",
  "system",
  "temperature",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export class ModelsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigurationError";
  }
}

export interface ModelsConfigurationFileSource {
  readonly path?: string;
  readonly environment?: ModelConfigurationSource["environment"];
  readonly availableProtocols?: readonly string[];
  readonly readTextFile?: (path: string) => Promise<string>;
}

export async function loadModelsConfigurationFile(
  source: ModelsConfigurationFileSource,
): Promise<ModelsConfiguration> {
  const path = source.path ?? source.environment?.WISH_MODELS_CONFIG;
  if (path === undefined || path.length === 0 || path !== path.trim()) {
    throw configurationError(
      "Models configuration path is required as path or WISH_MODELS_CONFIG",
    );
  }
  const reader = source.readTextFile ?? ((file: string) => readFile(file, "utf8"));
  let json: string;
  try {
    json = await reader(path);
  } catch {
    throw configurationError(`Models configuration file could not be read: ${path}`);
  }
  return loadModelsConfiguration({
    json,
    ...(source.environment === undefined
      ? {}
      : { environment: source.environment }),
    ...(source.availableProtocols === undefined
      ? {}
      : { availableProtocols: source.availableProtocols }),
  });
}

/** Parse, validate, merge, and snapshot public or generated Models configuration. */
export function loadModelsConfiguration(
  source: ModelConfigurationSource,
): ModelsConfiguration {
  const environment = source.environment ?? {};
  const raw = source.json ?? environment.WISH_MODELS_JSON ??
    createDefaultModelsConfigurationSource();
  const parsed = record(parseJson(raw), "configuration");
  const root = parsed.schemaVersion === 2
    ? mergeConfigurationOverlay(parsed)
    : parsed;
  knownKeys(
    root,
    ["schemaVersion", "providers", "defaultModel", "fallbackModels", "maxRetries"],
    "configuration",
  );
  if (root.schemaVersion !== 1) {
    throw configurationError(
      "Models configuration schemaVersion must be 1 (full) or 2 (overlay)",
    );
  }

  const providerValues = array(root.providers, "configuration.providers");
  if (providerValues.length === 0) {
    throw configurationError("Models configuration must contain a Provider");
  }
  const providers = providerValues.map((value, index) =>
    parseProvider(value, `configuration.providers[${index}]`)
  );
  rejectDuplicates(providers.map((provider) => provider.id), "Provider id");

  const availableProtocols = new Set(
    source.availableProtocols ?? BUILTIN_PROTOCOLS,
  );
  for (const provider of providers) {
    if (!availableProtocols.has(provider.protocol)) {
      throw configurationError(
        `Provider "${provider.id}" uses unknown protocol "${provider.protocol}"`,
      );
    }
  }

  const defaultText = environment.WISH_MODEL ??
    optionalString(root.defaultModel, "configuration.defaultModel") ??
    firstProviderDefault(providers);
  if (defaultText === undefined) {
    throw configurationError(
      "A default model is required in WISH_MODEL, defaultModel, or a Provider defaultModel",
    );
  }
  const defaultModel = validateKnownModel(
    providers,
    parseModelReference(defaultText, "default model"),
    "default model",
  );

  const fallbackTexts = environment.WISH_FALLBACK_MODELS === undefined
    ? optionalStringArray(root.fallbackModels, "configuration.fallbackModels") ?? []
    : parseEnvironmentFallbacks(environment.WISH_FALLBACK_MODELS);
  const fallbackModels = distinctModelRefs(
    fallbackTexts.map((value, index) =>
      validateKnownModel(
        providers,
        parseModelReference(value, `fallback model ${index + 1}`),
        `fallback model ${index + 1}`,
      )
    ),
    defaultModel,
  );

  const maxRetries = environment.WISH_MODEL_MAX_RETRIES === undefined
    ? optionalNonNegativeInteger(root.maxRetries, "configuration.maxRetries") ?? 2
    : parseEnvironmentInteger(
      environment.WISH_MODEL_MAX_RETRIES,
      "WISH_MODEL_MAX_RETRIES",
    );

  return Object.freeze({
    schemaVersion: 1 as const,
    providers: Object.freeze(providers),
    defaultModel,
    fallbackModels: Object.freeze(fallbackModels),
    maxRetries,
  });
}

/**
 * schemaVersion 2 is a user overlay on generated defaults. Providers and
 * Models are upserted by id; nested headers, request, input, and price records
 * are merged without mutating either source.
 */
function mergeConfigurationOverlay(
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  knownKeys(
    overlay,
    ["schemaVersion", "providers", "defaultModel", "fallbackModels", "maxRetries"],
    "configuration",
  );
  const base = record(
    createDefaultModelsConfigurationSource(),
    "generated configuration",
  );
  const providerOverlays = overlay.providers === undefined
    ? []
    : array(overlay.providers, "configuration.providers");
  const providers = array(base.providers, "generated configuration.providers")
    .map((provider, index) => ({
      ...record(provider, `generated configuration.providers[${index}]`),
    }));
  const overlayProviderIds = new Set<string>();

  for (let index = 0; index < providerOverlays.length; index += 1) {
    const value = record(
      providerOverlays[index],
      `configuration.providers[${index}]`,
    );
    const id = identifier(
      requiredString(value.id, `configuration.providers[${index}].id`),
      `configuration.providers[${index}].id`,
    );
    if (overlayProviderIds.has(id)) {
      throw configurationError(`Provider overlay id "${id}" is duplicated`);
    }
    overlayProviderIds.add(id);
    const existingIndex = providers.findIndex((provider) => provider.id === id);
    const merged = mergeProviderOverlay(
      existingIndex < 0 ? undefined : providers[existingIndex],
      value,
      `configuration.providers[${index}]`,
    );
    if (existingIndex < 0) providers.push(merged);
    else providers[existingIndex] = merged;
  }

  return {
    schemaVersion: 1,
    providers,
    defaultModel: overlay.defaultModel ?? base.defaultModel,
    fallbackModels: overlay.fallbackModels ?? base.fallbackModels,
    maxRetries: overlay.maxRetries ?? base.maxRetries,
  };
}

function mergeProviderOverlay(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  knownKeys(
    overlay,
    [
      "id",
      "protocol",
      "baseUrl",
      "auth",
      "headers",
      "defaultModel",
      "developerRoleMode",
      "request",
      "catalog",
      "models",
    ],
    path,
  );
  const result: Record<string, unknown> = { ...(base ?? {}), ...overlay };
  result.headers = mergeOptionalRecords(base?.headers, overlay.headers, `${path}.headers`);
  result.request = mergeRequestOverlay(base?.request, overlay.request, `${path}.request`);
  result.catalog = mergeOptionalRecords(base?.catalog, overlay.catalog, `${path}.catalog`);
  if (overlay.models === undefined) {
    if (base?.models !== undefined) result.models = base.models;
  } else {
    result.models = mergeModelOverlays(base?.models, overlay.models, `${path}.models`);
  }
  return result;
}

function mergeModelOverlays(
  baseValue: unknown,
  overlayValue: unknown,
  path: string,
): readonly Record<string, unknown>[] {
  const models = baseValue === undefined
    ? []
    : array(baseValue, "generated Provider models").map((value, index) => ({
      ...record(value, `generated Provider models[${index}]`),
    }));
  const overlays = array(overlayValue, path);
  const overlayModelIds = new Set<string>();
  for (let index = 0; index < overlays.length; index += 1) {
    const model = record(overlays[index], `${path}[${index}]`);
    const id = modelIdentifier(
      requiredString(model.id, `${path}[${index}].id`),
      `${path}[${index}].id`,
    );
    if (overlayModelIds.has(id)) {
      throw configurationError(`Model overlay id "${id}" is duplicated`);
    }
    overlayModelIds.add(id);
    const existingIndex = models.findIndex((candidate) => candidate.id === id);
    const base = existingIndex < 0 ? undefined : models[existingIndex];
    const merged = mergeModelOverlay(base, model, `${path}[${index}]`);
    if (existingIndex < 0) models.push(merged);
    else models[existingIndex] = merged;
  }
  return models;
}

function mergeModelOverlay(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  knownKeys(
    overlay,
    [
      "id",
      "name",
      "status",
      "contextWindowTokens",
      "maxOutputTokens",
      "defaultMaxOutputTokens",
      "input",
      "reasoning",
      "reasoningControl",
      "toolCalling",
      "developerRole",
      "price",
      "baseUrl",
      "auth",
      "headers",
      "developerRoleMode",
      "request",
    ],
    path,
  );
  return {
    ...(base ?? {}),
    ...overlay,
    input: mergeOptionalRecords(base?.input, overlay.input, `${path}.input`),
    headers: mergeOptionalRecords(base?.headers, overlay.headers, `${path}.headers`),
    price: mergeOptionalRecords(base?.price, overlay.price, `${path}.price`),
    request: mergeRequestOverlay(base?.request, overlay.request, `${path}.request`),
  };
}

function mergeRequestOverlay(
  baseValue: unknown,
  overlayValue: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (baseValue === undefined && overlayValue === undefined) return undefined;
  const base = baseValue === undefined ? {} : record(baseValue, path);
  const overlay = overlayValue === undefined ? {} : record(overlayValue, path);
  return {
    ...base,
    ...overlay,
    extraBody: mergeOptionalRecords(
      base.extraBody,
      overlay.extraBody,
      `${path}.extraBody`,
    ),
  };
}

function mergeOptionalRecords(
  baseValue: unknown,
  overlayValue: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (baseValue === undefined && overlayValue === undefined) return undefined;
  const base = baseValue === undefined ? {} : record(baseValue, path);
  const overlay = overlayValue === undefined ? {} : record(overlayValue, path);
  return { ...base, ...overlay };
}

export function parseModelReference(
  value: string,
  label = "model reference",
): ModelRef {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw configurationError(`${label} must be a non-empty trimmed provider/model`);
  }
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) {
    throw configurationError(`${label} must use the full provider/model form`);
  }
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  identifier(provider, `${label} Provider`);
  modelIdentifier(model, `${label} model`);
  return Object.freeze({ provider, model });
}

export function formatModelReference(model: ModelRef): string {
  identifier(model.provider, "Model Provider");
  modelIdentifier(model.model, "Model name");
  return `${model.provider}/${model.model}`;
}

/** Merge Provider defaults with one Model's explicit overrides. */
export function resolveConfiguredModel(
  configuration: ModelsConfiguration,
  reference: ModelRef | string,
): ResolvedModel {
  const ref = typeof reference === "string"
    ? parseModelReference(reference)
    : Object.freeze({
      provider: identifier(reference.provider, "Model Provider"),
      model: modelIdentifier(reference.model, "Model name"),
    });
  const provider = configuration.providers.find((item) => item.id === ref.provider);
  if (provider === undefined) {
    throw configurationError(`Unknown Model Provider "${ref.provider}"`);
  }
  const spec = provider.models.find((item) => item.id === ref.model);
  if (spec === undefined) {
    throw configurationError(`Unknown model "${formatModelReference(ref)}"`);
  }
  const headers = Object.freeze({
    ...provider.headers,
    ...(spec.headers ?? {}),
  });
  const request = mergeRequestCompatibility(provider.request, spec.request);
  return Object.freeze({
    ref,
    protocol: provider.protocol,
    baseUrl: spec.baseUrl ?? provider.baseUrl,
    auth: spec.auth ?? provider.auth,
    headers,
    developerRoleMode: spec.developerRoleMode ?? provider.developerRoleMode,
    request,
    catalog: provider.catalog,
    spec,
  });
}

function parseProvider(value: unknown, path: string): ProviderProfile {
  const input = record(value, path);
  knownKeys(
    input,
    [
      "id",
      "protocol",
      "baseUrl",
      "auth",
      "headers",
      "defaultModel",
      "developerRoleMode",
      "request",
      "catalog",
      "models",
    ],
    path,
  );
  const id = identifier(requiredString(input.id, `${path}.id`), `${path}.id`);
  const protocol = identifier(
    requiredString(input.protocol, `${path}.protocol`),
    `${path}.protocol`,
  );
  const baseUrl = endpoint(requiredString(input.baseUrl, `${path}.baseUrl`), `${path}.baseUrl`);
  const auth = parseAuth(input.auth, `${path}.auth`);
  const headers = parseHeaders(input.headers, `${path}.headers`);
  const defaultModel = optionalString(input.defaultModel, `${path}.defaultModel`);
  if (defaultModel !== undefined) modelIdentifier(defaultModel, `${path}.defaultModel`);
  const developerRoleMode = parseDeveloperRole(
    input.developerRoleMode ?? "unsupported",
    `${path}.developerRoleMode`,
  );
  const request = parseRequestCompatibility(input.request, `${path}.request`);
  const catalog = parseCatalog(input.catalog, `${path}.catalog`);
  const models = array(input.models, `${path}.models`).map((model, index) =>
    parseModelSpec(model, `${path}.models[${index}]`)
  );
  if (models.length === 0) {
    throw configurationError(`${path}.models must contain at least one model`);
  }
  rejectDuplicates(models.map((model) => model.id), `Model id in Provider "${id}"`);
  if (defaultModel !== undefined && !models.some((model) => model.id === defaultModel)) {
    throw configurationError(
      `Provider "${id}" defaultModel does not identify a configured model`,
    );
  }
  validateDeveloperRoleConfiguration(protocol, developerRoleMode, models, path);
  for (const model of models) {
    const format = model.reasoningControl?.format;
    if (format !== undefined && (format === "deepseek-chat" ? protocol !== "openai-chat-completions" : protocol !== "openai-responses")) {
      throw configurationError(`${path} Model "${model.id}" has reasoningControl incompatible with protocol "${protocol}"`);
    }
  }
  return Object.freeze({
    id,
    protocol,
    baseUrl,
    auth,
    headers,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    developerRoleMode,
    request,
    catalog,
    models: Object.freeze(models),
  });
}

function validateDeveloperRoleConfiguration(
  protocol: string,
  providerMode: DeveloperRoleStrategy,
  models: readonly ModelSpec[],
  path: string,
): void {
  if (protocol === "anthropic-messages") {
    if (providerMode !== "system-fallback") {
      throw configurationError(
        `${path}.developerRoleMode must be system-fallback for anthropic-messages`,
      );
    }
    if (models.some((model) =>
      model.developerRoleMode !== undefined &&
      model.developerRoleMode !== "system-fallback"
    )) {
      throw configurationError(
        `${path} Model developerRoleMode must be system-fallback for anthropic-messages`,
      );
    }
  }
  for (const model of models) {
    const mode = model.developerRoleMode ?? providerMode;
    if (mode === "native" && !model.developerRole) {
      throw configurationError(
        `${path} Model "${model.id}" cannot use native developerRoleMode without developerRole capability`,
      );
    }
  }
}

function parseModelSpec(value: unknown, path: string): ModelSpec {
  const input = record(value, path);
  knownKeys(
    input,
    [
      "id",
      "name",
      "status",
      "contextWindowTokens",
      "maxOutputTokens",
      "defaultMaxOutputTokens",
      "input",
      "reasoning",
      "reasoningControl",
      "toolCalling",
      "developerRole",
      "price",
      "baseUrl",
      "auth",
      "headers",
      "developerRoleMode",
      "request",
    ],
    path,
  );
  const id = modelIdentifier(requiredString(input.id, `${path}.id`), `${path}.id`);
  const name = optionalString(input.name, `${path}.name`);
  const status = parseAvailability(input.status ?? "unknown", `${path}.status`);
  const contextWindowTokens = optionalPositiveInteger(
    input.contextWindowTokens,
    `${path}.contextWindowTokens`,
  );
  const maxOutputTokens = optionalPositiveInteger(
    input.maxOutputTokens,
    `${path}.maxOutputTokens`,
  );
  const defaultMaxOutputTokens = optionalPositiveInteger(
    input.defaultMaxOutputTokens,
    `${path}.defaultMaxOutputTokens`,
  );
  if (defaultMaxOutputTokens !== undefined && maxOutputTokens !== undefined && defaultMaxOutputTokens > maxOutputTokens) {
    throw configurationError(`${path}.defaultMaxOutputTokens exceeds maxOutputTokens`);
  }
  const capabilities = parseInputCapabilities(input.input, `${path}.input`);
  const reasoning = optionalBoolean(input.reasoning, `${path}.reasoning`) ?? false;
  const reasoningControl = input.reasoningControl === undefined
    ? undefined
    : parseReasoningControl(input.reasoningControl, `${path}.reasoningControl`);
  if (reasoningControl !== undefined && !reasoning) {
    throw configurationError(`${path}.reasoningControl requires reasoning capability`);
  }
  const toolCalling = optionalBoolean(input.toolCalling, `${path}.toolCalling`) ?? false;
  const developerRole = optionalBoolean(
    input.developerRole,
    `${path}.developerRole`,
  ) ?? false;
  const price = input.price === undefined ? undefined : parsePrice(input.price, `${path}.price`);
  const baseUrl = input.baseUrl === undefined
    ? undefined
    : endpoint(requiredString(input.baseUrl, `${path}.baseUrl`), `${path}.baseUrl`);
  const auth = input.auth === undefined ? undefined : parseAuth(input.auth, `${path}.auth`);
  const headers = input.headers === undefined
    ? undefined
    : parseHeaders(input.headers, `${path}.headers`);
  const developerRoleMode = input.developerRoleMode === undefined
    ? undefined
    : parseDeveloperRole(input.developerRoleMode, `${path}.developerRoleMode`);
  const request = input.request === undefined
    ? undefined
    : parsePartialRequestCompatibility(input.request, `${path}.request`);
  return Object.freeze({
    id,
    ...(name === undefined ? {} : { name }),
    status,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens }),
    input: capabilities,
    reasoning,
    ...(reasoningControl === undefined ? {} : { reasoningControl }),
    toolCalling,
    developerRole,
    ...(price === undefined ? {} : { price }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(auth === undefined ? {} : { auth }),
    ...(headers === undefined ? {} : { headers }),
    ...(developerRoleMode === undefined ? {} : { developerRoleMode }),
    ...(request === undefined ? {} : { request }),
  });
}

function parseAuth(value: unknown, path: string): ProviderAuth {
  const input = record(value, path);
  const type = requiredString(input.type, `${path}.type`);
  if (type === "none") {
    knownKeys(input, ["type"], path);
    return Object.freeze({ type });
  }
  if (type === "bearer") {
    knownKeys(input, ["type", "apiKeyEnv"], path);
    return Object.freeze({
      type,
      apiKeyEnv: environmentName(input.apiKeyEnv, `${path}.apiKeyEnv`),
    });
  }
  if (type === "x-api-key") {
    knownKeys(input, ["type", "apiKeyEnv", "headerName"], path);
    const headerName = input.headerName === undefined
      ? undefined
      : normalizeHeaderName(
        requiredString(input.headerName, `${path}.headerName`),
        `${path}.headerName`,
      );
    return Object.freeze({
      type,
      apiKeyEnv: environmentName(input.apiKeyEnv, `${path}.apiKeyEnv`),
      ...(headerName === undefined ? {} : { headerName }),
    });
  }
  throw configurationError(`${path}.type must be bearer, x-api-key, or none`);
}

function parseHeaders(
  value: unknown,
  path: string,
): Readonly<Record<string, ProviderHeaderValue>> {
  if (value === undefined) return Object.freeze({});
  const input = record(value, path);
  const entries: Array<[string, ProviderHeaderValue]> = [];
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = normalizeHeaderName(rawName, `${path} header name`);
    if (entries.some(([existing]) => existing === name)) {
      throw configurationError(`${path} contains a duplicate header name`);
    }
    if (typeof rawValue === "string") {
      entries.push([name, rawValue]);
      continue;
    }
    const reference = record(rawValue, `${path}.${name}`);
    knownKeys(reference, ["fromEnv"], `${path}.${name}`);
    entries.push([
      name,
      Object.freeze({
        fromEnv: environmentName(reference.fromEnv, `${path}.${name}.fromEnv`),
      }),
    ]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function parseRequestCompatibility(
  value: unknown,
  path: string,
): ModelRequestCompatibility {
  if (value === undefined) {
    return Object.freeze({
      streamUsage: true,
      supportsTemperature: true,
      maxTokensField: "max_tokens" as const,
      extraBody: Object.freeze({}),
    });
  }
  const partial = parsePartialRequestCompatibility(value, path);
  return Object.freeze({
    streamUsage: partial.streamUsage ?? true,
    supportsTemperature: partial.supportsTemperature ?? true,
    maxTokensField: partial.maxTokensField ?? "max_tokens",
    extraBody: partial.extraBody ?? Object.freeze({}),
  });
}

function parsePartialRequestCompatibility(
  value: unknown,
  path: string,
): PartialModelRequestCompatibility {
  const input = record(value, path);
  knownKeys(
    input,
    ["streamUsage", "supportsTemperature", "maxTokensField", "extraBody"],
    path,
  );
  const streamUsage = optionalBoolean(input.streamUsage, `${path}.streamUsage`);
  const supportsTemperature = optionalBoolean(
    input.supportsTemperature,
    `${path}.supportsTemperature`,
  );
  const maxTokensField = input.maxTokensField === undefined
    ? undefined
    : parseMaxTokensField(input.maxTokensField, `${path}.maxTokensField`);
  const extraBody = input.extraBody === undefined
    ? undefined
    : parseExtraBody(input.extraBody, `${path}.extraBody`);
  return Object.freeze({
    ...(streamUsage === undefined ? {} : { streamUsage }),
    ...(supportsTemperature === undefined ? {} : { supportsTemperature }),
    ...(maxTokensField === undefined ? {} : { maxTokensField }),
    ...(extraBody === undefined ? {} : { extraBody }),
  });
}

function mergeRequestCompatibility(
  provider: ModelRequestCompatibility,
  model: PartialModelRequestCompatibility | undefined,
): ModelRequestCompatibility {
  return Object.freeze({
    streamUsage: model?.streamUsage ?? provider.streamUsage,
    supportsTemperature: model?.supportsTemperature ?? provider.supportsTemperature,
    maxTokensField: model?.maxTokensField ?? provider.maxTokensField,
    extraBody: Object.freeze({
      ...provider.extraBody,
      ...(model?.extraBody ?? {}),
    }),
  });
}

function parseExtraBody(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  const input = record(value, path);
  for (const key of Object.keys(input)) {
    if (PROTECTED_EXTRA_BODY_FIELDS.has(key)) {
      throw configurationError(`${path} cannot override protected field "${key}"`);
    }
  }
  return freezeJsonRecord(input, path);
}

function parseCatalog(
  value: unknown,
  path: string,
): ProviderCatalogConfiguration {
  if (value === undefined) return Object.freeze({ enabled: false });
  const input = record(value, path);
  knownKeys(input, ["enabled", "endpoint"], path);
  const enabled = optionalBoolean(input.enabled, `${path}.enabled`) ?? false;
  const rawEndpoint = optionalString(input.endpoint, `${path}.endpoint`);
  const catalogEndpoint = rawEndpoint === undefined
    ? undefined
    : rawEndpoint.startsWith("/")
      ? rawEndpoint
      : endpoint(rawEndpoint, `${path}.endpoint`);
  return Object.freeze({
    enabled,
    ...(catalogEndpoint === undefined ? {} : { endpoint: catalogEndpoint }),
  });
}

function parseInputCapabilities(
  value: unknown,
  path: string,
): ModelInputCapabilities {
  if (value === undefined) return Object.freeze({ text: true, image: false });
  const input = record(value, path);
  knownKeys(input, ["text", "image"], path);
  return Object.freeze({
    text: optionalBoolean(input.text, `${path}.text`) ?? true,
    image: optionalBoolean(input.image, `${path}.image`) ?? false,
  });
}

function parseReasoningControl(value: unknown, path: string): ModelReasoningControl {
  const input = record(value, path);
  knownKeys(input, ["format", "efforts", "defaultEffort"], path);
  const format = requiredString(input.format, `${path}.format`);
  if (format !== "deepseek-chat" && format !== "openai-responses") {
    throw configurationError(`${path}.format is unsupported`);
  }
  const efforts = array(input.efforts, `${path}.efforts`).map((value, index): ModelReasoningEffort => {
    if (value !== "none" && value !== "low" && value !== "high" && value !== "max") {
      throw configurationError(`${path}.efforts[${index}] is unsupported`);
    }
    return value;
  });
  if (efforts.length === 0 || new Set(efforts).size !== efforts.length) {
    throw configurationError(`${path}.efforts must contain unique values`);
  }
  const defaultEffort = requiredString(input.defaultEffort, `${path}.defaultEffort`);
  if (!efforts.includes(defaultEffort as ModelReasoningEffort)) {
    throw configurationError(`${path}.defaultEffort must be included in efforts`);
  }
  return Object.freeze({ format, efforts: Object.freeze(efforts), defaultEffort: defaultEffort as ModelReasoningEffort });
}

function parsePrice(value: unknown, path: string): ModelPrice {
  const input = record(value, path);
  knownKeys(
    input,
    [
      "version",
      "currency",
      "effectiveFrom",
      "inputPerMillionTokens",
      "cachedInputPerMillionTokens",
      "cacheWriteInputPerMillionTokens",
      "outputPerMillionTokens",
    ],
    path,
  );
  const version = requiredString(input.version, `${path}.version`);
  const currency = requiredString(input.currency, `${path}.currency`);
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw configurationError(`${path}.currency must be a three-letter uppercase code`);
  }
  const effectiveFrom = optionalString(input.effectiveFrom, `${path}.effectiveFrom`);
  if (effectiveFrom !== undefined && !Number.isFinite(Date.parse(effectiveFrom))) {
    throw configurationError(`${path}.effectiveFrom must be a valid timestamp`);
  }
  const cachedInputPerMillionTokens = optionalNonNegativeNumber(
    input.cachedInputPerMillionTokens,
    `${path}.cachedInputPerMillionTokens`,
  );
  const cacheWriteInputPerMillionTokens = optionalNonNegativeNumber(
    input.cacheWriteInputPerMillionTokens,
    `${path}.cacheWriteInputPerMillionTokens`,
  );
  return Object.freeze({
    version,
    currency,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    inputPerMillionTokens: nonNegativeNumber(
      input.inputPerMillionTokens,
      `${path}.inputPerMillionTokens`,
    ),
    ...(cachedInputPerMillionTokens === undefined
      ? {}
      : { cachedInputPerMillionTokens }),
    ...(cacheWriteInputPerMillionTokens === undefined
      ? {}
      : { cacheWriteInputPerMillionTokens }),
    outputPerMillionTokens: nonNegativeNumber(
      input.outputPerMillionTokens,
      `${path}.outputPerMillionTokens`,
    ),
  });
}

function parseAvailability(value: unknown, path: string): ModelAvailability {
  if (
    value === "active" || value === "deprecated" ||
    value === "unavailable" || value === "unknown"
  ) return value;
  throw configurationError(`${path} must be active, deprecated, unavailable, or unknown`);
}

function parseDeveloperRole(value: unknown, path: string): DeveloperRoleStrategy {
  if (value === "native" || value === "system-fallback" || value === "unsupported") {
    return value;
  }
  throw configurationError(`${path} must be native, system-fallback, or unsupported`);
}

function parseMaxTokensField(
  value: unknown,
  path: string,
): "max_tokens" | "max_completion_tokens" | "max_output_tokens" {
  if (
    value === "max_tokens" || value === "max_completion_tokens" ||
    value === "max_output_tokens"
  ) return value;
  throw configurationError(
    `${path} must be max_tokens, max_completion_tokens, or max_output_tokens`,
  );
}

function validateKnownModel(
  providers: readonly ProviderProfile[],
  ref: ModelRef,
  label: string,
): ModelRef {
  const provider = providers.find((candidate) => candidate.id === ref.provider);
  if (provider === undefined) {
    throw configurationError(`${label} uses unknown Provider "${ref.provider}"`);
  }
  if (!provider.models.some((model) => model.id === ref.model)) {
    throw configurationError(`${label} identifies an unknown configured model`);
  }
  return ref;
}

function firstProviderDefault(
  providers: readonly ProviderProfile[],
): string | undefined {
  for (const provider of providers) {
    if (provider.defaultModel !== undefined) {
      return `${provider.id}/${provider.defaultModel}`;
    }
  }
  return undefined;
}

function distinctModelRefs(
  models: readonly ModelRef[],
  defaultModel: ModelRef,
): ModelRef[] {
  const seen = new Set([formatModelReference(defaultModel)]);
  const result: ModelRef[] = [];
  for (const model of models) {
    const key = formatModelReference(model);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function parseEnvironmentFallbacks(value: string): readonly string[] {
  if (value.trim().length === 0) return [];
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw configurationError("WISH_FALLBACK_MODELS contains an empty model reference");
  }
  return items;
}

function parseEnvironmentInteger(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw configurationError(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw configurationError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw configurationError("Invalid Models JSON configuration");
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw configurationError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw configurationError(`${path} must be an array`);
  return value;
}

function knownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw configurationError(`${path} contains unknown field "${unknown}"`);
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw configurationError(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path);
}

function optionalStringArray(
  value: unknown,
  path: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return array(value, path).map((item, index) =>
    requiredString(item, `${path}[${index}]`)
  );
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw configurationError(`${path} must be a boolean`);
  return value;
}

function identifier(value: string, path: string): string {
  if (!IDENTIFIER.test(value)) {
    throw configurationError(`${path} contains unsupported characters`);
  }
  return value;
}

function modelIdentifier(value: string, path: string): string {
  requiredString(value, path);
  if (value.includes(",")) {
    throw configurationError(`${path} cannot contain a comma`);
  }
  return value;
}

function environmentName(value: unknown, path: string): string {
  const name = requiredString(value, path);
  if (!ENVIRONMENT_NAME.test(name)) {
    throw configurationError(`${path} must be an environment variable name`);
  }
  return name;
}

function normalizeHeaderName(value: string, path: string): string {
  if (!HEADER_NAME.test(value)) {
    throw configurationError(`${path} must be a valid HTTP header name`);
  }
  return value.toLowerCase();
}

function endpoint(value: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(`${path} must be an absolute HTTP endpoint`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 || parsed.password.length > 0 ||
    parsed.search.length > 0 || parsed.hash.length > 0
  ) {
    throw configurationError(`${path} must be a credential-free HTTP endpoint`);
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw configurationError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw configurationError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw configurationError(`${path} must be a non-negative finite number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(value, path);
}

function rejectDuplicates(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw configurationError(`${label} "${value}" is duplicated`);
    seen.add(value);
  }
}

function freezeJsonRecord(
  value: Record<string, unknown>,
  path: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      freezeJsonValue(item, `${path}.${key}`),
    ]),
  ));
}

function freezeJsonValue(value: unknown, path: string): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) =>
      freezeJsonValue(item, `${path}[${index}]`)
    ));
  }
  if (value !== null && typeof value === "object") {
    return freezeJsonRecord(record(value, path), path);
  }
  throw configurationError(`${path} must contain only JSON-compatible values`);
}

function configurationError(message: string): ModelsConfigurationError {
  return new ModelsConfigurationError(message);
}
