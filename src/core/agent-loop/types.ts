import type { AgentDefinition } from "../agent/types.js";
import type { ContextProvider } from "../context/context.js";
import type {
  ModelMessage,
  ModelMetadata,
  ModelOutput,
  ModelRef,
  ModelUsage,
} from "../model/types.js";
import type { RuntimeControlMessage } from "../runtime/control.js";
import type { StepSnapshot } from "../runtime/snapshot.js";
import type { ToolCall, ToolResult } from "../tools/tool.js";

/** Core-owned state carried only between Steps of one UserTurn. */
export interface AgentLoopMemory {
  readonly schemaVersion: 1;
  readonly model: ModelRef;
  readonly messages: readonly ModelMessage[];
  readonly currentUserMessageIndex: number;
  readonly usage?: ModelUsage;
}

/** Successful terminal value produced by the default Agent Step pipeline. */
export interface AgentLoopResult {
  readonly output: ModelOutput;
  readonly message: ModelMessage;
  readonly messages: readonly ModelMessage[];
  readonly usage?: ModelUsage;
}

export interface AgentLoopInputRenderer<Payload = unknown> {
  renderUserInput(input: {
    readonly payload: Payload;
    readonly snapshot: StepSnapshot<Payload>;
  }): Promise<ModelMessage> | ModelMessage;

  renderSteering(input: {
    readonly message: RuntimeControlMessage<"steer">;
    readonly snapshot: StepSnapshot<Payload>;
  }): Promise<ModelMessage> | ModelMessage;
}

export interface AgentLoopContextEnvironment<ContextInput = unknown> {
  readonly providers: readonly ContextProvider<ContextInput>[];
  readonly input: ContextInput;
}

export interface AgentLoopToolEnvironment<ToolContext = unknown> {
  readonly context: ToolContext;
  readonly authorityVersion: string;
  readonly availableTools?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentLoopRequestOptions {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly metadata?: ModelMetadata;
}

/** Typed view resolved from the immutable Runtime Step snapshot. */
export interface AgentLoopStepEnvironment<
  ContextInput = unknown,
  ToolContext = unknown,
> {
  readonly model: ModelRef;
  readonly context: AgentLoopContextEnvironment<ContextInput>;
  readonly tools: AgentLoopToolEnvironment<ToolContext>;
  readonly request?: AgentLoopRequestOptions;
}

export interface AgentLoopEnvironmentResolver<
  Configuration = unknown,
  Payload = unknown,
  ContextInput = unknown,
  ToolContext = unknown,
> {
  resolve(input: {
    readonly definition: AgentDefinition<Configuration>;
    readonly snapshot: StepSnapshot<Payload>;
    readonly memory: AgentLoopMemory | undefined;
    readonly signal: AbortSignal;
  }): Promise<AgentLoopStepEnvironment<ContextInput, ToolContext>> |
    AgentLoopStepEnvironment<ContextInput, ToolContext>;
}

export interface AgentLoopToolResultRenderer<Payload = unknown> {
  render(input: {
    readonly call: ToolCall;
    readonly result: ToolResult;
    readonly snapshot: StepSnapshot<Payload>;
  }): Promise<ModelMessage> | ModelMessage;
}
