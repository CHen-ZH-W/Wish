import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import {
  loadModelsConfiguration,
  loadModelsConfigurationFile,
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
  readonly fetch?: ModelFetch;
  readonly usageEstimator?: UsageEstimator;
  readonly retry?: ConfiguredModelStackOptions["retry"];
}

/** Cordis owner of configuration, protocol registration, and request resources. */
export class Models extends Service {
  static readonly inject = ["launch"];
  static readonly Config = Config;

  readonly registry = new ModelAdapterRegistry();
  readonly usageEstimator = new TokenizerUsageEstimator();

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
    return createConfiguredModelResources({
      configuration,
      registry: this.registry,
      usageEstimator: input.usageEstimator ?? this.usageEstimator,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      environment: input.environment ?? (() => this.ctx.launch.environment),
      ...(input.retry === undefined ? {} : { retry: input.retry }),
    });
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
