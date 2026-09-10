import type { AgentRuntimeService } from "../agent/agent.js";
import type {
  AgentDefinition,
  AgentId,
  AgentProtocol,
  AgentRunId,
  ObserveOptions,
  RunHandle,
  RunInput,
} from "../agent/types.js";

export type RunGenerationState = "accepting" | "retiring" | "retired";

export interface RunGenerationActiveRun {
  readonly agentId: AgentId;
  readonly runId: AgentRunId;
  readonly scope: string;
  readonly abortRequested: boolean;
}

export interface RunGenerationSnapshot {
  readonly id: string;
  readonly state: RunGenerationState;
  readonly activeRuns: readonly RunGenerationActiveRun[];
}

export interface RunGenerationRetireOptions {
  readonly reason?: string;
  /** Notification only: retirement remains pending until every Run settles. */
  readonly onDrainTimeout?: (error: RunGenerationDrainTimeoutError) => void;
}

export interface RunGenerationOptions<Protocol extends AgentProtocol> {
  readonly id: string;
  readonly drainTimeoutMs: number;
  readonly abortControl: (input: {
    readonly generationId: string;
    readonly reason: string;
  }) => Protocol["control"];
}

interface ActiveRun<Completion> {
  readonly agentId: AgentId;
  readonly runId: AgentRunId;
  readonly scope: string;
  readonly completion: Promise<Completion>;
  abortRequested: boolean;
}

/** A stale Application attempted to admit work after its graph was retired. */
export class RunGenerationRetiredError extends Error {
  readonly code = "run_generation_retired";

  constructor(
    readonly generationId: string,
    readonly generationState: Exclude<RunGenerationState, "accepting">,
  ) {
    super(
      `Run generation ${generationId} is ${generationState} and cannot start new Runs`,
    );
    this.name = "RunGenerationRetiredError";
  }
}

/** Drain deadline notification; it never declares an active generation clean. */
export class RunGenerationDrainTimeoutError extends Error {
  readonly code = "run_generation_drain_timeout";

  constructor(
    readonly generationId: string,
    readonly timeoutMs: number,
    readonly activeRuns: readonly RunGenerationActiveRun[],
  ) {
    super(
      `Run generation ${generationId} still owns ${activeRuns.length} active Run(s) after ${timeoutMs}ms`,
    );
    this.name = "RunGenerationDrainTimeoutError";
  }
}

/**
 * Admission and drain boundary around one immutable Runtime dependency graph.
 *
 * It delegates normal behavior to Core Runtime, but permanently closes new Run
 * admission before a Cordis generation unloads. Retirement sends one explicit
 * abort per active Run and waits for the original completion promises. It
 * never creates, retries, or replays a Run or Tool call.
 */
export class RunGeneration<Protocol extends AgentProtocol>
  implements AgentRuntimeService<Protocol> {
  readonly id: string;
  readonly drainTimeoutMs: number;

  private stateValue: RunGenerationState = "accepting";
  private readonly active = new Map<string, ActiveRun<Protocol["completion"]>>();
  private readonly timeoutObservers = new Set<
    (error: RunGenerationDrainTimeoutError) => void
  >();
  private retirement: Promise<void> | undefined;
  private releaseDrain: (() => void) | undefined;
  private timeoutError: RunGenerationDrainTimeoutError | undefined;

  constructor(
    private readonly runtime: AgentRuntimeService<Protocol>,
    private readonly options: RunGenerationOptions<Protocol>,
  ) {
    this.id = requireIdentifier(options.id, "Run generation id");
    this.drainTimeoutMs = positiveInteger(
      options.drainTimeoutMs,
      "Run generation drain timeout",
    );
    if (typeof options.abortControl !== "function") {
      throw new Error("Run generation requires an abort control factory");
    }
  }

  get state(): RunGenerationState {
    return this.stateValue;
  }

  startRun(
    definition: AgentDefinition<Protocol["definitionConfiguration"]>,
    input: RunInput<Protocol["runPayload"]>,
  ): RunHandle<Protocol["completion"]> {
    if (this.stateValue !== "accepting") {
      throw new RunGenerationRetiredError(this.id, this.stateValue);
    }
    const handle = this.runtime.startRun(definition, input);
    const key = runKey(handle.agentId, handle.runId);
    const record: ActiveRun<Protocol["completion"]> = {
      agentId: handle.agentId,
      runId: handle.runId,
      scope: handle.scope,
      completion: handle.completion,
      abortRequested: false,
    };
    this.active.set(key, record);
    void handle.completion.then(
      () => this.releaseRun(key, record),
      () => this.releaseRun(key, record),
    );
    return handle;
  }

  control(
    agentId: AgentId,
    runId: AgentRunId,
    control: Protocol["control"],
  ): Protocol["controlReceipt"] {
    return this.runtime.control(agentId, runId, control);
  }

  observe(
    agentId: AgentId,
    runId: AgentRunId,
    options?: ObserveOptions,
  ): AsyncIterable<Protocol["outputEvent"]> {
    return this.runtime.observe(agentId, runId, options);
  }

  snapshot(): RunGenerationSnapshot {
    return Object.freeze({
      id: this.id,
      state: this.stateValue,
      activeRuns: Object.freeze([...this.active.values()].map((run) =>
        Object.freeze({
          agentId: run.agentId,
          runId: run.runId,
          scope: run.scope,
          abortRequested: run.abortRequested,
        })
      )),
    });
  }

  retire(options: RunGenerationRetireOptions = {}): Promise<void> {
    if (this.stateValue === "retired" && this.retirement !== undefined) {
      return this.retirement;
    }
    if (options.onDrainTimeout !== undefined) {
      if (typeof options.onDrainTimeout !== "function") {
        throw new Error("Run generation timeout observer must be a function");
      }
      this.timeoutObservers.add(options.onDrainTimeout);
      if (this.timeoutError !== undefined) {
        notifyTimeoutObserver(options.onDrainTimeout, this.timeoutError);
      }
    }
    if (this.retirement !== undefined) return this.retirement;

    const reason = optionalReason(options.reason) ??
      `Run generation ${this.id} is retiring`;
    this.stateValue = "retiring";
    for (const run of this.active.values()) this.abortRun(run, reason);

    if (this.active.size === 0) {
      this.stateValue = "retired";
      this.retirement = Promise.resolve();
      this.timeoutObservers.clear();
      return this.retirement;
    }

    this.retirement = this.waitForDrain();
    return this.retirement;
  }

  private abortRun(
    run: ActiveRun<Protocol["completion"]>,
    reason: string,
  ): void {
    if (run.abortRequested) return;
    run.abortRequested = true;
    try {
      this.runtime.control(
        run.agentId,
        run.runId,
        this.options.abortControl({ generationId: this.id, reason }),
      );
    } catch {
      // The original completion remains the only evidence that the Run ended.
    }
  }

  private async waitForDrain(): Promise<void> {
    const drained = new Promise<void>((accept) => {
      this.releaseDrain = accept;
    });
    const timer = setTimeout(
      () => this.notifyDrainTimeout(),
      this.drainTimeoutMs,
    );
    timer.unref?.();
    try {
      await drained;
      this.stateValue = "retired";
    } finally {
      clearTimeout(timer);
      this.releaseDrain = undefined;
      this.timeoutObservers.clear();
    }
  }

  private notifyDrainTimeout(): void {
    if (this.active.size === 0 || this.timeoutError !== undefined) return;
    const error = new RunGenerationDrainTimeoutError(
      this.id,
      this.drainTimeoutMs,
      this.snapshot().activeRuns,
    );
    this.timeoutError = error;
    for (const observer of this.timeoutObservers) {
      notifyTimeoutObserver(observer, error);
    }
  }

  private releaseRun(
    key: string,
    record: ActiveRun<Protocol["completion"]>,
  ): void {
    if (this.active.get(key) !== record) return;
    this.active.delete(key);
    if (this.stateValue === "retiring" && this.active.size === 0) {
      this.releaseDrain?.();
    }
  }
}

function notifyTimeoutObserver(
  observer: (error: RunGenerationDrainTimeoutError) => void,
  error: RunGenerationDrainTimeoutError,
): void {
  try {
    observer(error);
  } catch {
    // Observability must not turn a truthful pending drain into fake cleanup.
  }
}

function runKey(agentId: AgentId, runId: AgentRunId): string {
  return `${agentId}\u0000${runId}`;
}

function optionalReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Run generation retirement reason must not be empty");
  }
  return value.trim();
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
