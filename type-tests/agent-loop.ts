import { AgentLoop } from "../src/core/agent-loop/agent-loop.js";
import { ContextProjector } from "../src/core/context/projector.js";
import type { Model } from "../src/core/model/model.js";
import { Runtime } from "../src/core/runtime/runtime.js";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
  type ToolAuthorizationService,
} from "../src/core/tools/scheduler.js";

interface Configuration {
  readonly model: string;
}

interface Payload {
  readonly text: string;
}

interface ContextInput {
  readonly conversationId: string;
}

interface ToolContext {
  readonly workspaceId: string;
}

declare const model: Model;

const registry = new ToolRegistry<ToolContext>();
const authorization: ToolAuthorizationService<ToolContext> = {
  authorize() {
    return { status: "allowed", policyVersion: "policy-1" };
  },
  revalidate() {
    return { status: "valid", policyVersion: "policy-1" };
  },
};
const executor = new ToolExecutor({ registry, authorization });
const scheduler = new BoundedToolScheduler({ executor });

const loop = new AgentLoop<Configuration, Payload, ContextInput, ToolContext>({
  model,
  context: new ContextProjector(),
  tools: registry,
  toolScheduler: scheduler,
  input: {
    renderUserInput(input) {
      return { role: "user", content: input.payload.text };
    },
    renderSteering(input) {
      return { role: "user", content: input.message.text };
    },
  },
  environment: {
    resolve(input) {
      return {
        model: { provider: "provider", model: input.definition.configuration?.model ?? "default" },
        context: {
          providers: [],
          input: { conversationId: input.snapshot.run.scope },
        },
        tools: {
          context: { workspaceId: input.snapshot.run.scope },
          authorityVersion: "authority-1",
        },
      };
    },
  },
});

const runtime = new Runtime({ stepPipeline: loop });
void runtime.startRun(
  { id: "agent", configuration: { model: "model" } },
  { scope: "conversation", payload: { text: "hello" } },
);
