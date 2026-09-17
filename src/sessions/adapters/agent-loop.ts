import type {
  AgentLoopInputRenderer,
  AgentLoopMemory,
  AgentLoopResult,
} from "../../core/agent-loop/agent-loop.js";
import type { ModelMessage } from "../../core/model/model.js";
import {
  runtimeFailure,
  type StepPipeline,
  type StepPipelineInput,
  type StepPipelineResult,
  type StepSnapshot,
} from "../../core/runtime/runtime.js";
import { readContextToolResultArchiveReceipt } from "../../context/index.js";
import type {
  AppendSessionMessagesInput,
  AppendSessionMessagesResult,
  SessionId,
  SessionMessageDraft,
} from "../types.js";

export interface SessionTranscriptAccess {
  appendMessages(
    input: AppendSessionMessagesInput,
  ): Promise<AppendSessionMessagesResult>;
}

export interface SessionIdResolver<Payload = unknown> {
  resolve(input: {
    readonly snapshot: StepSnapshot<Payload>;
  }): Promise<SessionId> | SessionId;
}

export interface SessionInputRendererOptions<Payload = unknown> {
  readonly delegate: AgentLoopInputRenderer<Payload>;
  readonly sessions: SessionTranscriptAccess;
  /** Defaults to the Runtime scope -> Session identity convention. */
  readonly sessionId?: SessionIdResolver<Payload>;
}

/** Persists the exact rendered User/steering message before Context projection. */
export function createSessionInputRenderer<Payload = unknown>(
  options: SessionInputRendererOptions<Payload>,
): AgentLoopInputRenderer<Payload> {
  return Object.freeze({
    async renderUserInput(
      input: Parameters<AgentLoopInputRenderer<Payload>["renderUserInput"]>[0],
    ) {
      const message = await options.delegate.renderUserInput(input);
      const sessionId = await resolveSessionId(options.sessionId, input.snapshot);
      const result = await options.sessions.appendMessages({
        sessionId,
        messages: [{
          idempotencyKey: initialInputIdempotencyKey(input.snapshot),
          runId: input.snapshot.run.runId,
          userTurnId: input.snapshot.userTurn.userTurnId,
          stepId: input.snapshot.step.stepId,
          origin: "user_input",
          inputSource: input.snapshot.userTurn.inputSource ?? "unknown",
          message,
        }],
      });
      return requireSingleCommittedMessage(result, "user");
    },
    async renderSteering(
      input: Parameters<AgentLoopInputRenderer<Payload>["renderSteering"]>[0],
    ) {
      const message = await options.delegate.renderSteering(input);
      const sessionId = await resolveSessionId(options.sessionId, input.snapshot);
      const result = await options.sessions.appendMessages({
        sessionId,
        messages: [{
          idempotencyKey: input.message.id,
          runId: input.snapshot.run.runId,
          userTurnId: input.snapshot.userTurn.userTurnId,
          stepId: input.snapshot.step.stepId,
          origin: "steering",
          inputSource: "steering",
          message,
        }],
      });
      return requireSingleCommittedMessage(result, "user");
    },
  });
}

export interface SessionTranscriptPipelineOptions<
  Configuration = unknown,
  Payload = unknown,
> {
  /** Usually ContextOverflowRecoveryPipeline -> AgentLoop. */
  readonly delegate: StepPipeline<
    Configuration,
    Payload,
    AgentLoopMemory,
    AgentLoopResult
  >;
  readonly sessions: SessionTranscriptAccess;
  /** Defaults to the Runtime scope -> Session identity convention. */
  readonly sessionId?: SessionIdResolver<Payload>;
}

/** Commits each successful Step transcript before Runtime receives its result. */
export class SessionTranscriptPipeline<
  Configuration = unknown,
  Payload = unknown,
> implements StepPipeline<Configuration, Payload, AgentLoopMemory, AgentLoopResult> {
  constructor(
    private readonly options: SessionTranscriptPipelineOptions<
      Configuration,
      Payload
    >,
  ) {}

  async execute(
    input: StepPipelineInput<Configuration, Payload, AgentLoopMemory>,
  ): Promise<StepPipelineResult<AgentLoopMemory, AgentLoopResult>> {
    const result = await this.options.delegate.execute(input);
    if (result.status !== "continue" && result.status !== "completed") {
      return result;
    }
    if (input.signal.aborted) return aborted(input.signal.reason);

    try {
      const memory = result.memory;
      if (memory === undefined) {
        throw new Error("Successful Agent Loop Step did not return transcript memory");
      }
      const drafts = generatedDrafts(input, memory);
      if (drafts.length === 0) {
        throw new Error("Successful Agent Loop Step produced no Assistant transcript");
      }
      const sessionId = await resolveSessionId(
        this.options.sessionId,
        input.snapshot,
      );
      await this.options.sessions.appendMessages({
        sessionId,
        messages: drafts,
        signal: input.signal,
      });
      if (input.signal.aborted) return aborted(input.signal.reason);
      return result;
    } catch (error: unknown) {
      if (input.signal.aborted) return aborted(input.signal.reason);
      return {
        status: "failed",
        error: runtimeFailure(
          "session_commit_failed",
          error instanceof Error
            ? error.message
            : "Session transcript commit failed",
          false,
        ),
      };
    }
  }
}

export function sessionIdFromRunScope<Payload>(
  snapshot: StepSnapshot<Payload>,
): SessionId {
  return requireIdentifier(snapshot.run.scope, "Session id from Run scope");
}

function generatedDrafts<Configuration, Payload>(
  input: StepPipelineInput<Configuration, Payload, AgentLoopMemory>,
  memory: AgentLoopMemory,
): readonly SessionMessageDraft[] {
  const baseline = input.memory?.messages.length ?? 0;
  if (memory.messages.length < baseline) {
    throw new Error("Agent Loop transcript shrank within one Step");
  }
  const drafts: SessionMessageDraft[] = [];
  let generatedStarted = false;
  for (let index = baseline; index < memory.messages.length; index += 1) {
    const message = memory.messages[index];
    if (message === undefined) continue;
    if (message.role === "user") {
      if (generatedStarted) {
        throw new Error("Agent Loop inserted a User message after generated output");
      }
      continue;
    }
    if (message.role !== "assistant" && message.role !== "tool") {
      throw new Error("Agent Loop generated a non-transcript message");
    }
    generatedStarted = true;
    const receipt = message.role === "tool"
      ? readContextToolResultArchiveReceipt(message)
      : undefined;
    drafts.push(Object.freeze({
      idempotencyKey: generatedMessageIdempotencyKey(input.snapshot, index),
      runId: input.snapshot.run.runId,
      userTurnId: input.snapshot.userTurn.userTurnId,
      stepId: input.snapshot.step.stepId,
      origin: message.role,
      message,
      ...(receipt === undefined
        ? {}
        : {
            toolResultArchive: Object.freeze({
              schemaVersion: 1 as const,
              toolCallId: receipt.toolCallId,
              locator: receipt.locator,
              hash: receipt.hash,
            }),
          }),
    }));
  }
  return Object.freeze(drafts);
}

function initialInputIdempotencyKey<Payload>(
  snapshot: StepSnapshot<Payload>,
): string {
  return `${snapshot.run.runId}/${snapshot.userTurn.userTurnId}/input`;
}

function generatedMessageIdempotencyKey<Payload>(
  snapshot: StepSnapshot<Payload>,
  messageIndex: number,
): string {
  return `${snapshot.run.runId}/${snapshot.userTurn.userTurnId}/${messageIndex}`;
}

async function resolveSessionId<Payload>(
  resolver: SessionIdResolver<Payload> | undefined,
  snapshot: StepSnapshot<Payload>,
): Promise<SessionId> {
  const sessionId = resolver === undefined
    ? sessionIdFromRunScope(snapshot)
    : await resolver.resolve({ snapshot });
  return requireIdentifier(sessionId, "Session id");
}

function requireSingleCommittedMessage(
  result: AppendSessionMessagesResult,
  role: ModelMessage["role"],
): ModelMessage {
  const record = result.records[0];
  if (result.records.length !== 1 || record === undefined) {
    throw new Error("Session input append did not commit exactly one message");
  }
  if (record.message.role !== role) {
    throw new Error(`Session input append did not commit a ${role} message`);
  }
  return record.message;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function aborted<Memory, Result>(
  reason: unknown,
): StepPipelineResult<Memory, Result> {
  return {
    status: "aborted",
    ...(reason === undefined
      ? {}
      : {
          reason: reason instanceof Error
            ? reason.message
            : typeof reason === "string"
              ? reason
              : "session_commit_aborted",
        }),
  };
}
