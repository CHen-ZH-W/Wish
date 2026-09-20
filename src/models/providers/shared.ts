import type {
  ModelError,
  ModelStreamEvent,
} from "../../core/model/model.js";

export class StreamParseError extends Error {}

export function abortedError(reason: unknown): ModelError {
  return {
    code: "aborted",
    message: reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.length > 0
        ? reason
        : "Model request was aborted",
    retryable: false,
  };
}

export function networkError(
  error: unknown,
  signal: AbortSignal | undefined,
  message: string,
): ModelError {
  if (signal?.aborted === true || isAbortError(error)) {
    return abortedError(signal?.reason);
  }
  return { code: "network_error", message, retryable: true };
}

export function errorEvent(error: ModelError): ModelStreamEvent {
  return Object.freeze({ type: "error" as const, error: Object.freeze(error) });
}

export function contextOverflow(code: string, message: string): boolean {
  return /context[_ -]length|context window|too many tokens|maximum context/iu.test(
    `${code} ${message}`,
  );
}

export function safeProviderMessage(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

export function tokenCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StreamParseError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

export function stableProviderCreatedAt(
  current: number | undefined,
  value: unknown,
  path: string,
): number {
  const seconds = tokenCount(value, `${path} seconds`);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new StreamParseError(`${path} milliseconds must be a safe integer`);
  }
  if (current !== undefined && current !== milliseconds) {
    throw new StreamParseError(`${path} must remain stable across the stream`);
  }
  return milliseconds;
}

export function jsonRecord(value: string, path: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown, path);
  } catch (error: unknown) {
    if (error instanceof StreamParseError) throw error;
    throw new StreamParseError(`${path} is malformed JSON`);
  }
}

export function optionalRecord(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, path);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamParseError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function freezeModelRef(
  model: { readonly provider: string; readonly model: string },
) {
  return Object.freeze({ provider: model.provider, model: model.model });
}

export function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
