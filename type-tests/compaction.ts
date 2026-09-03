import type { AgentLoopMemory, AgentLoopResult } from "../src/core/agent-loop/agent-loop.js";
import type { Model, ModelRequest } from "../src/core/model/model.js";
import type { StepPipeline } from "../src/core/runtime/runtime.js";
import {
  ContextOverflowRecoveryPipeline,
  ModelCompactionSummarizer,
  SessionCompactor,
  createCompactionPlan,
  renderCompactionTranscript,
  type CompactionSessionPort,
  type CompactionSummarizer,
  type ContextOverflowCompactor,
} from "../src/compaction/index.js";
import type {
  ContextHistoryRecord,
  ModelInputTokenCounter,
} from "../src/context/types.js";

declare const model: Model;
declare const delegate: StepPipeline<
  { readonly model: string },
  { readonly text: string },
  AgentLoopMemory,
  AgentLoopResult
>;

const records: readonly ContextHistoryRecord[] = [
  {
    kind: "message",
    sequence: 1,
    userTurnId: "turn-1",
    message: { role: "user", content: "request" },
  },
];
const counter: ModelInputTokenCounter = {
  count({ request }) {
    return request.messages.length > 0
      ? { inputTokens: 10, method: "fixture" }
      : undefined;
  },
};
const session: CompactionSessionPort = {
  read() {
    return { revision: "revision-1", records };
  },
  appendCheckpoint({ checkpoint }) {
    return {
      kind: "summary",
      sequence: 2,
      coveredThroughSequence: checkpoint.coveredThroughSequence,
      message: checkpoint.message,
    };
  },
};
const summarizer: CompactionSummarizer = new ModelCompactionSummarizer({
  model,
  summaryModel: { provider: "provider", model: "summary" },
  maxOutputTokens: 1_024,
});
const compactor: ContextOverflowCompactor = new SessionCompactor({
  session,
  summarizer,
  counter,
  configuration: { keepRecentTokens: 10 },
});
const recovery: StepPipeline<
  { readonly model: string },
  { readonly text: string },
  AgentLoopMemory,
  AgentLoopResult
> = new ContextOverflowRecoveryPipeline({
  delegate,
  compactor,
  target: {
    resolve() {
      return {
        sessionId: "session-1",
        model: { provider: "provider", model: "agent" },
      };
    },
  },
});
const plan = createCompactionPlan({
  records,
  model: { provider: "provider", model: "agent" },
  counter,
  keepRecentTokens: 10,
  preserveUserTurnId: "current-turn",
});
const transcript: string = renderCompactionTranscript(records);
declare const summaryRequest: ModelRequest;

void recovery;
void plan;
void transcript;
void summaryRequest;

