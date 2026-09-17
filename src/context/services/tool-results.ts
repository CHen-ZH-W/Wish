import type { AgentLoopToolResultRenderer } from "../../core/agent-loop/agent-loop.js";
import type {
  ContextToolResultArchive,
  ContextToolResultArchiveInput,
  ContextToolResultMessage,
  ContextToolResultPipeline,
  ContextToolResultProjectionInput,
} from "../../core/context/projector.js";
import type {
  ModelMessage,
  ModelMessageContentPart,
} from "../../core/model/model.js";
import type { StepSnapshot } from "../../core/runtime/runtime.js";
import type { ToolCall, ToolResult } from "../../core/tools/scheduler.js";
import type {
  ToolResultArchivePort,
  ToolResultArchiveReference,
} from "../../tools/results/types.js";
import {
  DEFAULT_CONTEXT_TOOL_RESULT_ADMISSION,
  type ContextSessionId,
  type ContextToolResultAdmissionConfiguration,
  type ContextToolResultArchiveReceipt,
} from "../types.js";

export const CONTEXT_TOOL_RESULT_ARCHIVE_RECEIPT_FIELD =
  "__wishContextToolResultArchive" as const;

type ToolResultMessageWithArchiveReceipt = ModelMessage & {
  readonly [CONTEXT_TOOL_RESULT_ARCHIVE_RECEIPT_FIELD]:
    ContextToolResultArchiveReceipt;
};

export interface ToolResultArchiveSessionInput<Payload = unknown> {
  readonly call: ToolCall;
  readonly result: ToolResult;
  readonly snapshot: StepSnapshot<Payload>;
}

export interface ArchivingToolResultRendererOptions<Payload = unknown> {
  readonly archive: ToolResultArchivePort;
  readonly delegate: AgentLoopToolResultRenderer<Payload>;
  readonly resolveSessionId: (
    input: ToolResultArchiveSessionInput<Payload>,
  ) => ContextSessionId;
}

export interface ContextToolResultAdmissionMetadata {
  readonly type: "tool_result_truncated";
  readonly originalChars: number;
  readonly retainedChars: number;
  readonly omittedChars: number;
  readonly headChars: number;
  readonly tailChars: number;
  readonly archive: ToolResultArchiveReference;
}

/**
 * Archives the complete Core ToolResult before a delegate may render away any
 * structure. The receipt rides with AgentLoop memory, not with Provider data.
 */
export function createArchivingToolResultRenderer<Payload = unknown>(
  options: ArchivingToolResultRendererOptions<Payload>,
): AgentLoopToolResultRenderer<Payload> {
  const renderer: AgentLoopToolResultRenderer<Payload> = {
    async render(input) {
      throwIfAborted(input.signal);
      const callId = requireIdentifier(input.call.id, "Tool Call id");
      if (callId !== requireIdentifier(input.result.callId, "Tool Result callId")) {
        throw new Error("Tool Result archive decorator requires matching call ids");
      }
      const sessionId = requireIdentifier(
        options.resolveSessionId({
          call: input.call,
          result: input.result,
          snapshot: input.snapshot,
        }),
        "Context session id",
      );
      const reference = validateArchiveReference(await options.archive.archive({
        sessionId,
        runId: input.snapshot.run.runId,
        userTurnId: input.snapshot.userTurn.userTurnId,
        stepId: input.snapshot.step.stepId,
        result: input.result,
        signal: input.signal,
      }));
      throwIfAborted(input.signal);

      const message = await options.delegate.render(input);
      throwIfAborted(input.signal);
      if (
        message === null ||
        typeof message !== "object" ||
        message.role !== "tool" ||
        message.toolCallId !== callId ||
        typeof message.content !== "string"
      ) {
        throw new Error(
          "Tool Result renderer must preserve role=tool and toolCallId",
        );
      }
      return withContextToolResultArchiveReceipt(message, {
        schemaVersion: 1,
        toolCallId: callId,
        locator: reference.locator,
        hash: reference.hash,
      });
    },
  };
  return Object.freeze(renderer);
}

/**
 * Implements the Core receipt gate and per-result model-visible admission.
 * A result without a proven pre-render archive receipt is copied unchanged.
 */
export class ContextToolResultAdmissionPipeline
  implements ContextToolResultPipeline {
  readonly configuration: ContextToolResultAdmissionConfiguration;

  constructor(
    configuration: ContextToolResultAdmissionConfiguration =
      DEFAULT_CONTEXT_TOOL_RESULT_ADMISSION,
  ) {
    this.configuration = validateConfiguration(configuration);
  }

  archive(input: ContextToolResultArchiveInput): ContextToolResultArchive {
    throwIfAborted(input.signal);
    const receipt = readContextToolResultArchiveReceipt(input.message);
    if (receipt === undefined) {
      return Object.freeze({
        id: `tool-result-unarchived:${encodeURIComponent(input.message.toolCallId)}:` +
          input.messageIndex,
        metadata: Object.freeze({ status: "unavailable" }),
      });
    }
    assertReceiptMatchesMessage(receipt, input.message);
    return Object.freeze({
      id: archiveId(receipt),
      metadata: Object.freeze({
        status: "archived",
        locator: receipt.locator,
        hash: receipt.hash,
      }),
    });
  }

  toModelMessage(
    input: ContextToolResultProjectionInput,
  ): ContextToolResultMessage {
    throwIfAborted(input.signal);
    const clean = copyToolResultMessage(input.message);
    const receipt = readContextToolResultArchiveReceipt(input.message);
    if (receipt === undefined) return clean;

    assertReceiptMatchesMessage(receipt, input.message);
    if (input.archive.id !== archiveId(receipt)) {
      throw new Error("Context Tool Result archive receipt does not match projection");
    }
    const source = modelVisibleResultSource(clean);
    if (source.length <= this.configuration.thresholdChars) return clean;

    const head = source.slice(0, this.configuration.headChars);
    const tail = this.configuration.tailChars === 0
      ? ""
      : source.slice(-this.configuration.tailChars);
    const metadata: ContextToolResultAdmissionMetadata = Object.freeze({
      type: "tool_result_truncated",
      originalChars: source.length,
      retainedChars: head.length + tail.length,
      omittedChars: source.length - head.length - tail.length,
      headChars: head.length,
      tailChars: tail.length,
      archive: Object.freeze({
        locator: receipt.locator,
        hash: receipt.hash,
      }),
    });
    return Object.freeze({
      role: "tool" as const,
      toolCallId: clean.toolCallId,
      content: JSON.stringify({ ...metadata, head, tail }),
    });
  }
}

/** Reads and validates the non-wire receipt carried by AgentLoop memory. */
export function readContextToolResultArchiveReceipt(
  message: ModelMessage,
): ContextToolResultArchiveReceipt | undefined {
  const candidate = (message as ModelMessage & {
    readonly [CONTEXT_TOOL_RESULT_ARCHIVE_RECEIPT_FIELD]?: unknown;
  })[CONTEXT_TOOL_RESULT_ARCHIVE_RECEIPT_FIELD];
  if (candidate === undefined) return undefined;
  if (candidate === null || typeof candidate !== "object") {
    throw new Error("Context Tool Result archive receipt must be an object");
  }
  const value = candidate as Partial<ContextToolResultArchiveReceipt>;
  if (value.schemaVersion !== 1) {
    throw new Error("Unknown Context Tool Result archive receipt schemaVersion");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    toolCallId: requireIdentifier(
      value.toolCallId ?? "",
      "Context Tool Result archive toolCallId",
    ),
    locator: requireIdentifier(
      value.locator ?? "",
      "Context Tool Result archive locator",
    ),
    hash: requireIdentifier(
      value.hash ?? "",
      "Context Tool Result archive hash",
    ),
  });
}

/** Attaches structural archive metadata without changing model-visible fields. */
export function withContextToolResultArchiveReceipt(
  message: ModelMessage,
  receipt: ContextToolResultArchiveReceipt,
): ToolResultMessageWithArchiveReceipt {
  if (message.role !== "tool" || message.toolCallId === undefined) {
    throw new Error("A Tool Result archive receipt requires a tool message");
  }
  const normalized = normalizeReceipt(receipt);
  assertReceiptMatchesMessage(normalized, message as ContextToolResultMessage);
  return Object.freeze({
    ...message,
    [CONTEXT_TOOL_RESULT_ARCHIVE_RECEIPT_FIELD]: normalized,
  });
}

function copyToolResultMessage(
  message: ContextToolResultMessage,
): ContextToolResultMessage {
  const contentParts = message.contentParts === undefined
    ? undefined
    : copyContentParts(message.contentParts);
  return Object.freeze({
    role: "tool" as const,
    content: message.content,
    toolCallId: message.toolCallId,
    ...(contentParts === undefined ? {} : { contentParts }),
  });
}

function copyContentParts(
  parts: readonly ModelMessageContentPart[],
): readonly ModelMessageContentPart[] {
  return Object.freeze(parts.map((part) =>
    part.type === "text"
      ? Object.freeze({ type: "text" as const, text: part.text })
      : Object.freeze({
        type: "image_url" as const,
        imageUrl: Object.freeze({ ...part.imageUrl }),
      })
  ));
}

function modelVisibleResultSource(message: ContextToolResultMessage): string {
  if (message.contentParts === undefined) return message.content;
  return JSON.stringify({
    content: message.content,
    contentParts: message.contentParts,
  });
}

function validateConfiguration(
  configuration: ContextToolResultAdmissionConfiguration,
): ContextToolResultAdmissionConfiguration {
  const thresholdChars = positiveSafeInteger(
    configuration.thresholdChars,
    "Tool Result thresholdChars",
  );
  const headChars = nonNegativeSafeInteger(
    configuration.headChars,
    "Tool Result headChars",
  );
  const tailChars = nonNegativeSafeInteger(
    configuration.tailChars,
    "Tool Result tailChars",
  );
  if (headChars + tailChars >= thresholdChars) {
    throw new Error(
      "Tool Result headChars plus tailChars must be less than thresholdChars",
    );
  }
  return Object.freeze({ thresholdChars, headChars, tailChars });
}

function normalizeReceipt(
  receipt: ContextToolResultArchiveReceipt,
): ContextToolResultArchiveReceipt {
  if (receipt === null || typeof receipt !== "object") {
    throw new Error("Context Tool Result archive receipt must be an object");
  }
  if (receipt.schemaVersion !== 1) {
    throw new Error("Unknown Context Tool Result archive receipt schemaVersion");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    toolCallId: requireIdentifier(
      receipt.toolCallId,
      "Context Tool Result archive toolCallId",
    ),
    locator: requireIdentifier(
      receipt.locator,
      "Context Tool Result archive locator",
    ),
    hash: requireIdentifier(receipt.hash, "Context Tool Result archive hash"),
  });
}

function validateArchiveReference(
  reference: ToolResultArchiveReference,
): ToolResultArchiveReference {
  if (reference === null || typeof reference !== "object") {
    throw new Error("ToolResultArchivePort must return an archive reference");
  }
  return Object.freeze({
    locator: requireIdentifier(reference.locator, "Tool Result archive locator"),
    hash: requireIdentifier(reference.hash, "Tool Result archive hash"),
  });
}

function assertReceiptMatchesMessage(
  receipt: ContextToolResultArchiveReceipt,
  message: ContextToolResultMessage,
): void {
  if (receipt.toolCallId !== message.toolCallId) {
    throw new Error("Context Tool Result archive receipt has the wrong toolCallId");
  }
}

function archiveId(receipt: ContextToolResultArchiveReceipt): string {
  return `tool-result-archived:${receipt.hash}`;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Context Tool Result operation was aborted", {
    cause: signal.reason,
  });
}
