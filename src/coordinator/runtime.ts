import {
  CoordinatorClosedError,
  CoordinatorConflictError,
  CoordinatorInactiveError,
  CoordinatorInvalidInputError,
  CoordinatorNotFoundError,
} from "./errors.js";
import type {
  Coordinator,
  CoordinatorRunRequest,
  CoordinatorState,
  CoordinatorStateStore,
  EnterCoordinatorRequest,
  ExitCoordinatorRequest,
} from "./types.js";

export interface CoordinatorRuntimeOptions {
  readonly store: CoordinatorStateStore;
  readonly now?: () => Date;
}

/** Run-scoped mode state; child execution remains owned by Subagents. */
export class CoordinatorRuntime implements Coordinator {
  private readonly store: CoordinatorStateStore;
  private readonly now: () => Date;
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: CoordinatorRuntimeOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async get(request: CoordinatorRunRequest): Promise<CoordinatorState | undefined> {
    this.assertOpen();
    const runId = identifier(request.runId, "Coordinator Run id");
    request.signal?.throwIfAborted();
    await (this.tails.get(runId) ?? Promise.resolve());
    return this.store.get(runId, request.signal);
  }

  enter(request: EnterCoordinatorRequest): Promise<CoordinatorState> {
    const runId = identifier(request.runId, "Coordinator Run id");
    const sessionId = identifier(request.sessionId, "Coordinator Session id");
    const goal = request.goal === undefined
      ? undefined
      : nonBlank(request.goal, "Coordinator goal");
    return this.serial(runId, async () => {
      request.signal?.throwIfAborted();
      const current = await this.store.get(runId, request.signal);
      if (current?.active === true) {
        throw new CoordinatorConflictError(
          `Coordinator mode is already active for Run ${runId}`,
        );
      }
      if (current !== undefined && current.sessionId !== sessionId) {
        throw new CoordinatorConflictError(
          `Coordinator Run ${runId} belongs to another Session`,
        );
      }
      const next: CoordinatorState = Object.freeze({
        schemaVersion: 1 as const,
        runId,
        sessionId,
        version: (current?.version ?? 0) + 1,
        active: true,
        ...(goal === undefined ? {} : { goal }),
        enteredAt: this.timestamp(),
      });
      await this.store.put(next, current?.version, request.signal);
      return next;
    });
  }

  exit(request: ExitCoordinatorRequest): Promise<CoordinatorState> {
    const runId = identifier(request.runId, "Coordinator Run id");
    const outcome = request.outcome === undefined
      ? undefined
      : nonBlank(request.outcome, "Coordinator outcome");
    return this.serial(runId, async () => {
      request.signal?.throwIfAborted();
      const current = await this.store.get(runId, request.signal);
      if (current === undefined) throw new CoordinatorNotFoundError(runId);
      if (!current.active) throw new CoordinatorInactiveError(runId);
      const next: CoordinatorState = Object.freeze({
        ...current,
        version: current.version + 1,
        active: false,
        exitedAt: this.timestamp(),
        ...(outcome === undefined ? {} : { outcome }),
      });
      await this.store.put(next, current.version, request.signal);
      return next;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.tails.values()].map((tail) => tail.catch(() => undefined)));
    await this.store.close();
  }

  private serial<Value>(runId: string, operation: () => Promise<Value>): Promise<Value> {
    this.assertOpen();
    const previous = this.tails.get(runId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      this.assertOpen();
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(runId, settled);
    void settled.then(() => {
      if (this.tails.get(runId) === settled) this.tails.delete(runId);
    });
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new CoordinatorClosedError();
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new CoordinatorInvalidInputError(
        "Coordinator clock returned an invalid Date",
      );
    }
    return value.toISOString();
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new CoordinatorInvalidInputError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CoordinatorInvalidInputError(`${label} must not be empty`);
  }
  return value;
}
