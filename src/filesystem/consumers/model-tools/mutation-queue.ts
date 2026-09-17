import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

/**
 * Serializes mutations for one canonical path across all filesystem Consumers and Runs in this
 * process. An AbortSignal only cancels waiting; an active mutation must settle
 * before its queue slot is released.
 */
export async function withFileMutationQueue<Output>(
  filePath: string,
  operation: () => Promise<Output> | Output,
  signal?: AbortSignal,
): Promise<Output> {
  const key = mutationQueueKey(filePath);
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const slot = new Promise<void>((resolveSlot) => {
    release = resolveSlot;
  });
  const tail = previous.then(() => slot);
  fileMutationQueues.set(key, tail);

  try {
    await waitForTurn(previous, signal);
    return await operation();
  } finally {
    release();
    if (fileMutationQueues.get(key) === tail) {
      void tail.then(() => {
        if (fileMutationQueues.get(key) === tail) fileMutationQueues.delete(key);
      });
    }
  }
}

function mutationQueueKey(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function waitForTurn(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await previous;
    return;
  }
  throwIfAborted(signal);

  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === "string" && signal.reason.length > 0
    ? signal.reason
    : "Operation aborted";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
