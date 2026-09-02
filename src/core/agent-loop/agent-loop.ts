import { ContextProjector } from "../context/projector.js";
import type { Model } from "../model/model.js";
import type {
  ModelError,
  ModelMessage,
  ModelOutput,
  ModelRef,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
  ModelUsageSource,
} from "../model/types.js";
import {
  runtimeFailure,
  type StepPipeline,
  type StepPipelineInput,
  type StepPipelineResult,
} from "../runtime/runtime.js";
import type { ToolEventPublisher } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolScheduler } from "../tools/scheduler.js";
import type {
  ToolCall,
  ToolExecutionScope,
  ToolResult,
} from "../tools/tool.js";
import type {
  AgentLoopEnvironmentResolver,
  AgentLoopInputRenderer,
  AgentLoopMemory,
  AgentLoopResult,
  AgentLoopStepEnvironment,
  AgentLoopToolResultRenderer,
} from "./types.js";

export type {
  AgentLoopContextEnvironment,
  AgentLoopEnvironmentResolver,
  AgentLoopInputRenderer,
  AgentLoopMemory,
  AgentLoopRequestOptions,
  AgentLoopResult,
  AgentLoopStepEnvironment,
  AgentLoopToolEnvironment,
  AgentLoopToolResultRenderer,
} from "./types.js";

export interface AgentLoopOptions<
  Configuration = unknown,
  Payload = unknown,
  ContextInput = unknown,
  ToolContext = unknown,
> {
  readonly model: Model;
  readonly context: ContextProjector;
  readonly tools: ToolRegistry<ToolContext>;
  readonly toolScheduler: ToolScheduler<ToolContext>;
  readonly input: AgentLoopInputRenderer<Payload>;
  readonly environment: AgentLoopEnvironmentResolver<
    Configuration,
    Payload,
    ContextInput,
    ToolContext
  >;
  readonly toolResults?: AgentLoopToolResultRenderer<Payload>;
}

interface StreamCollection {
  readonly output?: ModelOutput;
  readonly error?: ModelError;
  readonly failure?: Error;
}

interface PreparedMemory {
  readonly prior?: AgentLoopMemory;
  readonly messages: readonly ModelMessage[];
  readonly currentUserMessageIndex: number;
  readonly usage?: ModelUsage;
}

/**
 * Default implementation of one Runtime Step.
 * Runtime retains the Run/UserTurn/Step loops; this class owns only the
 * Context -> Model -> Tools -> next-Step spine inside one Step.
 */
export class AgentLoop<
  Configuration = unknown,
  Payload = unknown,
  ContextInput = unknown,
  ToolContext = unknown,
> implements StepPipeline<Configuration, Payload, AgentLoopMemory, AgentLoopResult> {
  private readonly toolResults: AgentLoopToolResultRenderer<Payload>;

  constructor(
    private readonly options: AgentLoopOptions<
      Configuration,
      Payload,
      ContextInput,
      ToolContext
    >,
  ) {
    this.toolResults = options.toolResults ?? defaultToolResultRenderer();
  }

  async execute(
    input: StepPipelineInput<Configuration, Payload, AgentLoopMemory>,
  ): Promise<StepPipelineResult<AgentLoopMemory, AgentLoopResult>> {
    if (input.signal.aborted) return aborted(input.signal.reason);

    let prepared: PreparedMemory;
    let environment: AgentLoopStepEnvironment<ContextInput, ToolContext>;
    try {
      prepared = await this.prepareMemory(input);
      environment = validateEnvironment(await this.options.environment.resolve({
        definition: input.definition,
        snapshot: input.snapshot,
        memory: prepared.prior,
        signal: input.signal,
      }));
    } catch (error: unknown) {
      return input.signal.aborted
        ? aborted(input.signal.reason)
        : failed("agent_loop_setup_failed", error);
    }
    if (input.signal.aborted) return aborted(input.signal.reason);

    const model = prepared.prior === undefined
      ? freezeModelRef(environment.model)
      : prepared.prior.model;
    const memory = freezeMemory({
      schemaVersion: 1,
      model,
      messages: prepared.messages,
      currentUserMessageIndex: prepared.currentUserMessageIndex,
      ...(prepared.usage === undefined ? {} : { usage: prepared.usage }),
    });

    let toolSnapshot;
    let projection;
    try {
      toolSnapshot = this.options.tools.captureSnapshot({
        authorityVersion: environment.tools.authorityVersion,
        ...(environment.tools.availableTools === undefined
          ? {}
          : { availableTools: environment.tools.availableTools }),
        ...(environment.tools.metadata === undefined
          ? {}
          : { metadata: environment.tools.metadata }),
      });
      const request = {
        model,
        messages: memory.messages,
        tools: this.options.tools.listForSnapshot(toolSnapshot).map((tool) =>
          Object.freeze({
            name: tool.name,
            description: tool.description,
            inputSchemaJson: tool.inputSchemaJson,
          })
        ),
        ...(environment.request?.temperature === undefined
          ? {}
          : { temperature: environment.request.temperature }),
        ...(environment.request?.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: environment.request.maxOutputTokens }),
        ...(environment.request?.metadata === undefined
          ? {}
          : { metadata: environment.request.metadata }),
      };
      projection = await this.options.context.projectFromProviders({
        request,
        providers: environment.context.providers,
        providerInput: environment.context.input,
        currentUserMessageIndex: memory.currentUserMessageIndex,
        signal: input.signal,
      });
    } catch (error: unknown) {
      return input.signal.aborted
        ? aborted(input.signal.reason)
        : failed("agent_loop_projection_failed", error);
    }
    if (input.signal.aborted) return aborted(input.signal.reason);
    if (projection.status === "rejected") {
      return {
        status: "failed",
        error: runtimeFailure(
          "context_over_budget",
          "Projected model request exceeds the configured context budget",
          false,
          Object.freeze({
            ...(projection.budget.estimatedInputTokens === undefined
              ? {}
              : { estimatedInputTokens: projection.budget.estimatedInputTokens }),
            ...(projection.budget.inputLimitTokens === undefined
              ? {}
              : { inputLimitTokens: projection.budget.inputLimitTokens }),
          }),
        ),
      };
    }

    const scope: ToolExecutionScope = Object.freeze({
      runId: input.snapshot.run.runId,
      userTurnId: input.snapshot.userTurn.userTurnId,
      stepId: input.snapshot.step.stepId,
    });
    const toolEvents: ToolEventPublisher = {
      publish(event) {
        safePublish(() => input.output.publishTool(event));
      },
    };
    Object.freeze(toolEvents);
    const schedule = this.options.toolScheduler.begin({
      context: environment.tools.context,
      scope,
      snapshot: toolSnapshot,
      signal: input.signal,
      events: toolEvents,
    });
    const calls: ToolCall[] = [];
    const callIds = new Set<string>();
    const collection = await this.collectModelStream(
      projection.request,
      input,
      (toolCall) => {
        if (callIds.has(toolCall.id)) {
          throw new Error(`Model emitted duplicate Tool call id "${toolCall.id}"`);
        }
        callIds.add(toolCall.id);
        const parsed = this.options.tools.parseCall(toolCall).call;
        calls.push(parsed);
        void schedule.submit(parsed);
      },
    );

    let results: readonly ToolResult[];
    try {
      results = await schedule.close();
    } catch (error: unknown) {
      return input.signal.aborted
        ? aborted(input.signal.reason)
        : failed("tool_schedule_failed", error);
    }
    if (input.signal.aborted) return aborted(input.signal.reason);
    if (collection.failure !== undefined) {
      return failed("model_stream_protocol_error", collection.failure);
    }
    if (collection.error !== undefined) {
      return collection.error.code === "aborted"
        ? aborted(collection.error.message)
        : {
            status: "failed",
            error: runtimeFailure(
              `model_${collection.error.code}`,
              collection.error.message,
              collection.error.retryable,
              collection.error.status === undefined
                ? undefined
                : Object.freeze({ status: collection.error.status }),
            ),
          };
    }
    const output = collection.output;
    if (output === undefined) {
      return failed(
        "model_stream_protocol_error",
        new Error("Model stream ended without a done or error event"),
      );
    }
    if (results.length !== calls.length) {
      return failed(
        "tool_schedule_failed",
        new Error("Tool Scheduler returned a different number of results"),
      );
    }

    let nextMemory: AgentLoopMemory;
    let assistant: ModelMessage;
    try {
      assistant = assistantMessage(output);
      const messages = [...memory.messages, assistant];
      for (const [index, result] of results.entries()) {
        const call = calls[index];
        if (call === undefined) {
          throw new Error("Missing Tool call for scheduled result");
        }
        messages.push(validateToolResultMessage(
          await this.toolResults.render({ call, result, snapshot: input.snapshot }),
          result.callId,
        ));
      }
      nextMemory = freezeMemory({
        schemaVersion: 1,
        model,
        messages,
        currentUserMessageIndex: memory.currentUserMessageIndex,
        ...((memory.usage === undefined && output.usage === undefined)
          ? {}
          : { usage: addUsage(memory.usage, output.usage) }),
      });
    } catch (error: unknown) {
      return failed("agent_loop_transcript_failed", error);
    }

    if (calls.length > 0) {
      return {
        status: "continue",
        reason: "tool_calls",
        memory: nextMemory,
      };
    }
    return {
      status: "completed",
      result: Object.freeze({
        output,
        message: assistant,
        messages: nextMemory.messages,
        ...(nextMemory.usage === undefined ? {} : { usage: nextMemory.usage }),
      }),
      memory: nextMemory,
    };
  }

  private async prepareMemory(
    input: StepPipelineInput<Configuration, Payload, AgentLoopMemory>,
  ): Promise<PreparedMemory> {
    const existing = input.memory === undefined
      ? undefined
      : validateMemory(input.memory);
    const messages = existing === undefined
      ? [validateUserMessage(await this.options.input.renderUserInput({
          payload: input.snapshot.userTurn.input,
          snapshot: input.snapshot,
        }))]
      : [...existing.messages];
    let currentUserMessageIndex = existing?.currentUserMessageIndex ?? 0;
    for (const message of input.snapshot.steering) {
      messages.push(validateUserMessage(await this.options.input.renderSteering({
        message,
        snapshot: input.snapshot,
      })));
      currentUserMessageIndex = messages.length - 1;
    }
    return Object.freeze({
      ...(existing === undefined ? {} : { prior: existing }),
      messages: Object.freeze(messages),
      currentUserMessageIndex,
      ...(existing?.usage === undefined ? {} : { usage: existing.usage }),
    });
  }

  private async collectModelStream(
    request: Parameters<Model["stream"]>[0],
    input: StepPipelineInput<Configuration, Payload, AgentLoopMemory>,
    onToolCall: (call: ModelToolCall) => void,
  ): Promise<StreamCollection> {
    let start: Extract<ModelStreamEvent, { readonly type: "start" }> | undefined;
    let reasoning = "";
    let text = "";
    const toolCalls: ModelToolCall[] = [];
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    let terminal = false;
    try {
      for await (const event of this.options.model.stream(request, input.signal)) {
        safePublish(() => input.output.publishModel(event));
        if (terminal) {
          return { failure: new Error("Model emitted an event after a terminal event") };
        }
        switch (event.type) {
          case "start":
            if (start !== undefined) {
              return { failure: new Error("Model emitted start more than once per attempt") };
            }
            start = freezeStartEvent(event);
            break;
          case "retry":
            if (reasoning.length > 0 || text.length > 0 || toolCalls.length > 0) {
              return { failure: new Error("Model retried after emitting content") };
            }
            start = undefined;
            break;
          case "reasoning_delta":
            requireStarted(start, event.type);
            reasoning += event.text;
            break;
          case "text_delta":
            requireStarted(start, event.type);
            text += event.text;
            break;
          case "tool_call":
            requireStarted(start, event.type);
            onToolCall(event.call);
            toolCalls.push(freezeToolCall(event.call));
            break;
          case "done":
            requireStarted(start, event.type);
            terminal = true;
            finishReason = event.finishReason;
            usage = event.usage === undefined ? undefined : freezeUsage(event.usage);
            break;
          case "error":
            terminal = true;
            return { error: Object.freeze({ ...event.error }) };
        }
        if (terminal) break;
      }
    } catch (error: unknown) {
      return {
        failure: error instanceof Error ? error : new Error("Model stream failed"),
      };
    }
    if (!terminal || start === undefined) return {};
    return {
      output: Object.freeze({
        model: freezeModelRef(start.model),
        reasoning,
        text,
        toolCalls: Object.freeze(toolCalls),
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(usage === undefined ? {} : { usage: freezeUsage(usage) }),
        ...(start.developerRoleMode === undefined
          ? {}
          : { developerRoleMode: start.developerRoleMode }),
        ...(start.authorityDegraded === undefined
          ? {}
          : { authorityDegraded: start.authorityDegraded }),
      }),
    };
  }
}

function defaultToolResultRenderer<Payload>(): AgentLoopToolResultRenderer<Payload> {
  const renderer: AgentLoopToolResultRenderer<Payload> = {
    render(input) {
      const content = JSON.stringify(input.result);
      if (content === undefined) {
        throw new Error(`Tool result for call "${input.result.callId}" is not serializable`);
      }
      return Object.freeze({
        role: "tool" as const,
        content,
        toolCallId: input.result.callId,
      });
    },
  };
  return Object.freeze(renderer);
}

function assistantMessage(output: ModelOutput): ModelMessage {
  return Object.freeze({
    role: "assistant" as const,
    content: output.text,
    ...(output.reasoning.length === 0
      ? {}
      : { reasoningContent: output.reasoning }),
    ...(output.toolCalls.length === 0
      ? {}
      : {
          toolCalls: Object.freeze(output.toolCalls.map((call) => Object.freeze({
            id: call.id,
            name: call.name,
            argumentsJson: call.argumentsJson,
          }))),
        }),
  });
}

function validateUserMessage(message: ModelMessage): ModelMessage {
  if (message.role !== "user") {
    throw new Error("AgentLoop input renderer must return a user message");
  }
  return freezeMessage(message);
}

function validateToolResultMessage(
  message: ModelMessage,
  callId: string,
): ModelMessage {
  if (message.role !== "tool" || message.toolCallId !== callId) {
    throw new Error("Tool Result renderer must preserve role=tool and toolCallId");
  }
  return freezeMessage(message);
}

function freezeMessage(message: ModelMessage): ModelMessage {
  if (typeof message.content !== "string") {
    throw new Error("Model message content must be a string");
  }
  return Object.freeze({
    ...message,
    ...(message.contentParts === undefined
      ? {}
      : {
        contentParts: Object.freeze(message.contentParts.map((part) =>
          part.type === "text"
            ? Object.freeze({ type: "text" as const, text: part.text })
            : Object.freeze({
              type: "image_url" as const,
              imageUrl: Object.freeze({ ...part.imageUrl }),
            })
        )),
      }),
    ...(message.toolCalls === undefined
      ? {}
      : { toolCalls: Object.freeze(message.toolCalls.map((call) => Object.freeze({ ...call }))) }),
  });
}

function validateMemory(memory: AgentLoopMemory): AgentLoopMemory {
  if (memory.schemaVersion !== 1) throw new Error("Unknown AgentLoop memory schemaVersion");
  if (!Number.isSafeInteger(memory.currentUserMessageIndex)) {
    throw new Error("AgentLoop currentUserMessageIndex must be a safe integer");
  }
  if (
    memory.currentUserMessageIndex < 0 ||
    memory.currentUserMessageIndex >= memory.messages.length ||
    memory.messages[memory.currentUserMessageIndex]?.role !== "user"
  ) {
    throw new Error("AgentLoop currentUserMessageIndex must identify a user message");
  }
  return freezeMemory(memory);
}

function freezeMemory(memory: AgentLoopMemory): AgentLoopMemory {
  return Object.freeze({
    schemaVersion: 1 as const,
    model: freezeModelRef(memory.model),
    messages: Object.freeze(memory.messages.map(freezeMessage)),
    currentUserMessageIndex: memory.currentUserMessageIndex,
    ...(memory.usage === undefined ? {} : { usage: freezeUsage(memory.usage) }),
  });
}

function validateEnvironment<ContextInput, ToolContext>(
  environment: AgentLoopStepEnvironment<ContextInput, ToolContext>,
): AgentLoopStepEnvironment<ContextInput, ToolContext> {
  freezeModelRef(environment.model);
  if (!Array.isArray(environment.context.providers)) {
    throw new Error("AgentLoop Context providers must be an array");
  }
  requireIdentifier(environment.tools.authorityVersion, "Tool authority version");
  if (
    environment.request?.temperature !== undefined &&
    !Number.isFinite(environment.request.temperature)
  ) {
    throw new Error("Model temperature must be finite");
  }
  if (
    environment.request?.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(environment.request.maxOutputTokens) ||
      environment.request.maxOutputTokens < 1)
  ) {
    throw new Error("Model maxOutputTokens must be a positive safe integer");
  }
  return environment;
}

function freezeModelRef(model: ModelRef): ModelRef {
  return Object.freeze({
    provider: requireIdentifier(model.provider, "Model provider"),
    model: requireIdentifier(model.model, "Model name"),
  });
}

function freezeToolCall(call: ModelToolCall): ModelToolCall {
  return Object.freeze({
    id: requireIdentifier(call.id, "Model Tool call id"),
    name: requireIdentifier(call.name, "Model Tool name"),
    argumentsJson: typeof call.argumentsJson === "string"
      ? call.argumentsJson
      : (() => { throw new Error("Model Tool argumentsJson must be a string"); })(),
  });
}

function freezeStartEvent(
  event: Extract<ModelStreamEvent, { readonly type: "start" }>,
): Extract<ModelStreamEvent, { readonly type: "start" }> {
  return Object.freeze({
    type: "start" as const,
    model: freezeModelRef(event.model),
    ...(event.developerRoleMode === undefined
      ? {}
      : { developerRoleMode: event.developerRoleMode }),
    ...(event.authorityDegraded === undefined
      ? {}
      : { authorityDegraded: event.authorityDegraded }),
  });
}

function requireStarted(
  start: Extract<ModelStreamEvent, { readonly type: "start" }> | undefined,
  eventType: string,
): asserts start is Extract<ModelStreamEvent, { readonly type: "start" }> {
  if (start === undefined) {
    throw new Error(`Model emitted ${eventType} before start`);
  }
}

function addUsage(
  left: ModelUsage | undefined,
  right: ModelUsage | undefined,
): ModelUsage {
  if (left === undefined) {
    if (right === undefined) {
      throw new Error("Cannot aggregate absent Model usage");
    }
    return freezeUsage(right);
  }
  if (right === undefined) return freezeUsage(left);

  const cachedInputTokens = addKnownTokenCounts(
    left.cachedInputTokens,
    right.cachedInputTokens,
  );
  const cacheWriteInputTokens = addKnownTokenCounts(
    left.cacheWriteInputTokens,
    right.cacheWriteInputTokens,
  );
  const source = addUsageSources(left.source, right.source);
  const estimationMethod = addEstimationMethods(left, right, source);
  return freezeUsage({
    inputTokens: left.inputTokens + right.inputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens }),
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    source,
    ...(estimationMethod === undefined ? {} : { estimationMethod }),
  });
}

function freezeUsage(usage: ModelUsage): ModelUsage {
  requireTokenCount(usage.inputTokens, "inputTokens");
  if (usage.cachedInputTokens !== undefined) {
    requireTokenCount(usage.cachedInputTokens, "cachedInputTokens");
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    requireTokenCount(usage.cacheWriteInputTokens, "cacheWriteInputTokens");
  }
  requireTokenCount(usage.outputTokens, "outputTokens");
  requireTokenCount(usage.totalTokens, "totalTokens");
  if (
    usage.source !== "provider" &&
    usage.source !== "estimated" &&
    usage.source !== "mixed"
  ) {
    throw new Error("Model usage source must be provider, estimated, or mixed");
  }
  if (
    usage.estimationMethod !== undefined &&
    (usage.estimationMethod.length === 0 ||
      usage.estimationMethod !== usage.estimationMethod.trim())
  ) {
    throw new Error("Model usage estimationMethod must be a non-empty trimmed string");
  }
  return Object.freeze({ ...usage });
}

function addKnownTokenCounts(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  return left === undefined || right === undefined ? undefined : left + right;
}

function addUsageSources(
  left: ModelUsageSource,
  right: ModelUsageSource,
): ModelUsageSource {
  return left === right ? left : "mixed";
}

function addEstimationMethods(
  left: ModelUsage,
  right: ModelUsage,
  source: ModelUsageSource,
): string | undefined {
  if (source === "provider") return undefined;
  const estimated = [left, right].filter((usage) => usage.source !== "provider");
  const methods = estimated.map((usage) => usage.estimationMethod);
  if (methods.some((method) => method === undefined)) return undefined;
  const first = methods[0];
  return first !== undefined && methods.every((method) => method === first)
    ? first
    : undefined;
}

function requireTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Model usage ${name} must be a non-negative safe integer`);
  }
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function safePublish(publish: () => void): void {
  try {
    publish();
  } catch {
    // Output is diagnostic and cannot change execution decisions.
  }
}

function failed(
  code: string,
  error: unknown,
): StepPipelineResult<AgentLoopMemory, AgentLoopResult> {
  return {
    status: "failed",
    error: runtimeFailure(
      code,
      error instanceof Error ? error.message : "AgentLoop failed",
      false,
    ),
  };
}

function aborted(reason: unknown): StepPipelineResult<AgentLoopMemory, AgentLoopResult> {
  return {
    status: "aborted",
    ...(reason === undefined
      ? {}
      : {
          reason: reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : "agent_loop_aborted",
        }),
  };
}
