import type { AgentDefinition } from "../core/agent/agent.js";
import type { ModelRef } from "../core/model/model.js";
import {
  runtimeFailure,
  type StepPipeline,
  type StepPipelineInput,
  type StepPipelineResult,
  type StepSnapshot,
} from "../core/runtime/runtime.js";
import type { ContextSessionId } from "../context/types.js";
import type {
  ContextOverflowCompactor,
  ContextOverflowCompactionResult,
} from "./types.js";

export interface CompactionRecoveryTarget {
  readonly sessionId: ContextSessionId;
  readonly model: ModelRef;
}

export interface CompactionRecoveryTargetResolver<
  Configuration = unknown,
  Payload = unknown,
  StepMemory = unknown,
> {
  resolve(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly snapshot: StepSnapshot<Payload>;
    readonly memory: StepMemory | undefined;
    readonly signal: AbortSignal;
  }): Promise<CompactionRecoveryTarget> | CompactionRecoveryTarget;
}

export interface ContextOverflowRecoveryPipelineOptions<
  Configuration = unknown,
  Payload = unknown,
  StepMemory = unknown,
  Result = unknown,
> {
  /** Must reserve context_over_budget for a pre-Model, pre-Tool rejection. */
  readonly delegate: StepPipeline<Configuration, Payload, StepMemory, Result>;
  readonly compactor: ContextOverflowCompactor;
  readonly target: CompactionRecoveryTargetResolver<
    Configuration,
    Payload,
    StepMemory
  >;
}

/**
 * Retries the same Step once after an append-only checkpoint. It deliberately
 * ignores Provider-side model_context_overflow and every other failure.
 */
export class ContextOverflowRecoveryPipeline<
  Configuration = unknown,
  Payload = unknown,
  StepMemory = unknown,
  Result = unknown,
> implements StepPipeline<Configuration, Payload, StepMemory, Result> {
  constructor(
    private readonly options: ContextOverflowRecoveryPipelineOptions<
      Configuration,
      Payload,
      StepMemory,
      Result
    >,
  ) {}

  async execute(
    input: StepPipelineInput<Configuration, Payload, StepMemory>,
  ): Promise<StepPipelineResult<StepMemory, Result>> {
    const initial = await this.options.delegate.execute(input);
    if (!isContextOverBudget(initial)) return initial;
    if (input.signal.aborted) return aborted(input.signal.reason);

    let recovery: ContextOverflowCompactionResult;
    try {
      const target = await this.options.target.resolve({
        definition: input.definition,
        snapshot: input.snapshot,
        memory: input.memory,
        signal: input.signal,
      });
      if (target === null || typeof target !== "object") {
        throw new Error("Compaction target resolver must return a target");
      }
      recovery = await this.options.compactor.compact({
        sessionId: target.sessionId,
        model: target.model,
        preserveUserTurnId: input.snapshot.userTurn.userTurnId,
        invocationScope: Object.freeze({
          sessionId: target.sessionId,
          runId: input.snapshot.run.runId,
          userTurnId: input.snapshot.userTurn.userTurnId,
          stepId: input.snapshot.step.stepId,
        }),
        signal: input.signal,
      });
    } catch (error: unknown) {
      if (input.signal.aborted) return aborted(input.signal.reason);
      return {
        status: "failed",
        error: runtimeFailure(
          "context_compaction_failed",
          error instanceof Error
            ? error.message
            : "Context compaction failed with an unknown error",
          false,
        ),
      };
    }
    if (input.signal.aborted) return aborted(input.signal.reason);
    if (recovery.status === "not_possible") {
      return {
        status: "failed",
        error: runtimeFailure(
          "context_compaction_not_possible",
          `Context compaction cannot reduce this request: ${recovery.reason}`,
          false,
          Object.freeze({ reason: recovery.reason }),
        ),
      };
    }

    const retried = await this.options.delegate.execute(input);
    if (!isContextOverBudget(retried)) return retried;
    return {
      status: "failed",
      error: runtimeFailure(
        "context_over_budget_after_compaction",
        "Projected request remains over budget after one compaction retry",
        false,
        Object.freeze({
          checkpointSequence: recovery.checkpoint.sequence,
          coveredThroughSequence:
            recovery.checkpoint.coveredThroughSequence,
          sourceRecordCount: recovery.sourceRecordCount,
          recentRecordCount: recovery.recentRecordCount,
          recentInputTokens: recovery.recentInputTokens,
          countMethod: recovery.countMethod,
          ...(retried.error.details === undefined
            ? {}
            : { projection: retried.error.details }),
        }),
      ),
    };
  }
}

function isContextOverBudget<StepMemory, Result>(
  result: StepPipelineResult<StepMemory, Result>,
): result is Extract<
  StepPipelineResult<StepMemory, Result>,
  { readonly status: "failed" }
> {
  return result.status === "failed" &&
    result.error.code === "context_over_budget";
}

function aborted<StepMemory, Result>(
  reason: unknown,
): StepPipelineResult<StepMemory, Result> {
  return {
    status: "aborted",
    ...(reason === undefined
      ? {}
      : {
          reason: reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : "context_compaction_aborted",
        }),
  };
}
