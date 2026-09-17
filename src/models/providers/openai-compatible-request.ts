import type {
  ModelMessage,
  ModelMessageContentPart,
  ModelRequest,
} from "../../core/model/model.js";
import type {
  DeveloperRoleStrategy,
  ModelAdapterFactoryInput,
} from "../types.js";

export class OpenAIRequestError extends Error {}

export function mapOpenAIRequest(
  request: ModelRequest,
  input: ModelAdapterFactoryInput,
): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly authorityDegraded: boolean;
} {
  const hasDeveloper = request.messages.some((message) => message.role === "developer");
  const roleMode = input.model.developerRoleMode;
  if (hasDeveloper && roleMode === "unsupported") {
    throw new OpenAIRequestError(
      "Configured model does not support developer messages",
    );
  }
  if (hasDeveloper && roleMode === "native" && !input.model.spec.developerRole) {
    throw new OpenAIRequestError(
      "Configured model cannot use native developer messages",
    );
  }
  const messages = request.messages.map((message) =>
    mapMessage(message, roleMode)
  );
  const tools = request.tools.map((tool) => {
    let parameters: unknown;
    try {
      parameters = JSON.parse(tool.inputSchemaJson) as unknown;
    } catch {
      throw new OpenAIRequestError(`Tool "${tool.name}" has invalid inputSchemaJson`);
    }
    if (!isRecord(parameters)) {
      throw new OpenAIRequestError(`Tool "${tool.name}" schema must be an object`);
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
      },
    };
  });
  const compatibility = input.model.request;
  const maxOutputTokens = request.maxOutputTokens ?? input.model.spec.defaultMaxOutputTokens;
  const body: Record<string, unknown> = {
    ...compatibility.extraBody,
    model: request.model.model,
    messages,
    stream: true,
    ...(tools.length === 0 ? {} : { tools }),
    ...(request.temperature === undefined || !compatibility.supportsTemperature
      ? {}
      : { temperature: request.temperature }),
    ...(maxOutputTokens === undefined
      ? {}
      : { [compatibility.maxTokensField]: maxOutputTokens }),
    ...(compatibility.streamUsage
      ? { stream_options: { include_usage: true } }
      : {}),
  };
  if (request.reasoningEffort !== undefined) {
    const control = input.model.spec.reasoningControl;
    if (control?.format !== "deepseek-chat" || !control.efforts.some(effort => effort === request.reasoningEffort)) {
      throw new OpenAIRequestError("Requested reasoning effort is not supported by this model");
    }
    if (request.reasoningEffort === "none") {
      body.thinking = { type: "disabled" };
      delete body.reasoning_effort;
    } else {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = request.reasoningEffort;
    }
  }
  return Object.freeze({
    body: Object.freeze(body),
    authorityDegraded: hasDeveloper && roleMode === "system-fallback",
  });
}

function mapMessage(
  message: ModelMessage,
  roleMode: DeveloperRoleStrategy,
): Readonly<Record<string, unknown>> {
  const role = message.role === "developer" && roleMode === "system-fallback"
    ? "system"
    : message.role;
  return Object.freeze({
    role,
    content: mapContent(message.content, message.contentParts),
    ...(message.toolCallId === undefined
      ? {}
      : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined || message.toolCalls.length === 0
      ? {}
      : {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.argumentsJson },
        })),
      }),
    ...(message.reasoningContent === undefined
      ? {}
      : { reasoning_content: message.reasoningContent }),
  });
}

function mapContent(
  content: string,
  parts: readonly ModelMessageContentPart[] | undefined,
): string | readonly Readonly<Record<string, unknown>>[] {
  if (parts === undefined || parts.length === 0) return content;
  const mapped: Array<Readonly<Record<string, unknown>>> = [];
  if (content.length > 0) mapped.push(Object.freeze({ type: "text", text: content }));
  for (const part of parts) {
    if (part.type === "text") {
      mapped.push(Object.freeze({ type: "text", text: part.text }));
    } else {
      mapped.push(Object.freeze({
        type: "image_url",
        image_url: Object.freeze({ ...part.imageUrl }),
      }));
    }
  }
  return Object.freeze(mapped);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
