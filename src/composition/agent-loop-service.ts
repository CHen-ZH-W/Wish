import { Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

import type {
  WishAgentConfiguration,
  WishRunPayload,
} from "../apps/types.js";
import {
  ContextOverflowRecoveryPipeline,
  type ContextOverflowCompactor,
} from "../compaction/index.js";
import {
  AgentLoop as CoreAgentLoop,
  type AgentLoopInputRenderer,
  type AgentLoopMemory,
  type AgentLoopRequestOptions,
  type AgentLoopResult,
  type AgentLoopToolResultRenderer,
} from "../core/agent-loop/agent-loop.js";
import type { StepPipeline } from "../core/runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  type ToolRegistry,
  type ToolExecutionLifecycle,
} from "../core/tools/scheduler.js";
import type { ContextBundle } from "../context/index.js";
import type { ContextBundleHandle } from "../context/service.js";
import type {
  ContextInput,
  ContextInstruction,
  ContextWorkspaceFacts,
} from "../context/types.js";
import type { ModelDependencies } from "../models/runtime.js";
import type { ModelInstruction } from "../core/model/model.js";
import type { ModelsConfiguration } from "../models/types.js";
import type {} from "../models/pricing/service.js";
import {
  SessionArchivedError,
  type SessionManager,
  SessionNotFoundError,
  SessionTranscriptPipeline,
  createSessionInputRenderer,
  sessionIdFromRunScope,
} from "../sessions/index.js";
import type { SessionResourcesHandle } from "../sessions/service.js";
import type { Session } from "../sessions/types.js";
import {
  snapshotWorkspace,
  type WorkspaceResolver,
  type WorkspaceSnapshot,
} from "../workspace/index.js";
import {
  TOOL_CAPABILITY_KINDS,
  type PermissionAuthority,
  type PermissionSnapshot,
} from "../permissions/index.js";
import {
  createUnavailableFilesystem,
  type Filesystem,
} from "../filesystem/index.js";
import {
  createUnavailableShell,
  type Shell,
} from "../shell/index.js";
import {
  InteractiveToolAuthorizationService,
  createDenyAllToolAuthorizationService,
  type ToolApprovalPort,
} from "../tools/index.js";
import { createBasicToolResultRenderer } from "../tools/presentation/result-renderer.js";
import type { WishToolExecutionContext } from "./tool-context.js";
import type { RunContinuationFactory } from "../core/runtime/continuation.js";

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
  readonly registry: ToolRegistry<WishToolExecutionContext>;
  readonly approval?: ToolApprovalPort<WishToolExecutionContext>;
  readonly policyVersion?: string | (() => string);
  readonly authorityVersion?: string | (() => string);
  readonly availableTools?: readonly string[];
  readonly maxParallelCalls?: number;
  readonly resultRenderer?: AgentLoopToolResultRenderer<WishRunPayload>;
}

export interface CreateAgentLoopPipelineOptions {
  readonly sessions: AgentLoopSessionDependencies;
  readonly agentId: string;
  readonly models: ModelDependencies;
  /** Credential-free Model configuration fixed for this pipeline generation. */
  readonly modelsConfiguration?: ModelsConfiguration;
  readonly workspace: WorkspaceResolver;
  /** Product graphs inject this; omission is a fail-closed standalone setup. */
  readonly filesystem?: Filesystem;
  /** Product graphs inject this; omission is a fail-closed standalone setup. */
  readonly shell?: Shell;
  /** Product graphs inject this; standalone callers may use explicit approval. */
  readonly permissions?: PermissionAuthority;
  readonly context: ContextBundle;
  /** Resolves stable model instructions after final Tool permission filtering. */
  readonly resolveInstructions?: (input: {
    readonly availableTools: readonly string[];
  }) => readonly ModelInstruction[];
  readonly compaction: ContextOverflowCompactor;
  /** Product graphs bind the durable Runtime-owned Tool lifecycle authority. */
  readonly toolLifecycle?: ToolExecutionLifecycle<WishToolExecutionContext>;
  readonly tools: AgentLoopToolsOptions;
  readonly request?: AgentLoopRequestOptions;
  readonly runContinuations?: RunContinuationFactory;
}

/** Build a Step pipeline over an explicitly supplied Tool Registry. */
export function createAgentLoopPipeline(
  options: CreateAgentLoopPipelineOptions,
): WishStepPipeline {
  const agentId = requireIdentifier(options.agentId, "AgentLoop Agent id");
  const sessions = options.sessions.manager;
  const modelStack = options.models;
  const context = options.context;
  const filesystem = options.filesystem ?? createUnavailableFilesystem();
  const shell = options.shell ?? createUnavailableShell();
  const requestOptions = snapshotRequestOptions(options.request);
  const toolRegistry = options.tools.registry;
  const legacyPolicyVersion = versionReader(
    options.tools?.policyVersion ?? "wish-app-policy-v1",
  );
  const authorization = options.tools?.approval !== undefined
    ? new InteractiveToolAuthorizationService({
      approval: options.tools.approval,
      policyVersion: legacyPolicyVersion,
    })
    : options.permissions ??
      createDenyAllToolAuthorizationService<WishToolExecutionContext>();
  const scheduler = new BoundedToolScheduler({
    executor: new ToolExecutor({
      registry: toolRegistry,
      authorization,
      ...(options.toolLifecycle === undefined
        ? {}
        : { lifecycle: options.toolLifecycle }),
    }),
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
  const workspacesByStep = new WeakMap<object, Promise<WorkspaceSnapshot>>();
  const permissionsByStep = new WeakMap<object, Promise<PermissionSnapshot>>();

  function resolveWorkspace(
    step: object,
    root: string,
    signal: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    let resolved = workspacesByStep.get(step);
    if (resolved !== undefined) return resolved;
    resolved = Promise.resolve(options.workspace.resolve({ root, signal })).then(
      snapshotWorkspace,
    );
    workspacesByStep.set(step, resolved);
    return resolved;
  }

  function resolvePermissions(
    step: object,
    request: Parameters<PermissionAuthority["resolve"]>[0],
  ): Promise<PermissionSnapshot> {
    let resolved = permissionsByStep.get(step);
    if (resolved !== undefined) return resolved;
    resolved = options.permissions === undefined
      ? Promise.resolve(legacyPermissionSnapshot({
          subject: request.subject,
          workspace: request.workspace,
          registeredTools: request.registeredTools,
          policyVersion: legacyPolicyVersion(),
          authorityVersion: authorityVersion(),
          filesystemPolicyVersion: filesystem.policy.version,
          shellPolicyVersion: shell.policy.version,
          sandboxPolicyVersion: "sandbox-standalone-v1",
        }))
      : Promise.resolve(options.permissions.resolve(request));
    permissionsByStep.set(step, resolved);
    return resolved;
  }

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
    delegate: options.tools?.resultRenderer ?? createBasicToolResultRenderer(),
    resolveSessionId: ({ snapshot }) => sessionIdFromRunScope(snapshot),
  });
  const loop = new CoreAgentLoop<
    WishAgentConfiguration,
    WishRunPayload,
    ContextInput,
    WishToolExecutionContext
  >({
    model: modelStack.model,
    context: context.projector,
    tools: toolRegistry,
    toolScheduler: scheduler,
    input,
    toolResults,
    environment: {
      async resolve({ definition, snapshot, memory, signal }) {
        const sessionId = sessionIdFromRunScope(snapshot);
        const session = await requireActiveOwnedSession(
          sessions,
          agentId,
          sessionId,
          signal,
        );
        const workspace = await resolveWorkspace(
          snapshot,
          session.scope,
          signal,
        );
        throwIfAborted(signal);
        const model = modelStack.configuredModel.resolve(
          memory?.model ?? snapshot.userTurn.input.model ??
            modelStack.configuredModel.getDefaultModel(),
        ).ref;
        const modelSpec = modelStack.configuredModel.getModelSpec(model);
        const registeredTools = modelSpec.toolCalling
          ? availableTools ?? Object.freeze(
              toolRegistry.list().map((tool) => tool.name),
            )
          : Object.freeze([]);
        const permissions = await resolvePermissions(snapshot, {
          ...(definition.configuration?.permissions === undefined
            ? {}
            : { agent: definition.configuration.permissions }),
          subject: {
            agentId: snapshot.run.agentId,
            sessionId,
            runId: snapshot.run.runId,
            userTurnId: snapshot.userTurn.userTurnId,
            stepId: snapshot.step.stepId,
          },
          workspace,
          registeredTools,
          signal,
        });
        throwIfAborted(signal);
        const contextEnvironment = context.forStep({
          snapshot,
          sessionId,
          model,
          workspace: contextWorkspaceFacts(workspace),
        });
        const instructions = snapshotModelInstructions(
          options.resolveInstructions?.({
            availableTools: permissions.availableTools,
          }) ?? [],
        );
        return Object.freeze({
          model,
          instructions,
          context: contextEnvironment,
          tools: Object.freeze({
            context: Object.freeze({
              cwd: workspace.root,
              workspace,
              permissions,
              sessionHistory: Object.freeze({
                read(signal?: AbortSignal) {
                  return sessions.readHistory({ sessionId, ...(signal === undefined ? {} : { signal }) });
                },
              }),
              modelContext: Object.freeze({
                ref: model,
                ...(options.modelsConfiguration === undefined
                  ? {}
                  : { configuration: options.modelsConfiguration }),
              }),
              modelSupportsImages: modelSpec.input.image,
              ...(options.runContinuations === undefined
                ? {}
                : {
                    runContinuation: options.runContinuations.resolve({
                      agentId: snapshot.run.agentId,
                      runId: snapshot.run.runId,
                      model,
                    }),
                  }),
            }),
            authorityVersion: permissions.authorityVersion,
            availableTools: permissions.availableTools,
            metadata: Object.freeze({
              permissionProfile: permissions.profile,
              permissionPolicyVersion: permissions.policyVersion,
              filesystemPolicyVersion: permissions.filesystemPolicyVersion,
              shellPolicyVersion: permissions.shellPolicyVersion,
              workspaceFingerprint: workspace.fingerprint,
              workspaceRevision: workspace.revision,
            }),
          }),
          request: Object.freeze({
            ...(requestOptions ?? {}),
            ...(snapshot.userTurn.input.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: snapshot.userTurn.input.reasoningEffort }),
            invocationScope: Object.freeze({
              sessionId,
              runId: snapshot.run.runId,
              userTurnId: snapshot.userTurn.userTurnId,
              stepId: snapshot.step.stepId,
            }),
          }),
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
  readonly maxParallelCalls?: number;
  readonly request?: AgentLoopRequestOptions;
  readonly runContinuations?: RunContinuationFactory;
}

export interface AgentLoopResources extends AgentLoopDependencies {
  readonly sessions: SessionResourcesHandle;
  readonly models: ModelDependencies;
  readonly context: ContextBundleHandle;
  readonly released: boolean;
  release(): boolean;
}

/** Cordis owner of the Tool execution and complete Agent Step pipeline. */
export class AgentLoop extends Service {
  static readonly inject = [
    "sessions",
    "models",
    "modelAttemptLedger",
    "contextEngine",
    "systemPrompt",
    "compaction",
    "tools",
    "workspace",
    "permissions",
    "runtimeLifecycle",
  ];
  static readonly Config = Config;

  readonly maxParallelCalls: number | undefined;
  private readonly work: PluginWorkOwner;

  constructor(ctx: CordisContext, config: Config = {}) {
    super(ctx, "agentLoop");
    this.work = new PluginWorkOwner(ctx, { code: "agent_loop", codeReload: true });
    this.maxParallelCalls = config.maxParallelCalls;
  }

  /** Build one Application generation from the currently injected services. */
  open(input: OpenAgentLoopInput): AgentLoopResources {
    // Returned pipeline leases belong to Runtime's Step boundary. Waiting for
    // them during involuntary dependency loss would deadlock authority teardown.
    this.work.assertOpen();
    const sessions = this.ctx.sessions.acquire(input.dataDirectory);
    let context: ContextBundleHandle | undefined;
    try {
      const models = this.ctx.models.open(input.modelsConfiguration, {
        attemptLedger: {
          ledger: this.ctx.modelAttemptLedger,
          currency: this.ctx.modelAttemptLedger.currency,
        },
      });
      context = this.ctx.contextEngine.open({
        dataDirectory: input.dataDirectory,
        models,
        configuration: {
          reservedOutputTokens: this.ctx.contextEngine.reservedOutputTokens ?? input.reservedOutputTokens,
        },
      });
      const ownedContext = context;
      const compaction = this.ctx.compaction.open({
        dataDirectory: input.dataDirectory,
        models,
        keepRecentTokens: this.ctx.compaction.keepRecentTokens ?? input.keepRecentTokens,
        summaryMaxOutputTokens: this.ctx.compaction.summaryMaxOutputTokens ?? input.summaryMaxOutputTokens,
      });
      const maxParallelCalls = input.maxParallelCalls ?? this.maxParallelCalls;
      const stepPipeline = createAgentLoopPipeline({
        sessions,
        agentId: input.agentId,
        models,
        modelsConfiguration: input.modelsConfiguration,
        workspace: this.ctx.workspace,
        permissions: this.ctx.permissions,
        toolLifecycle: this.ctx.runtimeLifecycle,
        context: ownedContext,
        resolveInstructions: ({ availableTools }) => Object.freeze([
          ...this.ctx.systemPrompt.assembleInstructions({ availableTools }),
          ...input.agentInstructions.map((instruction) => Object.freeze({
            role: instruction.authority,
            content: instruction.content,
          })),
        ]),
        compaction,
        tools: {
          registry: this.ctx.tools.registry,
          resultRenderer: this.ctx.tools.createResultRenderer(
            createBasicToolResultRenderer(),
          ),
          ...(maxParallelCalls === undefined ? {} : { maxParallelCalls }),
        },
        ...(input.runContinuations === undefined
          ? {}
          : { runContinuations: input.runContinuations }),
        ...(input.request === undefined ? {} : { request: input.request }),
      });
      let released = false;
      return Object.freeze({
        sessions,
        models,
        context: ownedContext,
        stepPipeline,
        get released(): boolean {
          return released;
        },
        release(): boolean {
          if (released) return false;
          released = true;
          try {
            ownedContext.release();
          } finally {
            sessions.release();
          }
          return true;
        },
      });
    } catch (error: unknown) {
      try { context?.release(); }
      finally { sessions.release(); }
      throw error;
    }
  }
}

function legacyPermissionSnapshot(input: {
  readonly subject: PermissionSnapshot["subject"];
  readonly workspace: WorkspaceSnapshot;
  readonly registeredTools: readonly string[];
  readonly policyVersion: string;
  readonly authorityVersion: string;
  readonly filesystemPolicyVersion: string;
  readonly shellPolicyVersion: string;
  readonly sandboxPolicyVersion: string;
}): PermissionSnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    subject: Object.freeze({ ...input.subject }),
    profile: "approval-required" as const,
    availableTools: Object.freeze([...input.registeredTools]),
    ceiling: Object.freeze({
      allowedCapabilities: Object.freeze([...TOOL_CAPABILITY_KINDS]),
    }),
    workspace: Object.freeze({
      fingerprint: input.workspace.fingerprint,
      revision: input.workspace.revision,
    }),
    filesystemPolicyVersion: requireIdentifier(
      input.filesystemPolicyVersion,
      "Legacy Filesystem policy version",
    ),
    shellPolicyVersion: requireIdentifier(
      input.shellPolicyVersion,
      "Legacy Shell policy version",
    ),
    sandboxPolicyVersion: requireIdentifier(
      input.sandboxPolicyVersion,
      "Legacy SandboxPolicy version",
    ),
    policyVersion: requireIdentifier(
      input.policyVersion,
      "Legacy permission policy version",
    ),
    authorityVersion: requireIdentifier(
      input.authorityVersion,
      "Legacy permission authority version",
    ),
  });
}

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

function contextWorkspaceFacts(
  workspace: WorkspaceSnapshot,
): ContextWorkspaceFacts {
  return Object.freeze({
    cwd: workspace.root,
    fingerprint: workspace.fingerprint,
    revision: workspace.revision,
    instructions: Object.freeze(workspace.instructions.map((instruction) =>
      Object.freeze({
        id: instruction.id,
        authority: instruction.authority,
        content: instruction.content,
      })
    )),
    ...(workspace.repository === undefined
      ? {}
      : { repository: workspace.repository }),
  });
}

function snapshotModelInstructions(
  instructions: readonly ModelInstruction[],
): readonly ModelInstruction[] {
  if (!Array.isArray(instructions)) {
    throw new Error("Wish model instructions must be an array");
  }
  return Object.freeze(instructions.map((instruction, index) => {
    if (instruction === null || typeof instruction !== "object") {
      throw new Error(`Wish model instruction ${index + 1} must be an object`);
    }
    if (instruction.role !== "system" && instruction.role !== "developer") {
      throw new Error(`Wish model instruction ${index + 1} has an invalid role`);
    }
    if (typeof instruction.content !== "string" || instruction.content.trim().length === 0) {
      throw new Error(`Wish model instruction ${index + 1} must contain text`);
    }
    return Object.freeze({ role: instruction.role, content: instruction.content });
  }));
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
