import type { AgentLoopToolResultRenderer } from "../../core/agent-loop/agent-loop.js";
import type {
  ModelMessage,
  ModelMessageContentPart,
} from "../../core/model/model.js";
import type { ToolResult } from "../../core/tools/scheduler.js";

import type { EditToolOutput } from "../../filesystem/consumers/model-tools/edit.js";
import type {
  ReadImageContent,
  ReadTextContent,
  ReadToolContent,
} from "../../filesystem/consumers/model-tools/read.js";
import type { WriteToolOutput } from "../../filesystem/consumers/model-tools/write.js";

interface ContentOutput {
  readonly content: readonly ReadToolContent[];
}

interface RenderedContent {
  readonly text: string;
  readonly images: readonly Extract<
    ModelMessageContentPart,
    { readonly type: "image_url" }
  >[];
}

/**
 * Model-facing rendering for the five Basic Tools.
 *
 * Execution, archiving, Context admission, and Provider wire conversion remain
 * owned by their existing layers. This renderer only converts one completed
 * Core ToolResult into the corresponding provider-neutral Tool message.
 */
export function createBasicToolResultRenderer<Payload = unknown>():
  AgentLoopToolResultRenderer<Payload> {
  const renderer: AgentLoopToolResultRenderer<Payload> = {
    render({ result }) {
      return renderBasicToolResult(result);
    },
  };
  return Object.freeze(renderer);
}

export function renderBasicToolResult(result: ToolResult): ModelMessage {
  const rendered = result.ok
    ? renderSuccessfulOutput(result.toolName, result.output)
    : { text: `Tool failed [${result.error.code}]: ${result.error.message}`, images: [] };

  return Object.freeze({
    role: "tool" as const,
    content: rendered.text,
    toolCallId: result.callId,
    ...(rendered.images.length === 0
      ? {}
      : { contentParts: Object.freeze(rendered.images) }),
  });
}

function renderSuccessfulOutput(toolName: string, output: unknown): RenderedContent {
  if (toolName === "write" && isWriteToolOutput(output)) {
    return {
      text: `Successfully wrote ${output.bytesWritten} bytes to ${output.path}`,
      images: [],
    };
  }
  if (toolName === "edit" && isEditToolOutput(output)) {
    return {
      text:
        `Successfully replaced ${output.editsApplied} block(s) in ${output.path}.`,
      images: [],
    };
  }
  if (isContentOutput(output)) {
    return renderContent(output.content, toolName === "read");
  }
  return { text: serializeOutput(output), images: [] };
}

function renderContent(
  content: readonly ReadToolContent[],
  allowImages: boolean,
): RenderedContent {
  const text: string[] = [];
  const images: Array<Extract<
    ModelMessageContentPart,
    { readonly type: "image_url" }
  >> = [];

  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }
    if (allowImages) {
      images.push(Object.freeze({
        type: "image_url" as const,
        imageUrl: Object.freeze({
          url: `data:${part.mimeType};base64,${part.data}`,
        }),
      }));
    }
  }

  return {
    text: text.length === 0 ? "(no output)" : text.join("\n"),
    images,
  };
}

function serializeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  return serialized === undefined ? "(no output)" : serialized;
}

function isContentOutput(output: unknown): output is ContentOutput {
  return isRecord(output) && Array.isArray(output.content) &&
    output.content.every(isToolContent);
}

function isToolContent(value: unknown): value is ReadToolContent {
  if (!isRecord(value)) return false;
  if (value.type === "text") return isTextContent(value);
  return value.type === "image" && isImageContent(value);
}

function isTextContent(value: unknown):
  value is ReadTextContent {
  return isRecord(value) && typeof value.text === "string";
}

function isImageContent(value: unknown):
  value is ReadImageContent {
  return isRecord(value) && typeof value.data === "string" &&
    isSupportedImageMimeType(value.mimeType);
}

function isWriteToolOutput(output: unknown): output is WriteToolOutput {
  return isRecord(output) && typeof output.path === "string" &&
    Number.isSafeInteger(output.bytesWritten) &&
    (output.bytesWritten as number) >= 0;
}

function isEditToolOutput(output: unknown): output is EditToolOutput {
  return isRecord(output) && typeof output.path === "string" &&
    Number.isSafeInteger(output.editsApplied) &&
    (output.editsApplied as number) >= 1 && typeof output.diff === "string";
}

function isSupportedImageMimeType(value: unknown):
  value is ReadImageContent["mimeType"] {
  return value === "image/jpeg" || value === "image/png" ||
    value === "image/gif" || value === "image/webp";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
