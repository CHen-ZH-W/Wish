import type {
  AgentRunId,
  ObserveOptions,
  UserTurnId,
} from "../agent/types.js";
import type { ModelStreamEvent } from "../model/types.js";
import type { ToolExecutionEvent } from "../tools/executor.js";

export interface EventEnvelope<
  Type extends string = string,
  Payload = unknown,
> {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly type: Type;
  readonly occurredAt: string;
  readonly runId: AgentRunId;
  readonly userTurnId?: UserTurnId;
  readonly stepId?: string;
  readonly payload: Payload;
}

export type RuntimeEvent<Transition = unknown> = EventEnvelope<
  "runtime.transition",
  Transition
>;

export type ModelOutputEvent = EventEnvelope<"model.stream", ModelStreamEvent>;

export type ToolOutputEvent = EventEnvelope<
  "tool.lifecycle",
  ToolExecutionEvent
>;

/** Public events share one envelope while retaining domain-specific payloads. */
export type OutputEvent<Transition = unknown> =
  | RuntimeEvent<Transition>
  | ModelOutputEvent
  | ToolOutputEvent;

/** Step-scoped output channel supplied by Runtime to a Step pipeline. */
export interface StepOutputPublisher {
  publishModel(event: ModelStreamEvent): void;
  publishTool(event: ToolExecutionEvent): void;
}

export class EventCursorExpiredError extends Error {
  constructor(
    readonly requestedAfter: number,
    readonly earliestAvailable: number,
  ) {
    super(
      `Event cursor ${requestedAfter} expired; earliest available sequence is ${earliestAvailable}`,
    );
    this.name = "EventCursorExpiredError";
  }
}

/** Bounded process-local event stream with replay and independent observers. */
export class RuntimeEventStream<Transition> {
  private readonly events: Array<OutputEvent<Transition>> = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly runId: AgentRunId,
    private readonly maxEvents: number,
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Runtime event maxEvents must be a positive integer");
    }
  }

  publish(input: {
    readonly eventId: string;
    readonly occurredAt: string;
    readonly transition: Transition;
    readonly userTurnId?: UserTurnId;
    readonly stepId?: string;
  }): RuntimeEvent<Transition> {
    if (this.closed) throw new Error("Cannot publish to a closed Runtime event stream");
    this.sequence += 1;
    const event: RuntimeEvent<Transition> = Object.freeze({
      schemaVersion: 1 as const,
      eventId: input.eventId,
      sequence: this.sequence,
      type: "runtime.transition" as const,
      occurredAt: input.occurredAt,
      runId: this.runId,
      ...(input.userTurnId === undefined
        ? {}
        : { userTurnId: input.userTurnId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      payload: input.transition,
    });
    this.append(event);
    return event;
  }

  publishModel(input: {
    readonly eventId: string;
    readonly occurredAt: string;
    readonly event: ModelStreamEvent;
    readonly userTurnId: UserTurnId;
    readonly stepId: string;
  }): ModelOutputEvent {
    if (this.closed) throw new Error("Cannot publish to a closed Runtime event stream");
    this.sequence += 1;
    const event: ModelOutputEvent = Object.freeze({
      schemaVersion: 1 as const,
      eventId: input.eventId,
      sequence: this.sequence,
      type: "model.stream" as const,
      occurredAt: input.occurredAt,
      runId: this.runId,
      userTurnId: input.userTurnId,
      stepId: input.stepId,
      payload: input.event,
    });
    this.append(event);
    return event;
  }

  publishTool(input: {
    readonly eventId: string;
    readonly event: ToolExecutionEvent;
  }): ToolOutputEvent {
    if (this.closed) throw new Error("Cannot publish to a closed Runtime event stream");
    if (input.event.scope.runId !== this.runId) {
      throw new Error("Tool event belongs to a different Runtime Run");
    }
    this.sequence += 1;
    const event: ToolOutputEvent = Object.freeze({
      schemaVersion: 1 as const,
      eventId: input.eventId,
      sequence: this.sequence,
      type: "tool.lifecycle" as const,
      occurredAt: input.event.occurredAt,
      runId: this.runId,
      userTurnId: input.event.scope.userTurnId,
      stepId: input.event.scope.stepId,
      payload: input.event,
    });
    this.append(event);
    return event;
  }

  observe(options: ObserveOptions = {}): AsyncIterable<OutputEvent<Transition>> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = options.afterSequence ?? 0;
        while (true) {
          if (isAborted(options.signal)) return;
          const earliest = self.events[0]?.sequence;
          if (earliest !== undefined && cursor < earliest - 1) {
            throw new EventCursorExpiredError(cursor, earliest);
          }
          const available = self.events.filter(
            (event) => event.sequence > cursor,
          );
          for (const event of available) {
            if (isAborted(options.signal)) return;
            cursor = event.sequence;
            yield event;
          }
          if (self.closed) return;
          await self.waitForChange(options.signal);
        }
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakeListeners();
  }

  private waitForChange(signal: AbortSignal | undefined): Promise<void> {
    if (this.closed || isAborted(signal)) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        this.listeners.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      this.listeners.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }

  private wakeListeners(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private append(event: OutputEvent<Transition>): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    this.wakeListeners();
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
