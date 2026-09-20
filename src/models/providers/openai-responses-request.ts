import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelRequest,
} from "../../core/model/model.js";
import type {
  DeveloperRoleStrategy,
  ModelAdapterFactoryInput,
} from "../types.js";

export class OpenAIResponsesRequestError extends Error {}

export function mapOpenAIResponsesRequest(
  request: ModelRequest,
  input: ModelAdapterFactoryInput,
): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly authorityDegraded: boolean;
} {
  const instructionMessages: readonly ModelMessage[] = Object.freeze(
    (request.instructions ?? []).map((instruction) => Object.freeze({
      role: instruction.role,
      content: instruction.content,
    })),
  );
  const modelMessages = [...instructionMessages, ...request.messages];
  const hasDeveloper = modelMessages.some((message) =>
    message.role === "developer"
  );
  const roleMode = input.model.developerRoleMode;
  if (hasDeveloper && roleMode === "unsupported") {
    throw new OpenAIResponsesRequestError(
      "Configured model does not support developer messages",
    );
  }
  if (hasDeveloper && roleMode === "native" && !input.model.spec.developerRole) {
    throw new OpenAIResponsesRequestError(
      "Configured model cannot use native developer messages",
    );
  }

  const messages = modelMessages.flatMap((message) =>
    mapMessage(message, roleMode)
  );
  const tools = request.tools.map((tool) => {
    let parameters: unknown;
    try {
      parameters = JSON.parse(tool.inputSchemaJson) as unknown;
    } catch {
      throw new OpenAIResponsesRequestError(
        `Tool "${tool.name}" has invalid inputSchemaJson`,
      );
    }
    if (!isRecord(parameters)) {
      throw new OpenAIResponsesRequestError(
        `Tool "${tool.name}" schema must be an object`,
      );
    }
    return Object.freeze({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict: false,
    });
  });

  const compatibility = input.model.request;
  const maxOutputTokens = request.maxOutputTokens ??
    input.model.spec.defaultMaxOutputTokens;
  const body: Record<string, unknown> = {
    ...(input.model.spec.reasoning
      ? { reasoning: { effort: "high", summary: "auto" } }
      : {}),
    ...compatibility.extraBody,
    model: request.model.model,
    input: Object.freeze(messages),
    stream: true,
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
    if (control?.format !== "openai-responses" || !control.efforts.some(effort => effort === request.reasoningEffort)) {
      throw new OpenAIResponsesRequestError("Requested reasoning effort is not supported by this model");
    }
    body.reasoning = { effort: request.reasoningEffort, summary: "auto" };
  }
  return Object.freeze({
    body: Object.freeze(body),
    authorityDegraded: hasDeveloper && roleMode === "system-fallback",
  });
}

function mapMessage(
  message: ModelMessage,
  roleMode: DeveloperRoleStrategy,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.role === "tool") return mapToolResult(message);
  if (message.role === "assistant") return mapAssistant(message);
  if (message.toolCallId !== undefined) {
    throw new OpenAIResponsesRequestError(
      `OpenAI Responses ${message.role} message cannot have toolCallId`,
    );
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    throw new OpenAIResponsesRequestError(
      `OpenAI Responses ${message.role} message cannot have Tool Calls`,
    );
  }
  const role = message.role === "developer" && roleMode === "system-fallback"
    ? "system"
    : message.role;
  const allowImages = role === "user";
  return Object.freeze([Object.freeze({
    role,
    content: mapInputContent(message, allowImages),
  })]);
}

function mapAssistant(
  message: ModelMessage,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.toolCallId !== undefined) {
    throw new OpenAIResponsesRequestError(
      "OpenAI Responses assistant message cannot have toolCallId",
    );
  }
  const items: Array<Readonly<Record<string, unknown>>> = [];
  const content = mapAssistantContent(message);
  if (content.length > 0) {
    items.push(Object.freeze({
      type: "message",
      role: "assistant",
      status: "completed",
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
      status: "completed",
      content: Object.freeze([{ type: "output_text", text: "", annotations: [] }]),
    }));
  }
  return Object.freeze(items);
}

function mapToolResult(
  message: ModelMessage,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.toolCallId === undefined) {
    throw new OpenAIResponsesRequestError(
      "OpenAI Responses Tool Result requires toolCallId",
    );
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    throw new OpenAIResponsesRequestError(
      "OpenAI Responses Tool Result cannot have Tool Calls",
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
        throw new OpenAIResponsesRequestError(
          `OpenAI Responses ${message.role} message cannot contain images`,
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
    content.push(Object.freeze({
      type: "output_text",
      text: message.content,
      annotations: Object.freeze([]),
    }));
  }
  for (const part of message.contentParts ?? []) {
    if (part.type === "image_url") {
      throw new OpenAIResponsesRequestError(
        "OpenAI Responses assistant message cannot contain images",
      );
    }
    content.push(Object.freeze({
      type: "output_text",
      text: part.text,
      annotations: Object.freeze([]),
    }));
  }
  return Object.freeze(content);
}

function validateArgumentsJson(value: string, id: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw new OpenAIResponsesRequestError(
      `Tool Call "${id}" has malformed argumentsJson`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
