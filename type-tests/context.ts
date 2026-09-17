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
import type {
  AgentLoopToolResultRenderer,
} from "../src/core/agent-loop/agent-loop.js";
import type { StepSnapshot } from "../src/core/runtime/runtime.js";
import type {
  ContextConfiguration,
  ContextHistorySource,
  ContextInput,
  ContextRequestView,
  ContextToolResultArchiveReceipt,
  ModelContextWindowSource,
  ModelInputTokenCounter,
  ToolResultArchivePort,
} from "../src/context/types.js";
import {
  ContextToolResultAdmissionPipeline,
  ModelContextBudgetEvaluator,
  createContextBundle,
  createContextInput,
  createArchivingToolResultRenderer,
  readContextToolResultArchiveReceipt,
} from "../src/context/index.js";
import type { ContextBundle } from "../src/context/index.js";

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

const contextInput = {
  runId: "run-1",
  userTurnId: "turn-1",
  stepId: "step-1",
  sessionId: "session-1",
  model: { provider: "provider", model: "model" },
  workspace: {
    cwd: "/workspace",
    fingerprint: "workspace:fixture",
    revision: "workspace-revision:fixture",
    instructions: [
      { id: "workspace", authority: "developer", content: "instructions" },
    ],
  },
  runtime: {
    capturedAt: "2026-09-03T00:00:00.000Z",
    stateVersion: 1,
    userTurnOrdinal: 1,
    stepOrdinal: 1,
  },
} satisfies ContextInput;

const history: ContextHistorySource = {
  read({ sessionId }) {
    return [
      { kind: "message", sequence: 1, message: { role: "user", content: sessionId } },
      {
        kind: "summary",
        sequence: 3,
        coveredThroughSequence: 2,
        message: { role: "assistant", content: "summary" },
      },
    ];
  },
};

const archive: ToolResultArchivePort = {
  archive({ result }) {
    return { locator: `tool-results/${result.callId}`, hash: "sha256:result" };
  },
};

const receipt: ContextToolResultArchiveReceipt = {
  schemaVersion: 1,
  toolCallId: "call-1",
  locator: "tool-results/call-1.json",
  hash: "sha256:result",
};

const delegateRenderer: AgentLoopToolResultRenderer = {
  render({ result }) {
    return {
      role: "tool",
      content: JSON.stringify(result),
      toolCallId: result.callId,
    };
  },
};

const archivingRenderer: AgentLoopToolResultRenderer =
  createArchivingToolResultRenderer({
    archive,
    delegate: delegateRenderer,
    resolveSessionId() {
      return contextInput.sessionId;
    },
  });
const admission: ContextToolResultPipeline =
  new ContextToolResultAdmissionPipeline();

const counter: ModelInputTokenCounter = {
  count({ request }) {
    return request.model.provider === "provider"
      ? { inputTokens: 42, method: "fixture" }
      : undefined;
  },
};

const modelWindows: ModelContextWindowSource = {
  getContextWindowTokens(model) {
    return model.provider === "provider" ? 128_000 : undefined;
  },
};
const concreteBudget: ContextBudgetEvaluator = new ModelContextBudgetEvaluator({
  models: modelWindows,
  counter,
  reservedOutputTokens: 8_192,
});

declare const stepSnapshot: StepSnapshot<{ readonly text: string }>;
const bundle: ContextBundle = createContextBundle({
  history,
  agentInstructions: [
    { id: "agent", authority: "system", content: "Be exact" },
  ],
  archive,
  models: modelWindows,
  counter,
  configuration: { reservedOutputTokens: 8_192 },
});
const stepContext = bundle.forStep({
  snapshot: stepSnapshot,
  sessionId: "session-1",
  model: { provider: "provider", model: "model" },
  workspace: contextInput.workspace,
});
const directContextInput: ContextInput = createContextInput({
  snapshot: stepSnapshot,
  sessionId: "session-1",
  model: { provider: "provider", model: "model" },
  workspace: contextInput.workspace,
});
const bundleRenderer: AgentLoopToolResultRenderer<{ readonly text: string }> =
  bundle.createToolResultRenderer({
    delegate: delegateRenderer,
    resolveSessionId: () => "session-1",
  });

const requestView: ContextRequestView = {
  currentMessage: { role: "user", content: "rendered" },
  source: "follow_up", availableTools: ["read"],
};
const finalizedInput: ContextInput | undefined = stepContext.projectInput?.({
  input: stepContext.input, request: requestView,
});
// @ts-expect-error Request visibility is immutable, not a mutable registry.
requestView.availableTools.push("write");
// @ts-expect-error Message role is not valid provenance.
const invalidSource: ContextRequestView["source"] = "assistant";
void finalizedInput;
void invalidSource;

const configuration = {
  reservedOutputTokens: 8_192,
  toolResultAdmission: {
    thresholdChars: 8_192,
    headChars: 4_096,
    tailChars: 1_024,
  },
  providerOrder: ["instructions", "history", "state"],
} satisfies ContextConfiguration;

void projection;
void provided;
void consume(projection);
void receipt;
void archivingRenderer;
void admission;
void readContextToolResultArchiveReceipt;
void contextInput;
void history;
void archive;
void counter;
void modelWindows;
void concreteBudget;
void configuration;
void stepContext;
void directContextInput;
void bundleRenderer;
