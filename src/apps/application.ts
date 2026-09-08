import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import {
  Agent,
  type AgentDefinition,
} from "../core/agent/agent.js";
import {
  AgentLoop,
  type AgentLoopInputRenderer,
  type AgentLoopMemory,
  type AgentLoopRequestOptions,
  type AgentLoopResult,
} from "../core/agent-loop/agent-loop.js";
import type { ModelRef } from "../core/model/model.js";
import {
  Runtime,
  type RuntimeOptions,
} from "../core/runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
} from "../core/tools/scheduler.js";
import {
  ContextOverflowRecoveryPipeline,
  ModelCompactionSummarizer,
  SessionCompactor,
} from "../compaction/index.js";
import {
  createContextBundle,
  type ContextBundleConfigurationInput,
} from "../context/index.js";
import type { ContextInput } from "../context/types.js";
import {
  ModelAdapterRegistry,
  createDefaultModelAdapterRegistry,
} from "../models/registry.js";
import {
  createConfiguredModelRequestTokenCounter,
  createConfiguredModelStack,
  type ConfiguredModelStackOptions,
} from "../models/runtime.js";
import type {
  ModelEnvironment,
  ModelFetch,
  ModelsConfiguration,
} from "../models/types.js";
import {
  TokenizerUsageEstimator,
  type UsageEstimator,
} from "../models/usage.js";
import {
  SessionArchivedError,
  SessionHistoryAdapter,
  SessionManager,
  SessionNotFoundError,
  SessionTranscriptPipeline,
  createSessionInputRenderer,
  sessionIdFromRunScope,
} from "../sessions/index.js";
import type {
  ArchiveSessionInput,
  GetSessionInput,
  ReadSessionHistoryInput,
  Session,
  SessionHistorySnapshot,
  UpdateSessionMetadataInput,
} from "../sessions/types.js";
import { FileSessionStore } from
  "../storage/sessions/file-session-store.js";
import { FileToolResultArchive } from
  "../storage/tool-results/file-tool-result-archive.js";
import {
  BASIC_TOOL_NAMES,
  InteractiveToolAuthorizationService,
  createBasicToolResultRenderer,
  createDenyAllToolAuthorizationService,
  registerBasicTools,
  type BasicToolContext,
  type BasicToolName,
  type BasicToolsOptions,
  type ToolApprovalPort,
} from "../tools/index.js";
import type {
  CreateWishSessionInput,
  ListWishSessionsInput,
  StartWishRunInput,
  WishAgentConfiguration,
  WishAgentProtocol,
  WishApplication,
  WishOutputEvent,
  WishRunControl,
  WishRunHandle,
  WishRunPayload,
  WishWorkspaceResolver,
} from "./types.js";

export interface WishModelsOptions {
  readonly configuration: ModelsConfiguration;
  readonly registry?: ModelAdapterRegistry;
  readonly usageEstimator?: UsageEstimator;
  readonly fetch?: ModelFetch;
  readonly environment?: ModelEnvironment | (() => ModelEnvironment);
  readonly retry?: ConfiguredModelStackOptions["retry"];
}

export interface WishCompactionOptions {
  readonly keepRecentTokens: number;
  readonly summaryMaxOutputTokens: number;
  /** Defaults to the configured primary model. */
  readonly summaryModel?: ModelRef;
}

export interface WishToolsOptions {
  /** Missing approval is an explicit deny-all configuration. */
  readonly approval?: ToolApprovalPort<BasicToolContext>;
  readonly policyVersion?: string | (() => string);
  readonly authorityVersion?: string | (() => string);
  readonly availableTools?: readonly BasicToolName[];
  readonly maxParallelCalls?: number;
  readonly basic?: BasicToolsOptions;
}

export type WishRuntimeOptions = Pick<
  RuntimeOptions<
    WishAgentConfiguration,
    WishRunPayload,
    AgentLoopMemory,
    AgentLoopResult
  >,
  | "maxSteps"
  | "stepInboxLimits"
  | "followUpQueueLimits"
  | "maxRetainedRuns"
  | "maxEventsPerRun"
  | "ids"
  | "now"
>;

export interface WishApplicationOptions {
  /** Owns `sessions/` and `tool-results/` below this directory. */
  readonly dataDirectory: string;
  readonly agent: AgentDefinition<WishAgentConfiguration>;
  readonly models: WishModelsOptions;
  readonly workspace: WishWorkspaceResolver;
  readonly context: ContextBundleConfigurationInput;
  readonly compaction: WishCompactionOptions;
  readonly tools?: WishToolsOptions;
  readonly request?: AgentLoopRequestOptions;
  readonly runtime?: WishRuntimeOptions;
}

type WishRuntime = Runtime<
  WishAgentConfiguration,
  WishRunPayload,
  AgentLoopMemory,
  AgentLoopResult
>;

type WishRunPayloadWithSelectedModel = WishRunPayload & {
  readonly model: ModelRef;
};

/** Build the one internal application shared later by CLI and WebUI. */
export function createWishApplication(
  options: WishApplicationOptions,
): WishApplication {
  requireApplicationOptions(options);
  const dataDirectory = normalizeDirectory(
    options.dataDirectory,
    "Wish dataDirectory",
  );
  const agentId = requireIdentifier(options.agent.id, "Wish Agent id");
  const workspaceResolver = options.workspace;
  const requestOptions = snapshotRequestOptions(options.request);

  const sessions = new SessionManager(new FileSessionStore({
    rootDirectory: join(dataDirectory, "sessions"),
  }));
  const history = new SessionHistoryAdapter({ sessions });

  const registry = options.models.registry ?? createDefaultModelAdapterRegistry();
  const usageEstimator = options.models.usageEstimator ??
    new TokenizerUsageEstimator();
  const modelStack = createConfiguredModelStack({
    configuration: options.models.configuration,
    registry,
    usageEstimator,
    ...(options.models.fetch === undefined
      ? {}
      : { fetch: options.models.fetch }),
    ...(options.models.environment === undefined
      ? {}
      : { environment: options.models.environment }),
    ...(options.models.retry === undefined
      ? {}
      : { retry: options.models.retry }),
  });
  const requestCounter = createConfiguredModelRequestTokenCounter({
    configuration: options.models.configuration,
    ...(options.models.fetch === undefined
      ? {}
      : { fetch: options.models.fetch }),
    ...(options.models.environment === undefined
      ? {}
      : { environment: options.models.environment }),
  });

  const archive = new FileToolResultArchive({
    directory: join(dataDirectory, "tool-results"),
    locatorRoot: dataDirectory,
  });
  const agentInstructions = options.agent.configuration?.agentInstructions ?? [];
  const context = createContextBundle({
    history: history.context,
    agentInstructions,
    archive,
    models: modelStack.configuredModel,
    counter: requestCounter,
    configuration: options.context,
  });

  const toolRegistry = new ToolRegistry<BasicToolContext>();
  registerBasicTools(toolRegistry, options.tools?.basic);
  const authorization = options.tools?.approval === undefined
    ? createDenyAllToolAuthorizationService<BasicToolContext>()
    : new InteractiveToolAuthorizationService({
      approval: options.tools.approval,
      policyVersion: options.tools.policyVersion ?? "wish-app-policy-v1",
    });
  const executor = new ToolExecutor({
    registry: toolRegistry,
    authorization,
  });
  const scheduler = new BoundedToolScheduler({
    executor,
    ...(options.tools?.maxParallelCalls === undefined
      ? {}
      : { maxParallelCalls: options.tools.maxParallelCalls }),
  });
  const availableTools = Object.freeze([
    ...(options.tools?.availableTools ?? BASIC_TOOL_NAMES),
  ]);
  const authorityVersion = versionReader(
    options.tools?.authorityVersion ?? "wish-app-authority-v1",
  );

  const summaryModel = modelStack.configuredModel.resolve(
    options.compaction.summaryModel ??
      modelStack.configuredModel.getDefaultModel(),
  ).ref;
  const summarizer = new ModelCompactionSummarizer({
    model: modelStack.model,
    summaryModel,
    maxOutputTokens: options.compaction.summaryMaxOutputTokens,
  });
  const compactor = new SessionCompactor({
    session: history.compaction,
    summarizer,
    counter: requestCounter,
    configuration: {
      keepRecentTokens: options.compaction.keepRecentTokens,
    },
  });

  const baseInput: AgentLoopInputRenderer<WishRunPayload> = {
    renderUserInput(
      { payload }: Parameters<
        AgentLoopInputRenderer<WishRunPayload>["renderUserInput"]
      >[0],
    ) {
      return Object.freeze({
        role: "user" as const,
        content: requireUserText(payload.text, "Wish Run input"),
      });
    },
    renderSteering(
      { message }: Parameters<
        AgentLoopInputRenderer<WishRunPayload>["renderSteering"]
      >[0],
    ) {
      return Object.freeze({
        role: "user" as const,
        content: requireUserText(message.text, "Wish steering input"),
      });
    },
  };
  Object.freeze(baseInput);
  const input = createSessionInputRenderer<WishRunPayload>({
    sessions,
    delegate: baseInput,
  });
  const toolResults = context.createToolResultRenderer<WishRunPayload>({
    delegate: createBasicToolResultRenderer(),
    resolveSessionId: ({ snapshot }) => sessionIdFromRunScope(snapshot),
  });

  const loop = new AgentLoop<
    WishAgentConfiguration,
    WishRunPayload,
    ContextInput,
    BasicToolContext
  >({
    model: modelStack.model,
    context: context.projector,
    tools: toolRegistry,
    toolScheduler: scheduler,
    input,
    toolResults,
    environment: {
      async resolve({ snapshot, memory, signal }) {
        const sessionId = sessionIdFromRunScope(snapshot);
        const session = await requireActiveOwnedSession(
          sessions,
          agentId,
          sessionId,
          signal,
        );
        const workspace = await workspaceResolver.resolve({ session, signal });
        throwIfAborted(signal);
        const model = modelStack.configuredModel.resolve(
          memory?.model ?? snapshot.userTurn.input.model ??
            modelStack.configuredModel.getDefaultModel(),
        ).ref;
        const modelSpec = modelStack.configuredModel.getModelSpec(model);
        const contextEnvironment = context.forStep({
          snapshot,
          sessionId,
          model,
          workspace,
        });
        return Object.freeze({
          model,
          context: contextEnvironment,
          tools: Object.freeze({
            context: Object.freeze({
              cwd: contextEnvironment.input.workspace.cwd,
              modelSupportsImages: modelSpec.input.image,
            }),
            authorityVersion: authorityVersion(),
            availableTools: modelSpec.toolCalling
              ? availableTools
              : Object.freeze([]),
          }),
          ...(requestOptions === undefined
            ? {}
            : { request: requestOptions }),
        });
      },
    },
  });
  const recovery = new ContextOverflowRecoveryPipeline({
    delegate: loop,
    compactor,
    target: {
      resolve({ snapshot, memory }) {
        return Object.freeze({
          sessionId: sessionIdFromRunScope(snapshot),
          model: modelStack.configuredModel.resolve(
            memory?.model ?? snapshot.userTurn.input.model ??
              modelStack.configuredModel.getDefaultModel(),
          ).ref,
        });
      },
    },
  });
  const transcript = new SessionTranscriptPipeline({
    delegate: recovery,
    sessions,
  });
  const runtime: WishRuntime = new Runtime({
    ...(options.runtime ?? {}),
    stepPipeline: transcript,
  });
  const agent = new Agent<WishAgentProtocol>({
    ...options.agent,
    id: agentId,
    configuration: Object.freeze({
      agentInstructions: Object.freeze([...agentInstructions]),
    }),
  }, runtime);

  return new DefaultWishApplication({
    sessions,
    agent,
    configuredModel: modelStack.configuredModel,
  });
}

interface DefaultWishApplicationOptions {
  readonly sessions: SessionManager;
  readonly agent: Agent<WishAgentProtocol>;
  readonly configuredModel: ReturnType<
    typeof createConfiguredModelStack
  >["configuredModel"];
}

class DefaultWishApplication implements WishApplication {
  readonly agentId: string;
  private readonly modelByRun = new Map<string, ModelRef>();

  constructor(private readonly options: DefaultWishApplicationOptions) {
    this.agentId = options.agent.definition.id;
  }

  async createSession(input: CreateWishSessionInput): Promise<Session> {
    throwIfAborted(input.signal);
    return this.options.sessions.create({
      sessionId: input.sessionId ?? randomUUID(),
      agentId: this.agentId,
      scope: normalizeDirectory(input.workspaceRoot, "Wish workspaceRoot"),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  getSession(input: GetSessionInput): Promise<Session> {
    return requireOwnedSession(
      this.options.sessions,
      this.agentId,
      input.sessionId,
      input.signal,
    );
  }

  listSessions(
    input: ListWishSessionsInput = {},
  ): Promise<readonly Session[]> {
    return this.options.sessions.list({ ...input, agentId: this.agentId });
  }

  async updateSessionMetadata(
    input: UpdateSessionMetadataInput,
  ): Promise<Session> {
    await this.getSession(input);
    return this.options.sessions.updateMetadata(input);
  }

  async archiveSession(input: ArchiveSessionInput): Promise<Session> {
    await this.getSession(input);
    return this.options.sessions.archive(input);
  }

  async readSessionHistory(
    input: ReadSessionHistoryInput,
  ): Promise<SessionHistorySnapshot> {
    await this.getSession(input);
    return this.options.sessions.readHistory(input);
  }

  async startRun(input: StartWishRunInput): Promise<WishRunHandle> {
    const session = await requireActiveOwnedSession(
      this.options.sessions,
      this.agentId,
      input.sessionId,
      input.signal,
    );
    throwIfAborted(input.signal);
    const payload = normalizeRunPayload(
      input.payload,
      this.options.configuredModel,
    );
    const handle = this.options.agent.startRun({
      scope: session.sessionId,
      payload,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    this.modelByRun.set(handle.runId, payload.model);
    void handle.completion.finally(() => {
      this.modelByRun.delete(handle.runId);
    });
    return handle;
  }

  controlRun(
    runId: string,
    control: WishRunControl,
  ): ReturnType<WishRuntime["control"]> {
    if (control.type !== "follow_up") {
      return this.options.agent.control(runId, control);
    }
    const selected = this.modelByRun.get(runId);
    if (selected === undefined) {
      return this.options.agent.control(runId, control);
    }
    if (
      control.payload.model !== undefined &&
      !sameModel(control.payload.model, selected)
    ) {
      throw new Error("Wish follow-up cannot change the model selected for its Run");
    }
    const normalized: WishRunControl = Object.freeze({
      ...control,
      payload: Object.freeze({
        text: requireUserText(control.payload.text, "Wish follow-up input"),
        model: selected,
      }),
    });
    return this.options.agent.control(runId, normalized);
  }

  observeRun(
    runId: string,
    options?: Parameters<WishApplication["observeRun"]>[1],
  ): AsyncIterable<WishOutputEvent> {
    return this.options.agent.observe(runId, options);
  }
}

async function requireActiveOwnedSession(
  sessions: SessionManager,
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Session> {
  const session = await requireOwnedSession(
    sessions,
    agentId,
    sessionId,
    signal,
  );
  if (session.status === "archived") {
    throw new SessionArchivedError(session.sessionId);
  }
  return session;
}

async function requireOwnedSession(
  sessions: SessionManager,
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Session> {
  const session = await sessions.get({
    sessionId,
    ...(signal === undefined ? {} : { signal }),
  });
  if (session.agentId !== agentId) {
    throw new SessionNotFoundError(sessionId);
  }
  return session;
}

function normalizeRunPayload(
  payload: StartWishRunInput["payload"],
  models: DefaultWishApplicationOptions["configuredModel"],
): WishRunPayloadWithSelectedModel {
  if (payload === null || typeof payload !== "object") {
    throw new Error("Wish Run payload must be an object");
  }
  const model = models.resolve(payload.model ?? models.getDefaultModel()).ref;
  return Object.freeze({
    text: requireUserText(payload.text, "Wish Run input"),
    model,
  });
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function versionReader(
  value: string | (() => string),
): () => string {
  return typeof value === "function" ? value : () => value;
}

function requireApplicationOptions(
  options: WishApplicationOptions,
): void {
  if (options === null || typeof options !== "object") {
    throw new Error("WishApplication requires options");
  }
  if (options.agent === null || typeof options.agent !== "object") {
    throw new Error("WishApplication requires an Agent definition");
  }
  if (options.models === null || typeof options.models !== "object") {
    throw new Error("WishApplication requires Models options");
  }
  if (options.context === null || typeof options.context !== "object") {
    throw new Error("WishApplication requires Context options");
  }
  if (options.compaction === null || typeof options.compaction !== "object") {
    throw new Error("WishApplication requires Compaction options");
  }
  if (options.workspace === null || typeof options.workspace !== "object" ||
    typeof options.workspace.resolve !== "function") {
    throw new Error("WishApplication requires a workspace resolver");
  }
}

function snapshotRequestOptions(
  input: AgentLoopRequestOptions | undefined,
): AgentLoopRequestOptions | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object") {
    throw new Error("Wish request options must be an object");
  }
  return Object.freeze({
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.metadata === undefined
      ? {}
      : {
          metadata: snapshotPlainValue(input.metadata) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
}

function snapshotPlainValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(snapshotPlainValue));
  }
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, snapshotPlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function normalizeDirectory(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed path`);
  }
  return resolve(value);
}

function requireUserText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Wish Application operation was aborted", {
    cause: signal.reason,
  });
}
