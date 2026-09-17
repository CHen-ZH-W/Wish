import { Service, type Context } from "@deepseek-ai/cordis";

import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistration,
} from "../core/tools/scheduler.js";
import type { AgentLoopToolResultRenderer } from
  "../core/agent-loop/agent-loop.js";
import type { ModelMessage } from "../core/model/model.js";
import type {
  ToolCall,
  ToolResult,
} from "../core/tools/scheduler.js";
import type { WishToolExecutionContext } from "../composition/tool-context.js";

export interface ToolResultRendererContribution {
  render(input: {
    readonly call: ToolCall;
    readonly result: ToolResult;
    readonly signal: AbortSignal;
  }): Promise<ModelMessage> | ModelMessage;
}

/** Cordis-owned registration surface around the pure Core ToolRegistry. */
export class Tools extends Service {
  readonly registry = new ToolRegistry<WishToolExecutionContext>();
  private readonly resultRenderers = new Map<
    string,
    ToolResultRendererContribution
  >();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /** Register a Tool for exactly the lifetime of the calling plugin fiber. */
  register<Name extends string, Input, Output>(
    definition: ToolDefinition<Name, Input, Output, WishToolExecutionContext>,
    resultRenderer?: ToolResultRendererContribution,
  ): ToolRegistration {
    if (resultRenderer !== undefined && this.resultRenderers.has(definition.name)) {
      throw new Error(
        `Tool result renderer for ${JSON.stringify(definition.name)} is already registered`,
      );
    }
    const registration = this.registry.register(definition);
    if (resultRenderer !== undefined) {
      this.resultRenderers.set(registration.descriptor.name, resultRenderer);
    }
    try {
      this.ctx.effect(() => () => {
        if (
          resultRenderer !== undefined &&
          this.resultRenderers.get(registration.descriptor.name) === resultRenderer
        ) {
          this.resultRenderers.delete(registration.descriptor.name);
        }
        registration.unregister();
      }, `tools.register(${JSON.stringify(registration.descriptor.name)})`);
    } catch (error: unknown) {
      if (
        resultRenderer !== undefined &&
        this.resultRenderers.get(registration.descriptor.name) === resultRenderer
      ) {
        this.resultRenderers.delete(registration.descriptor.name);
      }
      registration.unregister();
      throw error;
    }
    return registration;
  }

  /** Dynamic renderer view; feature renderers follow the same Fiber as Tools. */
  createResultRenderer<Payload>(
    fallback: AgentLoopToolResultRenderer<Payload>,
  ): AgentLoopToolResultRenderer<Payload> {
    return Object.freeze({
      render: (input: Parameters<
        AgentLoopToolResultRenderer<Payload>["render"]
      >[0]) => {
        const renderer = this.resultRenderers.get(input.result.toolName);
        if (renderer === undefined) return fallback.render(input);
        return renderer.render({
          call: input.call,
          result: input.result,
          signal: input.signal,
        });
      },
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: Tools;
  }
}

export default Tools;
