import { randomUUID } from "node:crypto";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  AgentLoopResources,
  OpenAgentLoopInput,
} from "./agent-loop-service.js";
import type { AgentRuntimeService } from "../core/agent/agent.js";
import type {
  WishAgentConfiguration,
  WishAgentProtocol,
  WishRunGeneration,
  WishRunPayload,
} from "../apps/types.js";
import type {
  AgentLoopMemory,
  AgentLoopResult,
} from "../core/agent-loop/agent-loop.js";
import {
  Runtime as CoreRuntime,
  type RuntimeOptions as CoreRuntimeOptions,
} from "../core/runtime/runtime.js";
import type { RuntimeLifecycleService } from "../core/runtime/lifecycle.js";
import {
  RunGeneration,
  type RunGenerationRetireOptions,
} from "../core/runtime/generation.js";
import type {
  RunContinuationFactory,
  RunFollowUp,
} from "../core/runtime/continuation.js";
import type { ModelRef } from "../core/model/model.js";
import { registerPluginOwner } from "../boot/plugin-control/owner-registry.js";
import { StepExecutionCoordinator, StepExecutionError } from "./step-execution.js";
import type {} from "../boot/plugin-control/code-reload.js";

export const DEFAULT_RUN_GENERATION_DRAIN_TIMEOUT_MS = 30_000;

/** Loader-owned Runtime execution limits. */
export interface Config {
  readonly maxSteps?: number;
  readonly generationDrainTimeoutMs?: number;
}

export const Config: s<Config> = s.object({
  maxSteps: s.number().step(1).min(1),
  generationDrainTimeoutMs: s.number().step(1).min(1),
});

export type WishRuntime = CoreRuntime<
  WishAgentConfiguration,
  WishRunPayload,
  AgentLoopMemory,
  AgentLoopResult
>;

export type { WishRunGeneration } from "../apps/types.js";

export type WishRuntimeOptions = Pick<
  CoreRuntimeOptions<
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

/** Narrow capability consumed by the Agent owner. */
export interface RuntimeDependencies {
  readonly runtime: AgentRuntimeService<WishAgentProtocol>;
}

/** Explicit standalone composition helper; product processes use the service. */
export function createWishRuntime(
  agentLoop: Pick<CoreRuntimeOptions<WishAgentConfiguration, WishRunPayload, AgentLoopMemory, AgentLoopResult>, "stepPipeline">,
  options: WishRuntimeOptions = {},
  lifecycle?: RuntimeLifecycleService<WishRunPayload, AgentLoopResult>,
): WishRuntime {
  return new CoreRuntime({
    ...options,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    stepPipeline: agentLoop.stepPipeline,
  });
}

export interface OpenRuntimeInput extends OpenAgentLoopInput {
  readonly runtime?: WishRuntimeOptions;
}

export interface RuntimeResources extends RuntimeDependencies {
  readonly runtime: WishRunGeneration;
  readonly sessions: AgentLoopResources["sessions"];
  readonly models: AgentLoopResources["models"];
  readonly generation: WishRunGeneration;
}

/** Cordis owner of the process-local Run controller. */
export class Runtime extends Service {
  static readonly inject = ["launch", "sessions", "models", "runtimeLifecycle"];
  static readonly Config = Config;

  readonly maxSteps: number | undefined;
  readonly generationDrainTimeoutMs: number;
  /** Host-only Step boundary. Does not unload plugins or own their configuration. */
  readonly execution = new StepExecutionCoordinator();
  private readonly generations = new Set<WishRunGeneration>();
  private suspended = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(ctx: Context, config: Config = {}) {
    // Cordis reserves ctx.runtime for the current plugin runtime accessor.
    super(ctx, "runEngine");
    ctx.root.get("codeReload")?.registerBoundary(ctx, this.execution);
    this.maxSteps = config.maxSteps;
    this.generationDrainTimeoutMs = positiveInteger(
      config.generationDrainTimeoutMs ??
        DEFAULT_RUN_GENERATION_DRAIN_TIMEOUT_MS,
      "Runtime generation drain timeout",
    );
    ctx.effect(() => () => this.close(), "runtime admission");
    registerPluginOwner(ctx, {
      replacement: "generation",
      status: () => {
        const snapshot = this.lifecycleSnapshot();
        return {
          disposition: this.closed ? "blocked" : snapshot.activeRuns > 0 || snapshot.retiring > 0 ? "drain" : "direct",
          code: this.closed ? "runtime_closed" : snapshot.retiring > 0 ? "runtime_retiring" : snapshot.activeRuns > 0 ? "runtime_active_runs" : "runtime_idle",
          counts: { generations: snapshot.generations, active_runs: snapshot.activeRuns, retiring: snapshot.retiring },
        };
      },
      prepare: () => {
        if (this.suspended || this.closed) throw new Error("Runtime admission is closed");
        this.suspended = true;
        const generations = [...this.generations];
        const release = generations.map(generation => generation.suspendAdmission());
        return {
          // Runs are explicit generations. Native teardown or disable retires
          // them deterministically; no JavaScript stack is migrated.
          drained: Promise.resolve(),
          deactivate: () => this.close(),
          release: () => {
            if (this.closing || this.closed) return;
            this.suspended = false;
            for (const resume of release) resume();
          },
        };
      },
    });
  }

  /** Aggregate actual owned generations without exposing Run identities or payloads. */
  lifecycleSnapshot(): { readonly generations: number; readonly activeRuns: number; readonly retiring: number } {
    const snapshots = [...this.generations].map(generation => generation.snapshot());
    return Object.freeze({ generations: snapshots.length,
      activeRuns: snapshots.reduce((count, snapshot) => count + snapshot.activeRuns.length, 0),
      retiring: snapshots.filter(snapshot => snapshot.state === "retiring").length });
  }

  private close(): Promise<void> {
    this.suspended = true;
    this.closed = true;
    return this.closing ??= Promise.all([...this.generations].map(generation => generation.retire()))
      .then(() => { this.execution.close(); });
  }

  /** Stable Run owner; only execution resources are acquired anew per Step. */
  open(input: OpenRuntimeInput): RuntimeResources {
    if (this.suspended || this.closed) throw new Error("Runtime admission is closed");
    this.requireAgentLoop();
    let coreRuntime: WishRuntime | undefined;
    const runContinuations: RunContinuationFactory = Object.freeze({
      resolve: ({ agentId, runId, model }: {
        readonly agentId: string;
        readonly runId: string;
        readonly model: ModelRef;
      }) => Object.freeze({
        deferCompletion: (reason: string) =>
          coreRuntime?.deferRunCompletion(runId, reason),
        followUp: (input: RunFollowUp) => {
          if (coreRuntime === undefined) {
            return Object.freeze({ accepted: false, reason: "runtime_not_ready" });
          }
          const receipt = coreRuntime.control(agentId, runId, {
            type: "follow_up",
            source: input.source,
            text: input.text,
            ...(input.reserveCapacity === undefined
              ? {}
              : { reserveCapacity: input.reserveCapacity }),
            payload: Object.freeze({ text: input.text, model }),
          });
          return Object.freeze({
            accepted: receipt.accepted,
            ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
          });
        },
      }),
    });
    const { runtime: _runtime, runContinuations: _continuations, ...configuration } = input;
    const pipelineInput = Object.freeze({ ...structuredClone(configuration), runContinuations });
    // Session storage and Application-facing model resources have stable owners;
    // they must not disappear when an ordinary execution implementation unloads.
    const sessions = this.ctx.sessions.acquire(input.dataDirectory);
    const generations = this.generations;
    try {
      const models = this.ctx.models.open(input.modelsConfiguration);
      const stepPipeline = this.execution.source(() => {
        const resources = this.requireAgentLoop().open(pipelineInput);
        return { pipeline: resources.stepPipeline, release: () => { resources.release(); } };
      });
      const configuredMaxSteps = input.runtime?.maxSteps ?? this.maxSteps;
      coreRuntime = createWishRuntime({ stepPipeline }, {
        ...(input.runtime ?? {}),
        ...(configuredMaxSteps === undefined
          ? {}
          : { maxSteps: configuredMaxSteps }),
      }, this.ctx.runtimeLifecycle);
      const generation = new RunGeneration<WishAgentProtocol>(coreRuntime, {
        id: `${input.agentId}:${randomUUID()}`,
        drainTimeoutMs: this.generationDrainTimeoutMs,
        assertAdmission: () => {
          this.requireAgentLoop();
          const phase = this.execution.snapshot().phase;
          if (phase === "failed" || phase === "closed") throw new StepExecutionError(`step_execution_${phase}`);
        },
        abortControl: ({ reason }) => Object.freeze({
          type: "abort" as const,
          source: "wish-run-generation",
          reason,
        }),
        release: () => {
          sessions.release();
          generations.delete(generation);
        },
      });
      const launch = this.ctx.get("launch");
      const logger = this.ctx.logger("run-generation");
      this.ctx.effect(() => () => generation.retire({
        reason: `Cordis released Run generation ${generation.id}`,
        onDrainTimeout: (error) => {
          logger.error(error);
          launch?.fail(error);
        },
      }), `Run generation ${generation.id}`);
      generations.add(generation);
      return Object.freeze({
        sessions,
        models,
        runtime: generation,
        generation,
      });
    } catch (error: unknown) {
      sessions.release();
      throw error;
    }
  }

  private requireAgentLoop(): Context["agentLoop"] {
    // Deliberately a dynamic lookup, not a captured hard dependency: the Step
    // lease and Host replacement barrier protect execution, not Fiber teardown.
    const provider = this.ctx.get("agentLoop");
    if (!provider) throw new StepExecutionError("step_execution_unavailable");
    return provider;
  }
}

export type { RunGenerationRetireOptions };

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    runEngine: Runtime;
  }
}

export default Runtime;
