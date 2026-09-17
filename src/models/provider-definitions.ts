import type {
  ModelRequestCompatibility,
  ProviderAuth,
  ProviderCatalogConfiguration,
  ProviderHeaderValue,
} from "./types.js";

export interface BuiltInProviderDefinition {
  readonly id: string;
  readonly protocol:
    | "openai-chat-completions"
    | "openai-responses"
    | "anthropic-messages";
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly headers: Readonly<Record<string, ProviderHeaderValue>>;
  readonly defaultModel?: string;
  readonly developerRoleMode: "native" | "system-fallback";
  readonly request: ModelRequestCompatibility;
  readonly catalog: ProviderCatalogConfiguration;
}

const OPENAI_COMPATIBLE_REQUEST = Object.freeze({
  streamUsage: true,
  supportsTemperature: true,
  maxTokensField: "max_completion_tokens" as const,
  extraBody: Object.freeze({}),
});

const OPENAI_NONSTANDARD_REQUEST = Object.freeze({
  ...OPENAI_COMPATIBLE_REQUEST,
  maxTokensField: "max_tokens" as const,
});

const ANTHROPIC_COMPATIBLE_REQUEST = Object.freeze({
  streamUsage: false,
  supportsTemperature: true,
  maxTokensField: "max_tokens" as const,
  extraBody: Object.freeze({}),
});

function bearer(apiKeyEnv: string): ProviderAuth {
  return Object.freeze({ type: "bearer" as const, apiKeyEnv });
}

function xApiKey(apiKeyEnv: string): ProviderAuth {
  return Object.freeze({ type: "x-api-key" as const, apiKeyEnv });
}

function provider(
  definition:
    & Omit<
      BuiltInProviderDefinition,
      "headers" | "developerRoleMode" | "catalog"
    >
    & Partial<Pick<BuiltInProviderDefinition, "developerRoleMode">>,
): BuiltInProviderDefinition {
  return Object.freeze({
    ...definition,
    headers: Object.freeze({}),
    developerRoleMode: definition.developerRoleMode ?? "system-fallback" as const,
    catalog: Object.freeze({ enabled: false }),
  });
}

/**
 * Stable transport and credential metadata. Model names, limits, capabilities,
 * and prices are generated separately from public model metadata sources.
 */
export const BUILT_IN_PROVIDER_DEFINITIONS: readonly BuiltInProviderDefinition[] =
  Object.freeze([
    provider({
      id: "deepseek",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com",
      auth: bearer("DEEPSEEK_API_KEY"),
      defaultModel: "deepseek-flash",
      request: Object.freeze({
        streamUsage: true,
        supportsTemperature: false,
        maxTokensField: "max_tokens" as const,
        extraBody: Object.freeze({
          thinking: Object.freeze({ type: "enabled" }),
          reasoning_effort: "high",
        }),
      }),
    }),
    provider({
      id: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      auth: xApiKey("ANTHROPIC_API_KEY"),
      request: ANTHROPIC_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "openai",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      auth: bearer("OPENAI_API_KEY"),
      developerRoleMode: "native",
      request: Object.freeze({
        streamUsage: true,
        supportsTemperature: true,
        maxTokensField: "max_output_tokens" as const,
        extraBody: Object.freeze({ store: false }),
      }),
    }),
    provider({
      id: "openrouter",
      protocol: "openai-chat-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: bearer("OPENROUTER_API_KEY"),
      request: OPENAI_NONSTANDARD_REQUEST,
    }),
    provider({
      id: "vercel-ai-gateway",
      protocol: "anthropic-messages",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      auth: bearer("AI_GATEWAY_API_KEY"),
      request: ANTHROPIC_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "groq",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.groq.com/openai/v1",
      auth: bearer("GROQ_API_KEY"),
      request: OPENAI_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "cerebras",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.cerebras.ai/v1",
      auth: bearer("CEREBRAS_API_KEY"),
      request: OPENAI_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "xai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.x.ai/v1",
      auth: bearer("XAI_API_KEY"),
      request: OPENAI_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "zai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      auth: bearer("ZAI_API_KEY"),
      request: OPENAI_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "huggingface",
      protocol: "openai-chat-completions",
      baseUrl: "https://router.huggingface.co/v1",
      auth: bearer("HF_TOKEN"),
      request: OPENAI_NONSTANDARD_REQUEST,
    }),
    provider({
      id: "fireworks",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      auth: bearer("FIREWORKS_API_KEY"),
      request: OPENAI_NONSTANDARD_REQUEST,
    }),
    provider({
      id: "opencode",
      protocol: "openai-chat-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      auth: bearer("OPENCODE_API_KEY"),
      request: OPENAI_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "opencode-go",
      protocol: "openai-chat-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      auth: bearer("OPENCODE_API_KEY"),
      request: OPENAI_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "minimax",
      protocol: "anthropic-messages",
      baseUrl: "https://api.minimax.io/anthropic/v1",
      auth: xApiKey("MINIMAX_API_KEY"),
      request: ANTHROPIC_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "minimax-cn",
      protocol: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic/v1",
      auth: xApiKey("MINIMAX_CN_API_KEY"),
      request: ANTHROPIC_COMPATIBLE_REQUEST,
    }),
    provider({
      id: "moonshotai",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.moonshot.ai/v1",
      auth: bearer("MOONSHOT_API_KEY"),
      request: OPENAI_NONSTANDARD_REQUEST,
    }),
    provider({
      id: "moonshotai-cn",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.moonshot.cn/v1",
      auth: bearer("MOONSHOT_API_KEY"),
      request: OPENAI_NONSTANDARD_REQUEST,
    }),
  ]);
