import type {
  AgentDefinition,
  AgentId,
  AgentProtocol,
  AgentRunId,
  ObserveOptions,
  RunHandle,
  RunInput,
} from "./types.js";

export type {
  AgentDefinition,
  AgentId,
  AgentInputSource,
  AgentMetadata,
  AgentProtocol,
  AgentRunId,
  ObserveOptions,
  RunHandle,
  RunInput,
  RunInputSource,
  UserTurnId,
} from "./types.js";

/**
 * The exact Runtime surface consumed by Agent.
 *
 * This is deliberately narrower than a Runtime controller: Agent may start a
 * Run, submit a transport-neutral control, and observe output, but it cannot
 * mutate Run/UserTurn/Step state directly.
 */
export interface AgentRuntimeService<Protocol extends AgentProtocol> {
  startRun(
    definition: AgentDefinition<Protocol["definitionConfiguration"]>,
    input: RunInput<Protocol["runPayload"]>,
  ): RunHandle<Protocol["completion"]>;

  control(
    agentId: AgentId,
    runId: AgentRunId,
    control: Protocol["control"],
  ): Protocol["controlReceipt"];

  observe(
    agentId: AgentId,
    runId: AgentRunId,
    options?: ObserveOptions,
  ): AsyncIterable<Protocol["outputEvent"]>;
}

/** Public facade for starting, controlling, and observing one Agent's Runs. */
export class Agent<Protocol extends AgentProtocol = AgentProtocol> {
  readonly definition: AgentDefinition<
    Protocol["definitionConfiguration"]
  >;

  constructor(
    definition: AgentDefinition<Protocol["definitionConfiguration"]>,
    private readonly runtime: AgentRuntimeService<Protocol>,
  ) {
    this.definition = Object.freeze({
      ...definition,
      id: requireIdentifier(definition.id, "Agent definition id"),
      ...(definition.configuration === undefined
        ? {}
        : {
            configuration: snapshotBoundaryValue(
              definition.configuration,
            ),
          }),
      ...(definition.metadata === undefined
        ? {}
        : { metadata: snapshotBoundaryValue(definition.metadata) }),
    });
  }

  startRun(
    input: RunInput<Protocol["runPayload"]>,
  ): RunHandle<Protocol["completion"]> {
    const normalizedInput: RunInput<Protocol["runPayload"]> = Object.freeze({
      ...input,
      scope: normalizeScope(input.scope),
      payload: snapshotBoundaryValue(input.payload),
      ...(input.runId === undefined
        ? {}
        : { runId: requireIdentifier(input.runId, "Run id") }),
      ...(input.parentRunId === undefined
        ? {}
        : {
            parentRunId: requireIdentifier(
              input.parentRunId,
              "Parent Run id",
            ),
          }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: snapshotBoundaryValue(input.metadata) }),
    });
    const handle = this.runtime.startRun(this.definition, normalizedInput);
    return Object.freeze({
      agentId: handle.agentId,
      runId: handle.runId,
      initialUserTurnId: handle.initialUserTurnId,
      scope: handle.scope,
      completion: handle.completion,
    });
  }

  control(
    runId: AgentRunId,
    control: Protocol["control"],
  ): Protocol["controlReceipt"] {
    return this.runtime.control(
      this.definition.id,
      requireIdentifier(runId, "Run id"),
      control,
    );
  }

  observe(
    runId: AgentRunId,
    options?: ObserveOptions,
  ): AsyncIterable<Protocol["outputEvent"]> {
    validateObserveOptions(options);
    return this.runtime.observe(
      this.definition.id,
      requireIdentifier(runId, "Run id"),
      options,
    );
  }
}

function normalizeScope(scope: string): string {
  if (typeof scope !== "string") {
    throw new Error("Run scope must be a string");
  }
  const normalized = scope.trim();
  if (normalized.length === 0) {
    throw new Error("Run scope must not be empty");
  }
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
  return value;
}

function validateObserveOptions(options: ObserveOptions | undefined): void {
  const sequence = options?.afterSequence;
  if (
    sequence !== undefined &&
    (!Number.isSafeInteger(sequence) || sequence < 0)
  ) {
    throw new Error("Observe afterSequence must be a non-negative safe integer");
  }
}

/**
 * Takes ownership of public DTO data without interpreting its domain meaning.
 * Plain records and arrays are copied recursively so later caller mutations
 * cannot change a definition or an already-submitted Run input. Capability
 * objects and other non-plain values remain opaque.
 */
function snapshotBoundaryValue<Value>(value: Value): Value {
  return cloneAndFreezePlainValue(value) as Value;
}

function cloneAndFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezePlainValue));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          cloneAndFreezePlainValue(item),
        ]),
      ),
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
