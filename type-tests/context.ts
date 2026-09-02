import {
  ContextProjector,
  type ContextBudgetEvaluator,
  type ContextHistoryPolicy,
  type ContextItem,
  type ContextProjection,
  type ContextProvider,
  type ContextToolResultPipeline,
} from "../src/core/context/projector.js";
import type { ModelRequest } from "../src/core/model/model.js";

interface ProviderInput {
  readonly runId: string;
}

const provider: ContextProvider<ProviderInput> = {
  id: "instructions",
  provide(input): readonly ContextItem[] {
    return [{
      id: `run-${input.runId}`,
      kind: "instruction",
      placement: "stable_prefix",
      message: { role: "developer", content: "Follow the contract" },
    }];
  },
};

const historyPolicy: ContextHistoryPolicy = {
  select(input) {
    return { items: input.items };
  },
};

const toolResults: ContextToolResultPipeline = {
  archive(input) {
    return { id: input.message.toolCallId };
  },
  toModelMessage(input) {
    return input.message;
  },
};

const budget: ContextBudgetEvaluator = {
  assess() {
    return { status: "unknown" };
  },
};

const request: ModelRequest = {
  model: { provider: "provider", model: "model" },
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const projector = new ContextProjector({ historyPolicy, toolResults, budget });
const projection: Promise<ContextProjection> = projector.project({
  request,
  groups: [],
  currentUserMessageIndex: 0,
});
const provided: Promise<ContextProjection> = projector.projectFromProviders({
  request,
  providers: [provider],
  providerInput: { runId: "run-1" },
  currentUserMessageIndex: 0,
});

async function consume(result: Promise<ContextProjection>): Promise<ModelRequest> {
  const value = await result;
  return value.status === "ready" ? value.request : value.candidateRequest;
}

void projection;
void provided;
void consume(projection);
