import type { Model } from "../core/model/model.js";
import type {
  ModelAdapterFactory,
  ModelAdapterFactoryInput,
} from "./types.js";
import {
  ANTHROPIC_MESSAGES_PROTOCOL,
  createAnthropicMessagesAdapter,
} from "./providers/anthropic-messages.js";
import {
  createOpenAICompatibleAdapter,
  OPENAI_CHAT_COMPLETIONS_PROTOCOL,
} from "./providers/openai-compatible.js";
import {
  createOpenAIResponsesAdapter,
  OPENAI_RESPONSES_PROTOCOL,
} from "./providers/openai-responses.js";

export class ModelAdapterRegistry {
  private readonly factories = new Map<string, ModelAdapterFactory>();

  register(protocol: string, factory: ModelAdapterFactory): ModelAdapterRegistration {
    const name = requireProtocol(protocol);
    if (typeof factory !== "function") {
      throw new Error(`Model Adapter factory for "${name}" must be a function`);
    }
    if (this.factories.has(name)) {
      throw new Error(`Model Adapter protocol "${name}" is already registered`);
    }
    this.factories.set(name, factory);

    let active = true;
    return Object.freeze({
      protocol: name,
      unregister: () => {
        if (!active) return false;
        active = false;
        if (this.factories.get(name) !== factory) return false;
        this.factories.delete(name);
        return true;
      },
    });
  }

  has(protocol: string): boolean {
    return this.factories.has(requireProtocol(protocol));
  }

  protocols(): readonly string[] {
    return Object.freeze([...this.factories.keys()]);
  }

  create(input: ModelAdapterFactoryInput): Model {
    const protocol = requireProtocol(input.model.protocol);
    const factory = this.factories.get(protocol);
    if (factory === undefined) {
      throw new Error(`Unknown Model Adapter protocol "${protocol}"`);
    }
    const adapter = factory(Object.freeze({
      model: input.model,
      headers: Object.freeze({ ...input.headers }),
      fetch: input.fetch,
    }));
    if (
      adapter === null || typeof adapter !== "object" ||
      typeof adapter.stream !== "function"
    ) {
      throw new Error(`Model Adapter factory for "${protocol}" returned an invalid Model`);
    }
    return adapter;
  }
}

/** Exact ownership handle for one protocol Adapter contribution. */
export interface ModelAdapterRegistration {
  readonly protocol: string;
  unregister(): boolean;
}

export function createDefaultModelAdapterRegistry(): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry();
  registry.register(
    OPENAI_CHAT_COMPLETIONS_PROTOCOL,
    createOpenAICompatibleAdapter,
  );
  registry.register(OPENAI_RESPONSES_PROTOCOL, createOpenAIResponsesAdapter);
  registry.register(ANTHROPIC_MESSAGES_PROTOCOL, createAnthropicMessagesAdapter);
  return registry;
}

function requireProtocol(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error("Model Adapter protocol must be a valid identifier");
  }
  return value;
}
