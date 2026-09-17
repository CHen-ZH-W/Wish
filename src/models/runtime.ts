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
import { ModelRequestTokenCounter } from "./input-tokens.js";
import {
  ANTHROPIC_MESSAGES_PROTOCOL,
} from "./providers/anthropic-messages.js";
import {
  createAnthropicMessagesRequestTokenizer,
} from "./providers/anthropic-messages-tokens.js";
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
import type { SessionReasoningPort } from "./session-reasoning.js";

export interface ConfiguredModelOptions {
  readonly configuration: ModelsConfiguration;
  readonly registry: ModelAdapterRegistry;
  readonly fetch?: ModelFetch;
  /** A function permits credential rotation without rebuilding public configuration. */
  readonly environment?: ModelEnvironment | (() => ModelEnvironment);
  /** Host-only credential resolver. Values never enter public Models configuration. */
  readonly credential?: (reference: string) => string | undefined;
  /** A late-bound default is sampled only when a caller asks to start a new Run. */
  readonly defaultModel?: () => ModelRef | string;
  /** Late-bound user capacity override, sampled whenever context budgeting asks. */
  readonly contextWindowTokens?: (
    reference: ModelRef,
    configured: number | undefined,
  ) => number | undefined;
  /** Late-bound user request limit, independent of the model's supported ceiling. */
  readonly maxOutputTokens?: (
    reference: ModelRef,
    configuredDefault: number | undefined,
  ) => number | undefined;
}

export interface ConfiguredModelStackOptions extends ConfiguredModelOptions {
  readonly usageEstimator: UsageEstimator;
  readonly retry?: Pick<
    RetryingModelOptions,
    "baseRetryDelayMs" | "maxRetryDelayMs" | "random"
  >;
}

export type ConfiguredModelRequestTokenCounterOptions = Pick<
  ConfiguredModelOptions,
  "configuration" | "fetch" | "environment" | "credential"
>;

export interface ConfiguredModelStack {
  readonly configuredModel: ConfiguredModel;
  readonly measuredModel: UsageResolvingModel;
  readonly model: RetryingModel;
}

/** Complete Models graph consumed by an Application composition. */
export interface ConfiguredModelResources extends ConfiguredModelStack {
  readonly requestCounter: ModelRequestTokenCounter;
  /** Optional for standalone embeddings without a durable Session selection owner. */
  readonly sessionReasoning?: SessionReasoningPort;
}

/** Narrow request/runtime view consumed outside the Models owner. */
export type ModelDependencies = Pick<
  ConfiguredModelResources,
  "configuredModel" | "model" | "requestCounter"
> & Pick<ConfiguredModelResources, "sessionReasoning">;

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

/** Build both the request path and its preflight token-counting companion. */
export function createConfiguredModelResources(
  options: ConfiguredModelStackOptions,
): ConfiguredModelResources {
  const stack = createConfiguredModelStack(options);
  const requestCounter = createConfiguredModelRequestTokenCounter(options);
  return Object.freeze({ ...stack, requestCounter });
}

/** Register every exact-count tokenizer supported by the configured protocols. */
export function createConfiguredModelRequestTokenCounter(
  options: ConfiguredModelRequestTokenCounterOptions,
): ModelRequestTokenCounter {
  const counter = new ModelRequestTokenCounter();
  const fetch = resolveModelFetch(options.fetch);
  const environment = resolveModelEnvironment(options.environment);
  for (const provider of options.configuration.providers) {
    if (provider.protocol !== ANTHROPIC_MESSAGES_PROTOCOL) continue;
    for (const spec of provider.models) {
      const resolved = resolveConfiguredModel(options.configuration, {
        provider: provider.id,
        model: spec.id,
      });
      counter.register(
        resolved.ref,
        createAnthropicMessagesRequestTokenizer({
          model: resolved,
          headers: () => resolveInvocationHeaders(resolved, environment(), options.credential),
          fetch,
        }),
      );
    }
  }
  return counter;
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
    this.fetch = resolveModelFetch(options.fetch);
    this.environment = resolveModelEnvironment(options.environment);
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

    const maxOutputTokens = request.maxOutputTokens ?? this.options.maxOutputTokens?.(
      freezeModelRef(resolved.ref),
      resolved.spec.defaultMaxOutputTokens,
    ) ?? resolved.spec.defaultMaxOutputTokens;
    if (maxOutputTokens !== undefined && (
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
      (resolved.spec.maxOutputTokens !== undefined && maxOutputTokens > resolved.spec.maxOutputTokens)
    )) {
      yield errorEvent({
        code: "invalid_request",
        message: "Requested maxOutputTokens must be a positive integer within the model's supported output limit",
        retryable: false,
      });
      return;
    }

    let headers: Readonly<Record<string, string>>;
    try {
      headers = resolveInvocationHeaders(resolved, this.environment(), this.options.credential);
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
        { ...request, model: resolved.ref, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
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
    if (this.options.defaultModel !== undefined) {
      return freezeModelRef(resolveConfiguredModel(
        this.options.configuration,
        this.options.defaultModel(),
      ).ref);
    }
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
    const resolved = this.resolve(reference);
    return this.options.contextWindowTokens?.(freezeModelRef(resolved.ref), resolved.spec.contextWindowTokens)
      ?? resolved.spec.contextWindowTokens;
  }

  getPrice(reference: ModelRef | string): ModelPrice | undefined {
    return this.getModelSpec(reference).price;
  }
}

function resolveModelFetch(fetch: ModelFetch | undefined): ModelFetch {
  const available = fetch ?? globalThis.fetch;
  if (typeof available !== "function") {
    throw new Error("Configured Models require an injectable fetch implementation");
  }
  return available.bind(globalThis) as ModelFetch;
}

function resolveModelEnvironment(
  environment: ConfiguredModelOptions["environment"],
): () => ModelEnvironment {
  return typeof environment === "function"
    ? environment
    : () => environment ?? {};
}

function resolveInvocationHeaders(
  model: ResolvedModel,
  environment: ModelEnvironment,
  credential: ConfiguredModelOptions["credential"],
): Readonly<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(model.headers)) {
    const resolved = resolveHeaderValue(value, environment);
    safeHeaderValue(resolved, name);
    entries.push([name, resolved]);
  }
  const headers: Record<string, string> = Object.fromEntries(entries);
  applyAuthentication(headers, model.auth, environment, credential);
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
  credential: ConfiguredModelOptions["credential"],
): void {
  if (auth.type === "none") return;
  const value = requiredCredential(environment, credential, auth.apiKeyEnv);
  safeHeaderValue(value, auth.apiKeyEnv);
  if (auth.type === "bearer") {
    headers.authorization = `Bearer ${value}`;
    return;
  }
  headers[auth.headerName ?? "x-api-key"] = value;
}

function requiredCredential(
  environment: ModelEnvironment,
  resolve: ConfiguredModelOptions["credential"],
  name: string,
): string {
  const inherited = environment[name];
  const value = typeof inherited === "string" && inherited.length > 0
    ? inherited
    : resolve?.(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialResolutionError(
      `Missing required Model credential from environment variable ${name}`,
    );
  }
  return value;
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
