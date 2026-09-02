import {
  Agent,
  type AgentRuntimeService,
} from "../src/core/agent/agent.js";
import {
  Runtime,
  type RuntimeAgentProtocol,
} from "../src/core/runtime/runtime.js";

interface DefinitionConfiguration {
  readonly model: string;
}

interface Payload {
  readonly text: string;
}

interface StepMemory {
  readonly messages: readonly string[];
}

interface Result {
  readonly answer: string;
}

type Protocol = RuntimeAgentProtocol<
  DefinitionConfiguration,
  Payload,
  Result
>;

const runtime = new Runtime<
  DefinitionConfiguration,
  Payload,
  StepMemory,
  Result
>({
  stepPipeline: {
    async execute(input) {
      return {
        status: "completed",
        result: { answer: input.snapshot.userTurn.input.text },
      };
    },
  },
});

const service: AgentRuntimeService<Protocol> = runtime;
const agent = new Agent<Protocol>({
  id: "typed-agent",
  configuration: { model: "model-id" },
}, service);
const handle = agent.startRun({ scope: "typed", payload: { text: "hello" } });
const receipt = agent.control(handle.runId, {
  type: "steer",
  text: "constraint",
});
const output = agent.observe(handle.runId);

void receipt;
void output;
void handle.completion;

