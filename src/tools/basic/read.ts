import { constants } from "node:fs";
import {
  access as fsAccess,
  open as fsOpen,
  readFile as fsReadFile,
} from "node:fs/promises";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition, ToolInputParseResult } from "../../core/tools/tool.js";
import type { BasicToolContext } from "../support/context.js";
import { resolveReadPath } from "../support/path.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "../support/truncate.js";

export interface ReadToolInput {
  readonly path: string;
  /** First line to read, using one-based line numbers. */
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadTextContent {
  readonly type: "text";
  readonly text: string;
}

export type ReadImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export interface ReadImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: ReadImageMimeType;
}

export type ReadToolContent = ReadTextContent | ReadImageContent;

export interface ReadToolOutput {
  readonly path: string;
  readonly content: readonly ReadToolContent[];
  readonly truncation?: TruncationResult;
  readonly nextOffset?: number;
}

export interface ReadOperations {
  access(absolutePath: string, signal?: AbortSignal): Promise<void>;
  readFile(absolutePath: string, signal?: AbortSignal): Promise<Buffer>;
  detectImageMimeType?(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<ReadImageMimeType | null | undefined>;
}

/** Optional image backend used to resize or re-encode inline image data. */
export interface ReadImageProcessor {
  process(
    image: ReadImageContent,
    signal?: AbortSignal,
  ): Promise<ReadImageContent | null>;
}

export interface ReadToolOptions {
  readonly operations?: ReadOperations;
  readonly imageProcessor?: ReadImageProcessor;
}

const READ_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to read, relative to cwd or absolute",
    },
    offset: {
      type: "integer",
      minimum: 1,
      description: "First line to read, using one-based line numbers",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: "Maximum number of lines to read",
    },
  },
  required: ["path"],
  additionalProperties: false,
});

const DEFAULT_READ_OPERATIONS: ReadOperations = {
  async access(absolutePath) {
    await fsAccess(absolutePath, constants.R_OK);
  },
  async readFile(absolutePath, signal) {
    return signal === undefined
      ? await fsReadFile(absolutePath)
      : await fsReadFile(absolutePath, { signal });
  },
  async detectImageMimeType(absolutePath, signal) {
    throwIfAborted(signal);
    const handle = await fsOpen(absolutePath, "r");
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      throwIfAborted(signal);
      return detectSupportedImageMimeType(header.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  },
};

export function createReadTool(
  options: ReadToolOptions = {},
): ToolDefinition<"read", ReadToolInput, ReadToolOutput, BasicToolContext> {
  const operations = options.operations ?? DEFAULT_READ_OPERATIONS;
  return {
    name: "read",
    description:
      `Read a UTF-8 text file or supported image. Text output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; use offset to continue.`,
    inputSchemaJson: READ_INPUT_SCHEMA,
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse: parseReadInput,
    resolveCapabilities(input, context) {
      return {
        requirements: [{
          capability: "filesystem.read",
          paths: [resolveReadPath(input.path, context.cwd)],
        }],
      };
    },
    async execute(input, context, grant, signal) {
      const absolutePath = resolveReadPath(input.path, context.cwd);
      throwIfAborted(signal);
      assertReadGrant(grant, absolutePath);

      try {
        await operations.access(absolutePath, signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        throw fileOperationError("access", input.path, error);
      }

      throwIfAborted(signal);
      assertReadGrant(grant, absolutePath);
      let mimeType: ReadImageMimeType | null | undefined;
      try {
        mimeType = await operations.detectImageMimeType?.(absolutePath, signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        throw fileOperationError("inspect", input.path, error);
      }

      throwIfAborted(signal);
      assertReadGrant(grant, absolutePath);
      let buffer: Buffer;
      try {
        buffer = await operations.readFile(absolutePath, signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        throw fileOperationError("read", input.path, error);
      }
      throwIfAborted(signal);

      return mimeType === null || mimeType === undefined
        ? readText(input, buffer)
        : await readImage({
            path: input.path,
            buffer,
            mimeType,
            modelSupportsImages: context.modelSupportsImages,
            imageProcessor: options.imageProcessor,
            signal,
          });
    },
  };
}

function parseReadInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<ReadToolInput> {
  const unsupported = Object.keys(input).filter(
    (key) => key !== "path" && key !== "offset" && key !== "limit",
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `Read input contains unsupported field "${unsupported[0]}"`,
    };
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    return { ok: false, message: "Read path must be a non-empty string" };
  }
  if (input.offset !== undefined && !isPositiveInteger(input.offset)) {
    return { ok: false, message: "Read offset must be a positive integer" };
  }
  if (input.limit !== undefined && !isPositiveInteger(input.limit)) {
    return { ok: false, message: "Read limit must be a positive integer" };
  }
  return {
    ok: true,
    input: {
      path: input.path,
      ...(input.offset === undefined ? {} : { offset: input.offset as number }),
      ...(input.limit === undefined ? {} : { limit: input.limit as number }),
    },
  };
}

function readText(input: ReadToolInput, buffer: Buffer): ReadToolOutput {
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const startLine = input.offset ?? 1;
  const startIndex = startLine - 1;
  if (startIndex >= lines.length) {
    throw new ToolExecutionError(
      "invalid_input",
      `Offset ${startLine} is beyond end of file (${lines.length} lines total)`,
    );
  }

  const endIndex = input.limit === undefined
    ? lines.length
    : Math.min(startIndex + input.limit, lines.length);
  const selected = lines.slice(startIndex, endIndex).join("\n");
  const truncation = truncateHead(selected);
  let outputText = truncation.content;
  let nextOffset: number | undefined;

  if (truncation.firstLineExceedsLimit) {
    const lineSize = formatSize(Buffer.byteLength(lines[startIndex] ?? "", "utf8"));
    outputText =
      `[Line ${startLine} is ${lineSize}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash to inspect this line.]`;
  } else if (truncation.truncated) {
    const endLine = startLine + truncation.outputLines - 1;
    nextOffset = endLine + 1;
    outputText += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLine}-${endLine} of ${lines.length}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLine}-${endLine} of ${lines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
  } else if (endIndex < lines.length) {
    const remaining = lines.length - endIndex;
    nextOffset = endIndex + 1;
    outputText +=
      `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  }

  return {
    path: input.path,
    content: [{ type: "text", text: outputText }],
    ...(truncation.truncated ? { truncation } : {}),
    ...(nextOffset === undefined ? {} : { nextOffset }),
  };
}

async function readImage(input: {
  readonly path: string;
  readonly buffer: Buffer;
  readonly mimeType: ReadImageMimeType;
  readonly modelSupportsImages: boolean | undefined;
  readonly imageProcessor: ReadImageProcessor | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<ReadToolOutput> {
  const note = `Read image file [${input.mimeType}]`;
  if (input.modelSupportsImages === false) {
    return {
      path: input.path,
      content: [{
        type: "text",
        text:
          `${note}\n[Current model does not support images. The image was omitted.]`,
      }],
    };
  }

  let image: ReadImageContent = {
    type: "image",
    data: input.buffer.toString("base64"),
    mimeType: input.mimeType,
  };
  if (input.imageProcessor !== undefined) {
    throwIfAborted(input.signal);
    try {
      const processed = await input.imageProcessor.process(image, input.signal);
      throwIfAborted(input.signal);
      if (processed === null) {
        return {
          path: input.path,
          content: [{
            type: "text",
            text:
              `${note}\n[Image omitted: the image processor could not produce an inline image.]`,
          }],
        };
      }
      image = validateProcessedImage(processed);
    } catch (error: unknown) {
      throwIfAborted(input.signal);
      if (error instanceof ToolExecutionError) throw error;
      throw new ToolExecutionError(
        "execution_failed",
        `Could not process image ${input.path}: ${errorMessage(error)}`,
      );
    }
  }

  return {
    path: input.path,
    content: [
      { type: "text", text: `Read image file [${image.mimeType}]` },
      image,
    ],
  };
}

function validateProcessedImage(image: ReadImageContent): ReadImageContent {
  if (
    image?.type !== "image" ||
    typeof image.data !== "string" ||
    !isSupportedImageMimeType(image.mimeType)
  ) {
    throw new ToolExecutionError(
      "execution_failed",
      "Image processor returned an invalid image",
    );
  }
  return image;
}

function detectSupportedImageMimeType(buffer: Buffer): ReadImageMimeType | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function isSupportedImageMimeType(value: unknown): value is ReadImageMimeType {
  return value === "image/jpeg" || value === "image/png" ||
    value === "image/gif" || value === "image/webp";
}

function assertReadGrant(
  grant: ToolAuthorizationGrant,
  absolutePath: string,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName: "read" });
  const authorized = grant.capabilities.requirements.some((requirement) =>
    requirement.capability === "filesystem.read" &&
    requirement.paths.includes(absolutePath)
  );
  if (!authorized) {
    throw new Error(
      `Tool authorization Grant ${grant.grantId} does not allow reading "${absolutePath}"`,
    );
  }
}

function fileOperationError(
  operation: "access" | "inspect" | "read",
  path: string,
  error: unknown,
): ToolExecutionError {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ToolExecutionError(
      "not_found",
      `Could not ${operation} ${path}: file not found`,
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ToolExecutionError(
      "permission_denied",
      `Could not ${operation} ${path}: permission denied`,
    );
  }
  return new ToolExecutionError(
    "execution_failed",
    `Could not ${operation} ${path}: ${errorMessage(error)}`,
  );
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Operation aborted",
  );
}
