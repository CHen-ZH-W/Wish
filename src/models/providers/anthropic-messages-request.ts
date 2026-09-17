import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelRequest,
} from "../../core/model/model.js";
import type { ModelAdapterFactoryInput } from "../types.js";

export class AnthropicRequestError extends Error {}

export function mapAnthropicRequest(
  request: ModelRequest,
  input: ModelAdapterFactoryInput,
): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly authorityDegraded: boolean;
} {
  const hasDeveloper = request.messages.some((message) => message.role === "developer");
  if (hasDeveloper && input.model.developerRoleMode !== "system-fallback") {
    throw new AnthropicRequestError(
      "Anthropic developer messages require explicit system-fallback configuration",
    );
  }
  const system: Array<Readonly<Record<string, unknown>>> = [];
  const conversation: Array<{
    role: "user" | "assistant";
    content: Array<Readonly<Record<string, unknown>>>;
  }> = [];
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      if (message.content.length > 0) {
        system.push(Object.freeze({ type: "text", text: message.content }));
      }
      for (const part of message.contentParts ?? []) {
        if (part.type !== "text") {
          throw new AnthropicRequestError("Anthropic system messages cannot contain images");
        }
        system.push(Object.freeze({ type: "text", text: part.text }));
      }
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = mapConversationContent(message);
    const previous = conversation.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else conversation.push({ role, content: [...content] });
  }
  if (conversation.length === 0) {
    throw new AnthropicRequestError("Anthropic request requires a user or assistant message");
  }
  const tools = request.tools.map((tool) => {
    let inputSchema: unknown;
    try {
      inputSchema = JSON.parse(tool.inputSchemaJson) as unknown;
    } catch {
      throw new AnthropicRequestError(`Tool "${tool.name}" has invalid inputSchemaJson`);
    }
    if (!isRecord(inputSchema)) {
      throw new AnthropicRequestError(`Tool "${tool.name}" schema must be an object`);
    }
    return Object.freeze({
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema,
    });
  });
  const compatibility = input.model.request;
  const body: Record<string, unknown> = {
    ...compatibility.extraBody,
    model: request.model.model,
    messages: conversation.map((message) => Object.freeze({
      role: message.role,
      content: Object.freeze(message.content),
    })),
    max_tokens: request.maxOutputTokens ?? input.model.spec.defaultMaxOutputTokens ??
      Math.min(4096, input.model.spec.maxOutputTokens ?? 4096),
    stream: true,
    ...(system.length === 0 ? {} : { system: Object.freeze(system) }),
    ...(tools.length === 0 ? {} : { tools: Object.freeze(tools) }),
    ...(request.temperature === undefined || !compatibility.supportsTemperature
      ? {}
      : { temperature: request.temperature }),
  };
  return Object.freeze({
    body: Object.freeze(body),
    authorityDegraded: hasDeveloper,
  });
}

function mapConversationContent(
  message: ModelMessage,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.role === "tool") {
    if (message.toolCallId === undefined) {
      throw new AnthropicRequestError("Anthropic Tool Result requires toolCallId");
    }
    return Object.freeze([Object.freeze({
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    })]);
  }
  const blocks: Array<Readonly<Record<string, unknown>>> = [];
  if (message.content.length > 0) {
    blocks.push(Object.freeze({ type: "text", text: message.content }));
  }
  for (const part of message.contentParts ?? []) {
    if (part.type === "text") {
      blocks.push(Object.freeze({ type: "text", text: part.text }));
    } else {
      if (message.role === "assistant") {
        throw new AnthropicRequestError("Anthropic assistant messages cannot contain images");
      }
      blocks.push(mapImage(part));
    }
  }
  for (const call of message.toolCalls ?? []) {
    let toolInput: unknown;
    try {
      toolInput = JSON.parse(call.argumentsJson) as unknown;
    } catch {
      throw new AnthropicRequestError(`Tool Call "${call.id}" has malformed argumentsJson`);
    }
    blocks.push(Object.freeze({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: toolInput,
    }));
  }
  if (blocks.length === 0) blocks.push(Object.freeze({ type: "text", text: "" }));
  return Object.freeze(blocks);
}

function mapImage(
  part: Extract<ModelMessageContentPart, { readonly type: "image_url" }>,
): Readonly<Record<string, unknown>> {
  const data = /^data:([^;,]+);base64,(.+)$/u.exec(part.imageUrl.url);
  if (data !== null) {
    return Object.freeze({
      type: "image",
      source: Object.freeze({
        type: "base64",
        media_type: data[1],
        data: data[2],
      }),
    });
  }
  let url: URL;
  try {
    url = new URL(part.imageUrl.url);
  } catch {
    throw new AnthropicRequestError("Anthropic image URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AnthropicRequestError("Anthropic image URL must use HTTP or a base64 data URL");
  }
  return Object.freeze({
    type: "image",
    source: Object.freeze({ type: "url", url: part.imageUrl.url }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
