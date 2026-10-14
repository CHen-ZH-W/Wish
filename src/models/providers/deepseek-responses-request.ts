import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelRequest,
} from "../../core/model/model.js";
import type {
  DeveloperRoleStrategy,
  ModelAdapterFactoryInput,
} from "../types.js";

export class DeepSeekResponsesRequestError extends Error {}

/** Map Wish's stable instruction channel and ordered Context to DeepSeek Responses. */
export function mapDeepSeekResponsesRequest(
  request: ModelRequest,
  input: ModelAdapterFactoryInput,
): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly authorityDegraded: boolean;
} {
  const instructions = request.instructions
    .map((instruction) => instruction.content)
    .filter((content) => content.length > 0)
    .join("\n\n");
  const hasDeveloperMessages = request.messages.some((message) =>
    message.role === "developer"
  );
  const roleMode = input.model.developerRoleMode;
  if (hasDeveloperMessages && roleMode === "unsupported") {
    throw new DeepSeekResponsesRequestError(
      "Configured model does not support developer messages",
    );
  }
  if (
    hasDeveloperMessages && roleMode === "native" &&
    !input.model.spec.developerRole
  ) {
    throw new DeepSeekResponsesRequestError(
      "Configured model cannot use native developer messages",
    );
  }

  const messages = request.messages.flatMap((message) =>
    mapMessage(message, roleMode)
  );
  const tools = request.tools.map((tool) => {
    let parameters: unknown;
    try {
      parameters = JSON.parse(tool.inputSchemaJson) as unknown;
    } catch {
      throw new DeepSeekResponsesRequestError(
        `Tool "${tool.name}" has invalid inputSchemaJson`,
      );
    }
    if (!isRecord(parameters)) {
      throw new DeepSeekResponsesRequestError(
        `Tool "${tool.name}" schema must be an object`,
      );
    }
    return Object.freeze({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
    });
  });

  const compatibility = input.model.request;
  const maxOutputTokens = request.maxOutputTokens ??
    input.model.spec.defaultMaxOutputTokens;
  const defaultEffort = input.model.spec.reasoningControl?.format ===
      "deepseek-responses"
    ? input.model.spec.reasoningControl.defaultEffort
    : undefined;
  const body: Record<string, unknown> = {
    ...compatibility.extraBody,
    model: request.model.model,
    ...(instructions.length === 0 ? {} : { instructions }),
    input: Object.freeze(messages),
    stream: true,
    ...(defaultEffort === undefined
      ? {}
      : { reasoning: Object.freeze({ effort: defaultEffort }) }),
    ...(tools.length === 0 ? {} : { tools: Object.freeze(tools) }),
    ...(request.temperature === undefined || !compatibility.supportsTemperature
      ? {}
      : { temperature: request.temperature }),
    ...(maxOutputTokens === undefined
      ? {}
      : { [compatibility.maxTokensField]: maxOutputTokens }),
  };
  if (request.reasoningEffort !== undefined) {
    const control = input.model.spec.reasoningControl;
    if (
      control?.format !== "deepseek-responses" ||
      !control.efforts.some((effort) => effort === request.reasoningEffort)
    ) {
      throw new DeepSeekResponsesRequestError(
        "Requested reasoning effort is not supported by this model",
      );
    }
    body.reasoning = Object.freeze({ effort: request.reasoningEffort });
  }
  return Object.freeze({
    body: Object.freeze(body),
    // Native DeepSeek developer items are user-equivalent. Explicit system
    // fallback preserves the host instruction authority instead.
    authorityDegraded: hasDeveloperMessages && roleMode !== "system-fallback",
  });
}

function mapMessage(
  message: ModelMessage,
  roleMode: DeveloperRoleStrategy,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.role === "tool") return mapToolResult(message);
  if (message.role === "assistant") return mapAssistant(message);
  if (message.toolCallId !== undefined) {
    throw new DeepSeekResponsesRequestError(
      `DeepSeek Responses ${message.role} message cannot have toolCallId`,
    );
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    throw new DeepSeekResponsesRequestError(
      `DeepSeek Responses ${message.role} message cannot have Tool Calls`,
    );
  }
  const role = message.role === "developer" && roleMode === "system-fallback"
    ? "system"
    : message.role;
  return Object.freeze([Object.freeze({
    role,
    content: mapInputContent(
      message,
      role === "user" || role === "developer",
    ),
  })]);
}

function mapAssistant(
  message: ModelMessage,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.toolCallId !== undefined) {
    throw new DeepSeekResponsesRequestError(
      "DeepSeek Responses assistant message cannot have toolCallId",
    );
  }
  const items: Array<Readonly<Record<string, unknown>>> = [];
  if (message.reasoningContent !== undefined && message.reasoningContent.length > 0) {
    items.push(Object.freeze({
      type: "reasoning",
      content: Object.freeze([Object.freeze({
        type: "reasoning_text",
        text: message.reasoningContent,
      })]),
    }));
  }
  const content = mapAssistantContent(message);
  if (content.length > 0) {
    items.push(Object.freeze({
      type: "message",
      role: "assistant",
      content,
    }));
  }
  for (const call of message.toolCalls ?? []) {
    validateArgumentsJson(call.argumentsJson, call.id);
    items.push(Object.freeze({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.argumentsJson,
    }));
  }
  if (items.length === 0) {
    items.push(Object.freeze({
      type: "message",
      role: "assistant",
      content: Object.freeze([Object.freeze({
        type: "output_text",
        text: "",
      })]),
    }));
  }
  return Object.freeze(items);
}

function mapToolResult(
  message: ModelMessage,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.toolCallId === undefined) {
    throw new DeepSeekResponsesRequestError(
      "DeepSeek Responses Tool Result requires toolCallId",
    );
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    throw new DeepSeekResponsesRequestError(
      "DeepSeek Responses Tool Result cannot have Tool Calls",
    );
  }
  const parts = message.contentParts ?? [];
  const hasImages = parts.some((part) => part.type === "image_url");
  const output = hasImages
    ? mapInputContent(message, true)
    : [message.content, ...parts
      .filter((part): part is Extract<ModelMessageContentPart, { type: "text" }> =>
        part.type === "text"
      )
      .map((part) => part.text)]
      .filter((text) => text.length > 0)
      .join("\n");
  return Object.freeze([Object.freeze({
    type: "function_call_output",
    call_id: message.toolCallId,
    output,
  })]);
}

function mapInputContent(
  message: ModelMessage,
  allowImages: boolean,
): readonly Readonly<Record<string, unknown>>[] {
  const content: Array<Readonly<Record<string, unknown>>> = [];
  if (message.content.length > 0) {
    content.push(Object.freeze({ type: "input_text", text: message.content }));
  }
  for (const part of message.contentParts ?? []) {
    if (part.type === "text") {
      content.push(Object.freeze({ type: "input_text", text: part.text }));
    } else {
      if (!allowImages) {
        throw new DeepSeekResponsesRequestError(
          `DeepSeek Responses ${message.role} message cannot contain images`,
        );
      }
      content.push(Object.freeze({
        type: "input_image",
        image_url: part.imageUrl.url,
        detail: part.imageUrl.detail ?? "auto",
      }));
    }
  }
  if (content.length === 0) {
    content.push(Object.freeze({ type: "input_text", text: "" }));
  }
  return Object.freeze(content);
}

function mapAssistantContent(
  message: ModelMessage,
): readonly Readonly<Record<string, unknown>>[] {
  const content: Array<Readonly<Record<string, unknown>>> = [];
  if (message.content.length > 0) {
    content.push(Object.freeze({ type: "output_text", text: message.content }));
  }
  for (const part of message.contentParts ?? []) {
    if (part.type === "image_url") {
      throw new DeepSeekResponsesRequestError(
        "DeepSeek Responses assistant message cannot contain images",
      );
    }
    content.push(Object.freeze({ type: "output_text", text: part.text }));
  }
  return Object.freeze(content);
}

function validateArgumentsJson(value: string, id: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw new DeepSeekResponsesRequestError(
      `Tool Call "${id}" has malformed argumentsJson`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
