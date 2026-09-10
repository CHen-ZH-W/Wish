import { Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  WishAgentConfiguration,
  WishRunPayload,
  WishWorkspaceResolver,
} from "../../apps/types.js";
import {
  ContextOverflowRecoveryPipeline,
  type ContextOverflowCompactor,
} from "../../compaction/index.js";
import {
  AgentLoop as CoreAgentLoop,
  type AgentLoopInputRenderer,
  type AgentLoopMemory,
  type AgentLoopRequestOptions,
  type AgentLoopResult,
} from "./agent-loop.js";
import type { StepPipeline } from "../runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
} from "../tools/scheduler.js";
import type { ContextBundle } from "../../context/index.js";
import type { ContextInput, ContextInstruction } from "../../context/types.js";
import type { ModelDependencies } from "../../models/runtime.js";
import type { ModelsConfiguration } from "../../models/types.js";
import {
  SessionArchivedError,
  type SessionManager,
  SessionNotFoundError,
  SessionTranscriptPipeline,
  createSessionInputRenderer,
  sessionIdFromRunScope,
} from "../../sessions/index.js";
import type { SessionResources } from "../../sessions/service.js";
import type { Session } from "../../sessions/types.js";
import {
  InteractiveToolAuthorizationService,
  createBasicToolResultRenderer,
  createDenyAllToolAuthorizationService,
  registerBasicTools,
  type BasicToolContext,
  type BasicToolName,
  type BasicToolsOptions,
  type ToolApprovalPort,
} from "../../tools/index.js";

/** Loader-owned AgentLoop scheduling settings. */
export interface Config {
  readonly maxParallelCalls?: number;
}

export const Config: s<Config> = s.object({
  maxParallelCalls: s.number().step(1).min(1),
});

export type WishStepPipeline = StepPipeline<
  WishAgentConfiguration,
  WishRunPayload,
  AgentLoopMemory,
  AgentLoopResult
>;

/** Narrow capability consumed by the Runtime owner. */
export interface AgentLoopDependencies {
  readonly stepPipeline: WishStepPipeline;
}

/** Session view required by the AgentLoop composition. */
export interface AgentLoopSessionDependencies {
  readonly manager: SessionManager;
}

export interface AgentLoopToolsOptions {
  /** Cordis compositions provide their shared dynamic Registry. */
  readonly registry?: ToolRegistry<BasicToolContext>;
  readonly approval?: ToolApprovalPort<BasicToolContext>;
  readonly policyVersion?: string | (() => string);
  readonly authorityVersion?: string | (() => string);
  readonly availableTools?: readonly BasicToolName[];
  readonly maxParallelCalls?: number;
  /** Standalone-only options used when no Registry is supplied. */
  readonly basic?: BasicToolsOptions;
}

export interface CreateAgentLoopPipelineOptions {
  readonly sessions: AgentLoopSessionDependencies;
  readonly agentId: string;
  readonly models: ModelDependencies;
  readonly workspace: WishWorkspaceResolver;
  readonly context: ContextBundle;
  readonly compaction: ContextOverflowCompactor;
  readonly tools?: AgentLoopToolsOptions;
  readonly request?: AgentLoopRequestOptions;
}

/** Explicit standalone composition helper; product processes use the service. */
export function createAgentLoopPipeline(
  options: CreateAgentLoopPipelineOptions,
): WishStepPipeline {
  const agentId = requireIdentifier(options.agentId, "AgentLoop Agent id");
  const sessions = options.sessions.manager;
  const modelStack = options.models;
  const context = options.context;
  const requestOptions = snapshotRequestOptions(options.request);
  const toolRegistry = options.tools?.registry ??
    new ToolRegistry<BasicToolContext>();
  if (options.tools?.registry === undefined) {
    registerBasicTools(toolRegistry, options.tools?.basic);
  }
  const authorization = options.tools?.approval === undefined
    ? createDenyAllToolAuthorizationService<BasicToolContext>()
    : new InteractiveToolAuthorizationService({
      approval: options.tools.approval,
      policyVersion: options.tools.policyVersion ?? "wish-app-policy-v1",
    });
  const scheduler = new BoundedToolScheduler({
    executor: new ToolExecutor({ registry: toolRegistry, authorization }),
    ...(options.tools?.maxParallelCalls === undefined
      ? {}
      : { maxParallelCalls: options.tools.maxParallelCalls }),
  });
  const availableTools = options.tools?.availableTools === undefined
    ? undefined
    : Object.freeze([...options.tools.availableTools]);
  const authorityVersion = versionReader(
    options.tools?.authorityVersion ?? "wish-app-authority-v1",
  );

  const baseInput: AgentLoopInputRenderer<WishRunPayload> = {
    renderUserInput({ payload }) {
      return Object.freeze({
        role: "user" as const,
        content: requireUserText(payload.text, "Wish Run input"),
      });
    },
    renderSteering({ message }) {
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
  const loop = new CoreAgentLoop<
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
        const workspace = await options.workspace.resolve({ session, signal });
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
              ? availableTools ?? Object.freeze(
                  toolRegistry.list().map((tool) => tool.name),
                )
              : Object.freeze([]),
          }),
          ...(requestOptions === undefined ? {} : { request: requestOptions }),
        });
      },
    },
  });
  const recovery = new ContextOverflowRecoveryPipeline({
    delegate: loop,
    compactor: options.compaction,
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
  return new SessionTranscriptPipeline({
    delegate: recovery,
    sessions,
  });
}

export interface OpenAgentLoopInput {
  readonly dataDirectory: string;
  readonly agentId: string;
  readonly agentInstructions: readonly ContextInstruction[];
  readonly modelsConfiguration: ModelsConfiguration;
  readonly reservedOutputTokens: number;
  readonly keepRecentTokens: number;
  readonly summaryMaxOutputTokens: number;
  readonly workspace?: WishWorkspaceResolver;
  readonly approval?: ToolApprovalPort<BasicToolContext>;
  readonly policyVersion?: string | (() => string);
  readonly authorityVersion?: string | (() => string);
  readonly availableTools?: readonly BasicToolName[];
  readonly maxParallelCalls?: number;
  readonly request?: AgentLoopRequestOptions;
}

export interface AgentLoopResources extends AgentLoopDependencies {
  readonly sessions: SessionResources;
  readonly models: ModelDependencies;
}

/** Cordis owner of the Tool execution and complete Agent Step pipeline. */
export class AgentLoop extends Service {
  static readonly inject = [
    "sessions",
    "models",
    "contextEngine",
    "compaction",
    "tools",
  ];
  static readonly Config = Config;

  readonly maxParallelCalls: number | undefined;

  constructor(ctx: CordisContext, config: Config = {}) {
    super(ctx, "agentLoop");
    this.maxParallelCalls = config.maxParallelCalls;
  }

  /** Build one Application generation from the currently injected services. */
  open(input: OpenAgentLoopInput): AgentLoopResources {
    const sessions = this.ctx.sessions.open(input.dataDirectory);
    const models = this.ctx.models.open(input.modelsConfiguration);
    const context = this.ctx.contextEngine.open({
      dataDirectory: input.dataDirectory,
      agentInstructions: input.agentInstructions,
      models,
      configuration: {
        reservedOutputTokens: input.reservedOutputTokens,
      },
    });
    const compaction = this.ctx.compaction.open({
      dataDirectory: input.dataDirectory,
      models,
      keepRecentTokens: input.keepRecentTokens,
      summaryMaxOutputTokens: input.summaryMaxOutputTokens,
    });
    const maxParallelCalls = input.maxParallelCalls ?? this.maxParallelCalls;
    const stepPipeline = createAgentLoopPipeline({
      sessions,
      agentId: input.agentId,
      models,
      workspace: input.workspace ?? SESSION_SCOPE_WORKSPACE,
      context,
      compaction,
      tools: {
        registry: this.ctx.tools.registry,
        ...(input.approval === undefined ? {} : { approval: input.approval }),
        ...(input.policyVersion === undefined
          ? {}
          : { policyVersion: input.policyVersion }),
        ...(input.authorityVersion === undefined
          ? {}
          : { authorityVersion: input.authorityVersion }),
        ...(input.availableTools === undefined
          ? {}
          : { availableTools: input.availableTools }),
        ...(maxParallelCalls === undefined ? {} : { maxParallelCalls }),
      },
      ...(input.request === undefined ? {} : { request: input.request }),
    });
    return Object.freeze({ sessions, models, stepPipeline });
  }
}

const SESSION_SCOPE_WORKSPACE: WishWorkspaceResolver = Object.freeze({
  resolve(
    { session }: Parameters<WishWorkspaceResolver["resolve"]>[0],
  ) {
    return Object.freeze({
      cwd: session.scope,
      instructions: Object.freeze([]),
    });
  },
});

async function requireActiveOwnedSession(
  sessions: SessionManager,
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Session> {
  const session = await sessions.get({
    sessionId,
    ...(signal === undefined ? {} : { signal }),
  });
  if (session.agentId !== agentId) throw new SessionNotFoundError(sessionId);
  if (session.status === "archived") {
    throw new SessionArchivedError(session.sessionId);
  }
  return session;
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
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotPlainValue));
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

function versionReader(value: string | (() => string)): () => string {
  return typeof value === "function" ? value : () => value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireUserText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("AgentLoop operation was aborted", { cause: signal.reason });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agentLoop: AgentLoop;
  }
}

export default AgentLoop;
