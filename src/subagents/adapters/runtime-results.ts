import type {
  SubagentEvent,
  SubagentRecord,
  Subagents,
} from "../types.js";
import type { RunContinuation } from "../../core/runtime/continuation.js";

export interface SubagentResultRelayOptions {
  readonly subagents: Subagents;
  readonly maxWaitMs?: number;
}

interface RelayTask {
  readonly abort: AbortController;
  completion: Promise<void>;
}

/** Event bridge from the domain Runtime into one held parent Run. */
export class SubagentResultRelay {
  private readonly subagents: Subagents;
  private readonly maxWaitMs: number;
  private readonly tasks = new Set<RelayTask>();
  private closed = false;

  constructor(options: SubagentResultRelayOptions) {
    this.subagents = options.subagents;
    this.maxWaitMs = positiveInteger(
      options.maxWaitMs ?? 30 * 60_000,
      "Subagent relay max wait",
    );
  }

  watch(input: {
    readonly record: SubagentRecord;
    readonly continuation: RunContinuation;
    readonly signal?: AbortSignal;
  }): void {
    if (this.closed) return;
    const hold = input.continuation.deferCompletion(
      `waiting for Subagent ${input.record.role} result`,
    );
    if (hold === undefined) return;
    const abort = new AbortController();
    const relay: RelayTask = { abort, completion: Promise.resolve() };
    const onAbort = () => abort.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    relay.completion = this.observe(input, abort.signal).finally(() => {
      input.signal?.removeEventListener("abort", onAbort);
      hold.release();
      this.tasks.delete(relay);
    });
    this.tasks.add(relay);
    void relay.completion.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.tasks) task.abort.abort("Subagent result relay closed");
    await Promise.allSettled([...this.tasks].map((task) => task.completion));
  }

  /** A held parent completion is state that this ephemeral adapter cannot migrate. */
  get pendingResults(): number { return this.tasks.size; }

  private observe(
    input: {
      readonly record: SubagentRecord;
      readonly continuation: RunContinuation;
    },
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (text?: string) => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        unsubscribe();
        if (text !== undefined) followUp(input.continuation, text);
        resolve();
      };
      const observeRecord = (record: SubagentRecord) => {
        if (record.id !== input.record.id) return;
        if (record.result !== undefined) {
          finish(formatResult(record));
        } else if (
          record.status === "failed" || record.status === "lost" ||
          record.status === "stopped" || record.status === "exited"
        ) {
          finish(formatTerminalWithoutResult(record));
        }
      };
      const onEvent = (event: SubagentEvent) => observeRecord(event.record);
      const aborted = () => finish();
      signal.addEventListener("abort", aborted, { once: true });
      try {
        unsubscribe = this.subagents.subscribe(onEvent);
      } catch (error: unknown) {
        finish([
          `Subagent result relay could not observe child Agent ${input.record.id} (${input.record.role}).`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          `The child execution remains independently observable at ${input.record.target?.target ?? "an unavailable target"}.`,
        ].join("\n"));
        return;
      }
      timer = setTimeout(() => finish(
        `Child Agent ${input.record.id} (${input.record.role}) did not produce a result within ${this.maxWaitMs}ms. It remains observable at ${input.record.target?.target ?? "an unavailable target"}.`,
      ), this.maxWaitMs);
      observeRecord(input.record);
    });
  }
}

function followUp(continuation: RunContinuation, text: string): void {
  continuation.followUp({
    source: "wish-subagent-result",
    text,
    reserveCapacity: true,
  });
}

function formatResult(record: SubagentRecord): string {
  const result = record.result!;
  return [
    `Subagent result received from ${record.id} (${record.role}).`,
    `Status: ${result.status}`,
    ...(result.text === undefined ? [] : ["", result.text]),
    ...(result.error === undefined ? [] : ["", `Error: ${result.error}`]),
    "",
    `Execution target: ${record.target?.target ?? "unavailable"}`,
  ].join("\n");
}

function formatTerminalWithoutResult(record: SubagentRecord): string {
  return [
    `Child Agent ${record.id} (${record.role}) ended without a structured result.`,
    `Transport status: ${record.status}`,
    ...(record.exitCode === undefined ? [] : [`Exit code: ${record.exitCode}`]),
    ...(record.failure === undefined ? [] : [`Failure: ${record.failure}`]),
    `Inspect retained terminal output through the Subagents capability for id ${record.id}.`,
  ].join("\n");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
  return value;
}
