import { randomUUID } from "node:crypto";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  AgentLoopDependencies,
  AgentLoopResources,
  OpenAgentLoopInput,
} from "../agent-loop/service.js";
import type { AgentRuntimeService } from "../agent/agent.js";
import type {
  WishAgentConfiguration,
  WishAgentProtocol,
  WishRunGeneration,
  WishRunPayload,
} from "../../apps/types.js";
import type {
  AgentLoopMemory,
  AgentLoopResult,
} from "../agent-loop/agent-loop.js";
import {
  Runtime as CoreRuntime,
  type RuntimeOptions as CoreRuntimeOptions,
} from "./runtime.js";
import {
  RunGeneration,
  type RunGenerationRetireOptions,
} from "./generation.js";

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

export type { WishRunGeneration } from "../../apps/types.js";

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
  agentLoop: AgentLoopDependencies,
  options: WishRuntimeOptions = {},
): WishRuntime {
  return new CoreRuntime({
    ...options,
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
  static readonly inject = ["agentLoop"];
  static readonly Config = Config;

  readonly maxSteps: number | undefined;
  readonly generationDrainTimeoutMs: number;

  constructor(ctx: Context, config: Config = {}) {
    // Cordis reserves ctx.runtime for the current plugin runtime accessor.
    super(ctx, "runEngine");
    this.maxSteps = config.maxSteps;
    this.generationDrainTimeoutMs = positiveInteger(
      config.generationDrainTimeoutMs ??
        DEFAULT_RUN_GENERATION_DRAIN_TIMEOUT_MS,
      "Runtime generation drain timeout",
    );
  }

  /** Build one Application generation from the current AgentLoop generation. */
  open(input: OpenRuntimeInput): RuntimeResources {
    const agentLoop = this.ctx.agentLoop.open(input);
    const configuredMaxSteps = input.runtime?.maxSteps ?? this.maxSteps;
    const coreRuntime = createWishRuntime(agentLoop, {
      ...(input.runtime ?? {}),
      ...(configuredMaxSteps === undefined
        ? {}
        : { maxSteps: configuredMaxSteps }),
    });
    const generation = new RunGeneration<WishAgentProtocol>(coreRuntime, {
      id: `${input.agentId}:${randomUUID()}`,
      drainTimeoutMs: this.generationDrainTimeoutMs,
      abortControl: ({ reason }) => Object.freeze({
        type: "abort" as const,
        source: "wish-run-generation",
        reason,
      }),
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
    return Object.freeze({
      sessions: agentLoop.sessions,
      models: agentLoop.models,
      runtime: generation,
      generation,
    });
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
