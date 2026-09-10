import { Service, type Context } from "@deepseek-ai/cordis";

import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistration,
} from "../core/tools/scheduler.js";
import type { BasicToolContext } from "./support/context.js";

/** Cordis-owned registration surface around the pure Core ToolRegistry. */
export class Tools extends Service {
  readonly registry = new ToolRegistry<BasicToolContext>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /** Register a Tool for exactly the lifetime of the calling plugin fiber. */
  register<Name extends string, Input, Output>(
    definition: ToolDefinition<Name, Input, Output, BasicToolContext>,
  ): ToolRegistration {
    const registration = this.registry.register(definition);
    try {
      this.ctx.effect(() => () => {
        registration.unregister();
      }, `tools.register(${JSON.stringify(registration.descriptor.name)})`);
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: Tools;
  }
}

export default Tools;
