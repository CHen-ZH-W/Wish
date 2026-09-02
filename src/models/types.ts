import type { DeveloperRoleMode, Model, ModelRef } from "../core/model/model.js";

export type ModelApiProtocol = string;

export type ProviderAuth =
  | {
      readonly type: "bearer";
      readonly apiKeyEnv: string;
    }
  | {
      readonly type: "x-api-key";
      readonly apiKeyEnv: string;
      readonly headerName?: string;
    }
  | {
      readonly type: "none";
    };

export type ProviderHeaderValue =
  | string
  | {
      readonly fromEnv: string;
    };

export type DeveloperRoleStrategy = DeveloperRoleMode | "unsupported";

export type MaxTokensField = "max_tokens" | "max_completion_tokens";

export interface ModelRequestCompatibility {
  readonly streamUsage: boolean;
  readonly supportsTemperature: boolean;
  readonly maxTokensField: MaxTokensField;
  readonly extraBody: Readonly<Record<string, unknown>>;
}

export interface ProviderCatalogConfiguration {
  readonly enabled: boolean;
  readonly endpoint?: string;
}

export interface ModelPrice {
  readonly version: string;
  readonly currency: string;
  readonly effectiveFrom?: string;
  readonly inputPerMillionTokens: number;
  readonly cachedInputPerMillionTokens?: number;
  readonly cacheWriteInputPerMillionTokens?: number;
  readonly outputPerMillionTokens: number;
}

export type ModelAvailability =
  | "active"
  | "deprecated"
  | "unavailable"
  | "unknown";

export interface ModelInputCapabilities {
  readonly text: boolean;
  readonly image: boolean;
}

export interface ModelSpec {
  readonly id: string;
  readonly name?: string;
  readonly status: ModelAvailability;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly input: ModelInputCapabilities;
  readonly reasoning: boolean;
  readonly toolCalling: boolean;
  readonly developerRole: boolean;
  readonly price?: ModelPrice;
  /** Provider settings overridden only for this model. */
  readonly baseUrl?: string;
  readonly auth?: ProviderAuth;
  readonly headers?: Readonly<Record<string, ProviderHeaderValue>>;
  readonly developerRoleMode?: DeveloperRoleStrategy;
  readonly request?: PartialModelRequestCompatibility;
}

export interface PartialModelRequestCompatibility {
  readonly streamUsage?: boolean;
  readonly supportsTemperature?: boolean;
  readonly maxTokensField?: MaxTokensField;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface ProviderProfile {
  readonly id: string;
  readonly protocol: ModelApiProtocol;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers: Readonly<Record<string, ProviderHeaderValue>>;
  readonly defaultModel?: string;
  readonly developerRoleMode: DeveloperRoleStrategy;
  readonly request: ModelRequestCompatibility;
  readonly catalog: ProviderCatalogConfiguration;
  readonly models: readonly ModelSpec[];
}

export interface ModelsConfiguration {
  readonly schemaVersion: 1;
  readonly providers: readonly ProviderProfile[];
  readonly defaultModel: ModelRef;
  readonly fallbackModels: readonly ModelRef[];
  readonly maxRetries: number;
}

/** Provider and model settings merged without resolving any secret values. */
export interface ResolvedModel {
  readonly ref: ModelRef;
  readonly protocol: ModelApiProtocol;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers: Readonly<Record<string, ProviderHeaderValue>>;
  readonly developerRoleMode: DeveloperRoleStrategy;
  readonly request: ModelRequestCompatibility;
  readonly catalog: ProviderCatalogConfiguration;
  readonly spec: ModelSpec;
}

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;

export type ModelFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Internal invocation configuration; headers may contain resolved credentials. */
export interface ModelAdapterFactoryInput {
  readonly model: ResolvedModel;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: ModelFetch;
}

export type ModelAdapterFactory = (input: ModelAdapterFactoryInput) => Model;

export interface ModelConfigurationSource {
  /** Parsed JSON value or its serialized representation. */
  readonly json?: unknown;
  readonly environment?: ModelEnvironment;
  readonly availableProtocols?: readonly string[];
}
