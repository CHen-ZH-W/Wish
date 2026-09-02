/** Stable public identity for an Agent definition. */
export type AgentId = string;

/** Stable identity for one Runtime-owned Run. */
export type AgentRunId = string;

/** Stable identity for one UserTurn inside a Run. */
export type UserTurnId = string;

/** Transport-neutral data that adapters may attach to public DTOs. */
export type AgentMetadata = Readonly<Record<string, unknown>>;

/**
 * Declarative identity and configuration passed to the Runtime for every Run.
 * The Agent facade treats `configuration` as opaque; the composition root and
 * Runtime decide how model, context, tools, and policies are assembled.
 */
export interface AgentDefinition<Configuration = unknown> {
  readonly id: AgentId;
  readonly name?: string;
  readonly description?: string;
  readonly configuration?: Configuration;
  readonly metadata?: AgentMetadata;
}

/**
 * Transport-neutral input used to start one Run and its initial UserTurn.
 * `scope` is the Runtime uniqueness boundary and has no transport semantics.
 */
export interface RunInput<Payload = unknown> {
  readonly scope: string;
  readonly payload: Payload;
  readonly runId?: AgentRunId;
  readonly parentRunId?: AgentRunId;
  readonly metadata?: AgentMetadata;
}

/**
 * Immutable public descriptor for a started Run.
 * Lifecycle mutation remains behind Agent.control; the handle is not a
 * Runtime controller and does not expose internal state.
 */
export interface RunHandle<Completion = unknown> {
  readonly agentId: AgentId;
  readonly runId: AgentRunId;
  readonly initialUserTurnId: UserTurnId;
  readonly scope: string;
  readonly completion: Promise<Completion>;
}

/** Options for attaching to a Runtime-owned output event stream. */
export interface ObserveOptions {
  /** Resume strictly after this event sequence when the Runtime can replay it. */
  readonly afterSequence?: number;
  /** Stops this observer only; aborting a Run requires an explicit control. */
  readonly signal?: AbortSignal;
}

/**
 * Type-level protocol joining the facade to the later Core domains.
 *
 * Runtime control, event envelopes, and terminal results retain ownership of
 * their own types. A concrete Wish assembly specializes this protocol instead
 * of making Agent depend on transport or concrete infrastructure types.
 */
export interface AgentProtocol {
  readonly definitionConfiguration: unknown;
  readonly runPayload: unknown;
  readonly control: unknown;
  readonly controlReceipt: unknown;
  readonly outputEvent: unknown;
  readonly completion: unknown;
}
