import { ToolRegistry } from "../src/core/tools/registry.js";
import {
  createAgentLoopPipeline as createInjectedPipeline,
  type CreateAgentLoopPipelineOptions,
} from "../src/composition/agent-loop-service.js";
import { createAgentLoopPipeline as createStandalonePipeline } from "../src/composition/agent-loop-standalone.js";
import type { WishToolExecutionContext } from "../src/composition/tool-context.js";

declare const input: Omit<CreateAgentLoopPipelineOptions, "tools">;
createStandalonePipeline(input);
createInjectedPipeline({ ...input, tools: { registry: new ToolRegistry<WishToolExecutionContext>() } });
// @ts-expect-error Product composition never silently installs concrete default Tools.
createInjectedPipeline(input);
