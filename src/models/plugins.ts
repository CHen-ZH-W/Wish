import type { Context } from "@deepseek-ai/cordis";

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

const inject = ["models"];

/** Independent protocol plugins; Models.register owns caller-fiber cleanup. */
export const OpenAIChatCompletions = {
  name: "openai-chat-completions-model-adapter",
  inject,
  apply(ctx: Context): void {
    ctx.models.register(
      OPENAI_CHAT_COMPLETIONS_PROTOCOL,
      createOpenAICompatibleAdapter,
    );
  },
};

export const OpenAIResponses = {
  name: "openai-responses-model-adapter",
  inject,
  apply(ctx: Context): void {
    ctx.models.register(OPENAI_RESPONSES_PROTOCOL, createOpenAIResponsesAdapter);
  },
};

export const AnthropicMessages = {
  name: "anthropic-messages-model-adapter",
  inject,
  apply(ctx: Context): void {
    ctx.models.register(ANTHROPIC_MESSAGES_PROTOCOL, createAnthropicMessagesAdapter);
  },
};
