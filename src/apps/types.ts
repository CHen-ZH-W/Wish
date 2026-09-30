import type {
  AgentId,
  AgentMetadata,
  AgentRunId,
  ObserveOptions,
  RunHandle,
  RunInputSource,
} from "../core/agent/agent.js";
import type {
  AgentLoopResult,
} from "../core/agent-loop/agent-loop.js";
import type { OutputEvent } from "../core/events/event.js";
import type { ModelRef } from "../core/model/model.js";
import type { ModelReasoningEffort } from "../models/types.js";
import type { SessionReasoningPort } from "../models/session-reasoning.js";
import type {
  RunCompletion,
  RuntimeAgentProtocol,
  RuntimeControl,
  RuntimeControlReceipt,
  RuntimeTransition,
} from "../core/runtime/runtime.js";
import type { RunGeneration } from "../core/runtime/generation.js";
import type {
  ResolveRuntimeReconciliationRequest,
  RuntimeReconciliationCommit,
  RuntimeLifecycleStartupSnapshot,
} from "../core/runtime/durability/types.js";
import type {
  ContextInstruction,
} from "../context/types.js";
import type { AgentPermissionConfiguration } from "../permissions/index.js";
import type {
  ArchiveSessionInput,
  RestoreSessionInput,
  DeleteSessionInput,
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
  /** Optional for legacy embedders; product Agent definitions always set it. */
  readonly permissions?: AgentPermissionConfiguration;
}

/** Transport-neutral input shared by an initial Run and follow-up UserTurns. */
export interface WishRunPayload {
  readonly text: string;
  /** Optional Run-level selection; the AgentLoop fixes it at the first Step. */
  readonly model?: ModelRef;
  /** Fixed at new-Run admission; follow-up and steering cannot change it. */
  readonly reasoningEffort?: ModelReasoningEffort;
  /** Runtime-produced continuation identity; never trusted without UserTurn provenance. */
  readonly continuation?: {
    readonly kind: "goal_round";
    readonly goalId: string;
    readonly revision: number;
    readonly round: number;
  };
}

export type WishAgentProtocol = RuntimeAgentProtocol<
  WishAgentConfiguration,
  WishRunPayload,
  AgentLoopResult
>;

export type WishRunGeneration = RunGeneration<WishAgentProtocol>;

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
  /** Trusted adapter metadata, never inferred from payload text or model role. */
  readonly inputSource?: RunInputSource;
  readonly runId?: AgentRunId;
  readonly metadata?: AgentMetadata;
  /** Cancels only the asynchronous Session/model preflight before Runtime starts. */
  readonly signal?: AbortSignal;
}

export type ListWishSessionsInput = Omit<ListSessionsInput, "agentId">;

/** Narrow management surface; it does not expose Runtime lifecycle writes. */
export interface WishRuntimeRecovery {
  snapshot(signal?: AbortSignal): Promise<RuntimeLifecycleStartupSnapshot>;
  resolve(
    request: ResolveRuntimeReconciliationRequest,
  ): Promise<RuntimeReconciliationCommit>;
}

/**
 * Transport-neutral facade shared by process surfaces and explicit embedders.
 * Product entrypoints obtain it from the Loader-managed Application service.
 */
export interface WishApplication {
  readonly sessionFeatures?: import("./session-features.js").SessionFeatures;
  readonly sessionReasoning?: SessionReasoningPort;
  readonly agentId: AgentId;
  /** Lifecycle owner of Runs admitted by a Loader-managed graph generation. */
  readonly runGeneration?: WishRunGeneration;
  /** Present in product graphs after startup recovery has passed its gate. */
  readonly runtimeRecovery?: WishRuntimeRecovery;

  createSession(input: CreateWishSessionInput): Promise<Session>;
  getSession(input: GetSessionInput): Promise<Session>;
  listSessions(input?: ListWishSessionsInput): Promise<readonly Session[]>;
  updateSessionMetadata(input: UpdateSessionMetadataInput): Promise<Session>;
  archiveSession(input: ArchiveSessionInput): Promise<Session>;
  restoreSession(input: RestoreSessionInput): Promise<Session>;
  deleteSession(input: DeleteSessionInput): Promise<void>;
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
