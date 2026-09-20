import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import {
  formatModelReference,
  loadModelsConfiguration,
  loadModelsConfigurationFile,
  resolveConfiguredModel,
} from "./config.js";
import {
  createConfiguredModelResources,
  type ConfiguredModelResources,
  type ConfiguredModelStackOptions,
} from "./runtime.js";
import {
  ModelAdapterRegistry,
  type ModelAdapterRegistration,
} from "./registry.js";
import {
  createDefaultModelPricingResolver,
  type ModelPricingPolicy,
  type ModelPricingPolicyRegistration,
} from "./pricing.js";
import { canonicalModelSelection } from "./selection.js";
import { DomainSessionReasoningStore, SessionReasoningSelections, type SessionReasoningStore } from "./session-reasoning.js";
import type {
  ModelAdapterFactory,
  ModelEnvironment,
  ModelFetch,
  ModelsConfiguration,
} from "./types.js";
import {
  TokenizerUsageEstimator,
  type UsageEstimator,
} from "./usage.js";
import type { SettingsScope } from "../settings/types.js";
import type {} from "../settings/service.js";
import type {} from "../storage/binding.js";
import type { StorageBackendLease } from "../storage/backend.js";

/** Loader-owned Models source and selection settings. */
export interface Config {
  readonly configurationPath?: string;
  readonly configurationJson?: string;
  readonly model?: string;
  readonly fallbackModels?: string[] | undefined;
  readonly maxRetries?: number;
}

export const Config: s<Config> = s.object({
  configurationPath: s.string(),
  configurationJson: s.string(),
  model: s.string(),
  fallbackModels: s.union([
    s.array(s.string()),
    s.const(undefined),
  ]),
  maxRetries: s.number().step(1).min(0),
});

export interface LoadModelsInput {
  readonly dataDirectory: string;
  readonly configurationPath?: string;
  readonly configurationJson?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly maxRetries?: number;
}

export interface OpenModelsInput {
  readonly environment?: ModelEnvironment | (() => ModelEnvironment);
  readonly credential?: (reference: string) => string | undefined;
  readonly fetch?: ModelFetch;
  readonly usageEstimator?: UsageEstimator;
  readonly retry?: ConfiguredModelStackOptions["retry"];
  readonly attemptLedger?: ConfiguredModelStackOptions["attemptLedger"];
}

/** Cordis owner of configuration, protocol registration, and request resources. */
export class Models extends Service {
  static readonly inject = ["launch"];
  static readonly Config = Config;

  readonly registry = new ModelAdapterRegistry();
  readonly pricing = createDefaultModelPricingResolver();
  readonly usageEstimator = new TokenizerUsageEstimator();
  private selection: {
    readonly signature: string;
    readonly available: ReadonlySet<string>;
    readonly deploymentDefault: string;
    readonly scope: SettingsScope;
  } | undefined;
  private reasoningStore: SessionReasoningStore | undefined;
  private reasoningLease: StorageBackendLease | undefined;

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, "models");
  }

  /** Register an Adapter for exactly the lifetime of the calling plugin fiber. */
  register(
    protocol: string,
    factory: ModelAdapterFactory,
  ): ModelAdapterRegistration {
    const registration = this.registry.register(protocol, factory);
    try {
      this.ctx.effect(() => () => {
        registration.unregister();
      }, `models.register(${JSON.stringify(registration.protocol)})`);
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }

  /** Register a Provider Pricing policy for exactly the calling plugin fiber lifetime. */
  registerPricing(policy: ModelPricingPolicy): ModelPricingPolicyRegistration {
    const registration = this.pricing.register(policy);
    try {
      this.ctx.effect(() => () => {
        registration.unregister();
      }, `models.registerPricing(${JSON.stringify(registration.provider)})`);
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }

  /** Resolve public Models configuration from service defaults plus one surface override. */
  async load(input: LoadModelsInput): Promise<ModelsConfiguration> {
    const configurationJson = input.configurationJson ??
      this.config.configurationJson;
    const model = input.model ?? this.config.model;
    const fallbackModels = input.fallbackModels ?? this.config.fallbackModels;
    const maxRetries = input.maxRetries ?? this.config.maxRetries;
    const environment = selectionEnvironment({
      ...(configurationJson === undefined ? {} : { configurationJson }),
      ...(model === undefined ? {} : { model }),
      ...(fallbackModels === undefined ? {} : { fallbackModels }),
      ...(maxRetries === undefined ? {} : { maxRetries }),
    });
    const configuredPath = input.configurationPath ?? this.config.configurationPath;
    const configurationPath = configuredPath === undefined
      ? undefined
      : resolve(this.ctx.launch.cwd, configuredPath);
    const defaultPath = join(resolve(input.dataDirectory), "models.json");
    const availableProtocols = this.registry.protocols();

    if (configurationPath !== undefined) {
      return loadModelsConfigurationFile({
        path: configurationPath,
        environment,
        availableProtocols,
      });
    }
    if (environment.WISH_MODELS_JSON !== undefined) {
      return loadModelsConfiguration({ environment, availableProtocols });
    }
    if (await fileExists(defaultPath)) {
      return loadModelsConfigurationFile({
        path: defaultPath,
        environment,
        availableProtocols,
      });
    }
    return loadModelsConfiguration({ environment, availableProtocols });
  }

  /** Build one Application-facing graph while keeping construction in Models. */
  open(
    configuration: ModelsConfiguration,
    input: OpenModelsInput = {},
  ): ConfiguredModelResources {
    const preferences = this.modelPreferences(configuration);
    const credentials = this.ctx.get("credentials");
    const resources = createConfiguredModelResources({
      configuration,
      registry: this.registry,
      pricing: this.pricing,
      usageEstimator: input.usageEstimator ?? this.usageEstimator,
      ...(preferences === undefined ? {} : {
        defaultModel: preferences.defaultModel,
        contextWindowTokens: preferences.contextWindowTokens,
        maxOutputTokens: preferences.maxOutputTokens,
      }),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      environment: input.environment ?? (() => this.ctx.launch.environment),
      credential: input.credential ?? (reference => credentials?.resolve(reference)),
      ...(input.retry === undefined ? {} : { retry: input.retry }),
      ...(input.attemptLedger === undefined
        ? {}
        : { attemptLedger: input.attemptLedger }),
    });
    if (this.ctx.launch.surface !== "webui") return resources;
    const backend = this.ctx.get("storageBackend");
    if (backend === undefined) return resources;
    if (this.reasoningStore === undefined) {
      const lease = backend.acquire(backend.id, { kv: { list: false } });
      try {
        this.reasoningStore = new DomainSessionReasoningStore(lease, backend.id);
        this.reasoningLease = lease;
        this.ctx.effect(() => () => { this.reasoningLease?.release(); this.reasoningLease = undefined; }, "Models Session reasoning storage");
      } catch (error) { lease.release(); throw error; }
    }
    return Object.freeze({ ...resources, sessionReasoning: new SessionReasoningSelections(resources.configuredModel, this.reasoningStore) });
  }

  /** Register one Models-owned setting without making Settings know model semantics. */
  private modelPreferences(
    configuration: ModelsConfiguration,
  ): {
    readonly defaultModel: () => string;
    readonly contextWindowTokens: (reference: import("../core/model/model.js").ModelRef, configured: number | undefined) => number | undefined;
    readonly maxOutputTokens: (reference: import("../core/model/model.js").ModelRef, configuredDefault: number | undefined) => number | undefined;
  } | undefined {
    const settings = this.ctx.get("settings");
    if (this.ctx.launch.surface !== "webui" || settings === undefined) return undefined;
    const options = Object.freeze(configuration.providers.flatMap(provider => provider.models.map(model => {
      const reference = formatModelReference({ provider: provider.id, model: model.id });
      const resolved = resolveConfiguredModel(configuration, reference);
      const apiKeyEnv = resolved.auth.type === "none" ? undefined : resolved.auth.apiKeyEnv;
      return Object.freeze({
        value: reference,
        label: `${model.name === undefined ? reference : `${model.name} (${reference})`}${model.status === "deprecated" ? " · 已退役兼容名" : ""}`,
        attributes: Object.freeze({
          provider: provider.id,
          model: model.id,
          ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
          ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
          ...(model.defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens: model.defaultMaxOutputTokens }),
          ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
        }),
      });
    })));
    const deploymentDefault = formatModelReference(configuration.defaultModel);
    const signature = JSON.stringify([deploymentDefault, options]);
    const available = new Set(options.map(option => option.value));
    const outputCeilings = new Map(configuration.providers.flatMap(provider => provider.models.map(model => [
      formatModelReference({ provider: provider.id, model: model.id }), model.maxOutputTokens,
    ] as const)));
    if (this.selection === undefined) {
      this.selection = Object.freeze({
        signature,
        available,
        deploymentDefault,
        scope: settings.register(this.ctx, {
          namespace: "models",
          title: "默认模型",
          applies: "next-request",
          fields: [{
            key: "default-model",
            label: "新运行使用的模型",
            description: "只影响保存后启动的新运行；当前运行、排队消息和 Provider 凭据不会改变。",
            type: "enum",
            options,
            default: deploymentDefault,
            allowStale: true,
          }, {
            key: "context-window-overrides",
            label: "模型上下文窗口覆盖",
            description: "按模型保存的运行时覆盖，仅由模型配置界面编辑。",
            type: "string",
            default: "{}",
            maxLength: 4096,
            hidden: true,
          }, {
            key: "max-output-token-overrides",
            label: "模型请求最大输出覆盖",
            description: "按模型保存的单次请求输出上限，仅由模型配置界面编辑。",
            type: "string",
            default: "{}",
            maxLength: 4096,
            hidden: true,
          }],
          validate: value => {
            validateContextWindowOverrides(value["context-window-overrides"], available);
            validateMaxOutputTokenOverrides(value["max-output-token-overrides"], outputCeilings);
          },
        }),
      });
    } else if (this.selection.signature !== signature) {
      throw new Error("Models settings cannot represent multiple configurations in one process generation");
    }
    const selection = this.selection;
    return Object.freeze({
      defaultModel: () => {
        const value = selection.scope.get()["default-model"];
        const canonical = typeof value === "string"
          ? canonicalModelSelection(value, selection.available)
          : undefined;
        return canonical !== undefined && selection.available.has(canonical)
          ? canonical
          : selection.deploymentDefault;
      },
      contextWindowTokens: (reference: import("../core/model/model.js").ModelRef, configured: number | undefined) => {
        const raw = selection.scope.get()["context-window-overrides"];
        const overrides = parseTokenOverrides(raw);
        return overrides[formatModelReference(reference)] ?? configured;
      },
      maxOutputTokens: (reference: import("../core/model/model.js").ModelRef, configuredDefault: number | undefined) => {
        const raw = selection.scope.get()["max-output-token-overrides"];
        const overrides = parseTokenOverrides(raw);
        return overrides[formatModelReference(reference)] ?? configuredDefault;
      },
    });
  }
}

function parseTokenOverrides(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Readonly<Record<string, number>>;
  } catch { return {}; }
}

function validateContextWindowOverrides(value: unknown, available: ReadonlySet<string>): void {
  if (typeof value !== "string") throw new Error("invalid context window overrides");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid context window overrides"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 64) {
    throw new Error("invalid context window overrides");
  }
  for (const [reference, tokens] of Object.entries(parsed)) {
    if (!available.has(reference) || !Number.isSafeInteger(tokens) || (tokens as number) < 1024 || (tokens as number) > 10_000_000) {
      throw new Error("invalid context window override");
    }
  }
}

function validateMaxOutputTokenOverrides(value: unknown, ceilings: ReadonlyMap<string, number | undefined>): void {
  if (typeof value !== "string") throw new Error("invalid max output token overrides");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid max output token overrides"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 64) {
    throw new Error("invalid max output token overrides");
  }
  for (const [reference, tokens] of Object.entries(parsed)) {
    const ceiling = ceilings.get(reference);
    if (!ceilings.has(reference) || !Number.isSafeInteger(tokens) || (tokens as number) < 1 ||
      (tokens as number) > 10_000_000 || (ceiling !== undefined && (tokens as number) > ceiling)) {
      throw new Error(`invalid max output token override for ${reference}`);
    }
  }
}

function selectionEnvironment(input: {
  readonly configurationJson?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly maxRetries?: number;
}): ModelEnvironment {
  return Object.freeze({
    ...(input.configurationJson === undefined
      ? {}
      : { WISH_MODELS_JSON: input.configurationJson }),
    ...(input.model === undefined ? {} : { WISH_MODEL: input.model }),
    ...(input.fallbackModels === undefined
      ? {}
      : { WISH_FALLBACK_MODELS: input.fallbackModels.join(",") }),
    ...(input.maxRetries === undefined
      ? {}
      : { WISH_MODEL_MAX_RETRIES: String(input.maxRetries) }),
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (
      error !== null && typeof error === "object" && "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) return false;
    throw new Error(`Models configuration path cannot be inspected: ${path}`);
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    models: Models;
  }
}

export default Models;
