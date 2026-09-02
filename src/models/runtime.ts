import type {
  Model,
  ModelError,
  ModelRef,
  ModelRequest,
  ModelStreamEvent,
} from "../core/model/model.js";
import {
  RetryingModel,
  type RetryingModelOptions,
} from "../core/model/model.js";
import {
  ModelsConfigurationError,
  resolveConfiguredModel,
} from "./config.js";
import { ModelAdapterRegistry } from "./registry.js";
import {
  UsageResolvingModel,
  type UsageEstimator,
} from "./usage.js";
import type {
  ModelEnvironment,
  ModelFetch,
  ModelPrice,
  ModelSpec,
  ModelsConfiguration,
  ProviderAuth,
  ProviderHeaderValue,
  ResolvedModel,
} from "./types.js";

export interface ConfiguredModelOptions {
  readonly configuration: ModelsConfiguration;
  readonly registry: ModelAdapterRegistry;
  readonly fetch?: ModelFetch;
  /** A function permits credential rotation without rebuilding public configuration. */
  readonly environment?: ModelEnvironment | (() => ModelEnvironment);
}

export interface ConfiguredModelStackOptions extends ConfiguredModelOptions {
  readonly usageEstimator: UsageEstimator;
  readonly retry?: Pick<
    RetryingModelOptions,
    "baseRetryDelayMs" | "maxRetryDelayMs" | "random"
  >;
}

export interface ConfiguredModelStack {
  readonly configuredModel: ConfiguredModel;
  readonly measuredModel: UsageResolvingModel;
  readonly model: RetryingModel;
}

/** Build the fixed Models decorator order consumed by Core AgentLoop. */
export function createConfiguredModelStack(
  options: ConfiguredModelStackOptions,
): ConfiguredModelStack {
  const configuredModel = new ConfiguredModel(options);
  const measuredModel = new UsageResolvingModel(
    configuredModel,
    options.usageEstimator,
  );
  const model = new RetryingModel(measuredModel, {
    maxRetries: options.configuration.maxRetries,
    fallbackModels: options.configuration.fallbackModels,
    ...options.retry,
  });
  return Object.freeze({ configuredModel, measuredModel, model });
}

/** Routes each request to one configured protocol Adapter without adding retries. */
export class ConfiguredModel implements Model {
  private readonly fetch: ModelFetch;
  private readonly environment: () => ModelEnvironment;
  private defaultModel: ModelRef;

  constructor(private readonly options: ConfiguredModelOptions) {
    for (const provider of options.configuration.providers) {
      if (!options.registry.has(provider.protocol)) {
        throw new ModelsConfigurationError(
          `Provider "${provider.id}" uses unregistered protocol "${provider.protocol}"`,
        );
      }
    }
    this.defaultModel = resolveConfiguredModel(
      options.configuration,
      options.configuration.defaultModel,
    ).ref;
    for (const fallback of options.configuration.fallbackModels) {
      resolveConfiguredModel(options.configuration, fallback);
    }
    const availableFetch = options.fetch ?? globalThis.fetch;
    if (typeof availableFetch !== "function") {
      throw new Error("ConfiguredModel requires an injectable fetch implementation");
    }
    this.fetch = availableFetch.bind(globalThis) as ModelFetch;
    const environment = options.environment;
    this.environment = typeof environment === "function"
      ? environment
      : () => environment ?? {};
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    if (signal?.aborted === true) {
      yield errorEvent(abortedError(signal.reason));
      return;
    }

    let resolved: ResolvedModel;
    try {
      resolved = resolveConfiguredModel(this.options.configuration, request.model);
    } catch {
      yield errorEvent({
        code: "invalid_request",
        message: "Requested model is not configured",
        retryable: false,
      });
      return;
    }

    let headers: Readonly<Record<string, string>>;
    try {
      headers = resolveInvocationHeaders(resolved, this.environment());
    } catch (error: unknown) {
      yield errorEvent({
        code: "missing_api_key",
        message: error instanceof CredentialResolutionError
          ? error.message
          : "Model credentials could not be resolved",
        retryable: false,
      });
      return;
    }

    let adapter: Model;
    try {
      adapter = this.options.registry.create({
        model: resolved,
        headers,
        fetch: this.fetch,
      });
    } catch {
      yield errorEvent({
        code: "provider_error",
        message: "Model Adapter could not be created",
        retryable: false,
      });
      return;
    }

    try {
      for await (const event of adapter.stream(
        { ...request, model: resolved.ref },
        signal,
      )) {
        yield event;
      }
    } catch {
      yield errorEvent(isAborted(signal)
        ? abortedError(signal?.reason)
        : {
          code: "provider_error",
          message: "Model Adapter stream failed",
          retryable: false,
        });
    }
  }

  getDefaultModel(): ModelRef {
    return freezeModelRef(this.defaultModel);
  }

  setDefaultModel(reference: ModelRef | string): ModelRef {
    const resolved = resolveConfiguredModel(this.options.configuration, reference);
    this.defaultModel = resolved.ref;
    return freezeModelRef(this.defaultModel);
  }

  getFallbackModels(): readonly ModelRef[] {
    return Object.freeze(
      this.options.configuration.fallbackModels.map(freezeModelRef),
    );
  }

  resolve(reference: ModelRef | string): ResolvedModel {
    return resolveConfiguredModel(this.options.configuration, reference);
  }

  getModelSpec(reference: ModelRef | string): ModelSpec {
    return this.resolve(reference).spec;
  }

  getContextWindowTokens(reference: ModelRef | string): number | undefined {
    return this.getModelSpec(reference).contextWindowTokens;
  }

  getPrice(reference: ModelRef | string): ModelPrice | undefined {
    return this.getModelSpec(reference).price;
  }
}

function resolveInvocationHeaders(
  model: ResolvedModel,
  environment: ModelEnvironment,
): Readonly<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(model.headers)) {
    const resolved = resolveHeaderValue(value, environment);
    safeHeaderValue(resolved, name);
    entries.push([name, resolved]);
  }
  const headers: Record<string, string> = Object.fromEntries(entries);
  applyAuthentication(headers, model.auth, environment);
  return Object.freeze(headers);
}

function resolveHeaderValue(
  value: ProviderHeaderValue,
  environment: ModelEnvironment,
): string {
  if (typeof value === "string") return value;
  return requiredEnvironment(environment, value.fromEnv);
}

function applyAuthentication(
  headers: Record<string, string>,
  auth: ProviderAuth,
  environment: ModelEnvironment,
): void {
  if (auth.type === "none") return;
  const credential = requiredEnvironment(environment, auth.apiKeyEnv);
  safeHeaderValue(credential, auth.apiKeyEnv);
  if (auth.type === "bearer") {
    headers.authorization = `Bearer ${credential}`;
    return;
  }
  headers[auth.headerName ?? "x-api-key"] = credential;
}

function requiredEnvironment(
  environment: ModelEnvironment,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialResolutionError(
      `Missing required Model credential from environment variable ${name}`,
    );
  }
  return value;
}

function safeHeaderValue(value: string, name: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new CredentialResolutionError(
      `Model header ${name} contains unsupported newline characters`,
    );
  }
}

function errorEvent(error: ModelError): ModelStreamEvent {
  return Object.freeze({
    type: "error" as const,
    error: Object.freeze({ ...error }),
  });
}

function abortedError(reason: unknown): ModelError {
  return {
    code: "aborted",
    message: reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Model request was aborted",
    retryable: false,
  };
}

function freezeModelRef(model: ModelRef): ModelRef {
  return Object.freeze({ provider: model.provider, model: model.model });
}

class CredentialResolutionError extends Error {}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
