import type {
  AgentId,
  AgentMetadata,
  AgentRunId,
  ObserveOptions,
  RunHandle,
} from "../core/agent/agent.js";
import type {
  AgentLoopResult,
} from "../core/agent-loop/agent-loop.js";
import type { OutputEvent } from "../core/events/event.js";
import type { ModelRef } from "../core/model/model.js";
import type {
  RunCompletion,
  RuntimeAgentProtocol,
  RuntimeControl,
  RuntimeControlReceipt,
  RuntimeTransition,
} from "../core/runtime/runtime.js";
import type {
  ContextInstruction,
  ContextWorkspaceFacts,
} from "../context/types.js";
import type {
  ArchiveSessionInput,
  GetSessionInput,
  ListSessionsInput,
  ReadSessionHistoryInput,
  Session,
  SessionHistorySnapshot,
  SessionId,
  UpdateSessionMetadataInput,
} from "../sessions/types.js";

/** Configuration owned by one shared Wish Agent definition. */
export interface WishAgentConfiguration {
  readonly agentInstructions: readonly ContextInstruction[];
}

/** Transport-neutral input shared by an initial Run and follow-up UserTurns. */
export interface WishRunPayload {
  readonly text: string;
  /** Optional Run-level selection; the AgentLoop fixes it at the first Step. */
  readonly model?: ModelRef;
}

export type WishAgentProtocol = RuntimeAgentProtocol<
  WishAgentConfiguration,
  WishRunPayload,
  AgentLoopResult
>;

export type WishRunCompletion = RunCompletion<AgentLoopResult, WishRunPayload>;
export type WishRunHandle = RunHandle<WishRunCompletion>;
export type WishOutputEvent = OutputEvent<
  RuntimeTransition<WishRunPayload, AgentLoopResult>
>;
export type WishRunControl = RuntimeControl<WishRunPayload>;

/** Apps create the Session before starting its first Runtime Run. */
export interface CreateWishSessionInput {
  readonly sessionId?: SessionId;
  /** Becomes Session.scope; implementations normalize it to a workspace root. */
  readonly workspaceRoot: string;
  readonly title?: string;
  readonly signal?: AbortSignal;
}

/** Starts one new Run whose Runtime scope is exactly sessionId. */
export interface StartWishRunInput {
  readonly sessionId: SessionId;
  readonly payload: WishRunPayload;
  readonly runId?: AgentRunId;
  readonly metadata?: AgentMetadata;
  /** Cancels only the asynchronous Session/model preflight before Runtime starts. */
  readonly signal?: AbortSignal;
}

export type ListWishSessionsInput = Omit<ListSessionsInput, "agentId">;

/** Resolves fresh Context/Tool workspace facts for an immutable Step. */
export interface WishWorkspaceResolver {
  resolve(input: {
    readonly session: Session;
    readonly signal: AbortSignal;
  }): Promise<ContextWorkspaceFacts> | ContextWorkspaceFacts;
}

/**
 * Internal transport-neutral facade shared by the CLI and WebUI entrypoints.
 * `createWishApplication` supplies the shared concrete composition.
 */
export interface WishApplication {
  readonly agentId: AgentId;

  createSession(input: CreateWishSessionInput): Promise<Session>;
  getSession(input: GetSessionInput): Promise<Session>;
  listSessions(input?: ListWishSessionsInput): Promise<readonly Session[]>;
  updateSessionMetadata(input: UpdateSessionMetadataInput): Promise<Session>;
  archiveSession(input: ArchiveSessionInput): Promise<Session>;
  readSessionHistory(
    input: ReadSessionHistoryInput,
  ): Promise<SessionHistorySnapshot>;

  startRun(input: StartWishRunInput): Promise<WishRunHandle>;
  controlRun(
    runId: AgentRunId,
    control: WishRunControl,
  ): RuntimeControlReceipt;
  observeRun(
    runId: AgentRunId,
    options?: ObserveOptions,
  ): AsyncIterable<WishOutputEvent>;
}
