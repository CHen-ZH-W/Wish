import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { ModelAdapterFactory } from "./types.js";

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

function register(ctx: Context, protocol: string, factory: ModelAdapterFactory): void {
  const work = new PluginWorkOwner(ctx, { code: "model_adapter", codeReload: true });
  ctx.models.register(protocol, input => {
    work.assertAttached();
    const model = factory(input);
    return { stream: (request, options) => work.stream(() => model.stream(request, options)) };
  });
}

/** Independent protocol plugins; Models.register owns caller-fiber cleanup. */
export const OpenAIChatCompletions = {
  name: "openai-chat-completions-model-adapter",
  inject,
  apply(ctx: Context): void {
    register(ctx,
      OPENAI_CHAT_COMPLETIONS_PROTOCOL,
      createOpenAICompatibleAdapter,
    );
  },
};

export const OpenAIResponses = {
  name: "openai-responses-model-adapter",
  inject,
  apply(ctx: Context): void {
    register(ctx, OPENAI_RESPONSES_PROTOCOL, createOpenAIResponsesAdapter);
  },
};

export const AnthropicMessages = {
  name: "anthropic-messages-model-adapter",
  inject,
  apply(ctx: Context): void {
    register(ctx, ANTHROPIC_MESSAGES_PROTOCOL, createAnthropicMessagesAdapter);
  },
};
