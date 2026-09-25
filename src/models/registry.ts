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

import { ModelAdapterRegistry } from "./adapter-registry.js";
export { ModelAdapterRegistry, type ModelAdapterRegistration } from "./adapter-registry.js";

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
