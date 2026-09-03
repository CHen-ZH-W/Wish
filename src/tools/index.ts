import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistration,
} from "../core/tools/scheduler.js";

import { createBashTool, type BashToolOptions } from "./basic/bash.js";
import { createEditTool, type EditToolOptions } from "./basic/edit.js";
import { createGrepTool, type GrepToolOptions } from "./basic/grep.js";
import { createReadTool, type ReadToolOptions } from "./basic/read.js";
import { createWriteTool, type WriteToolOptions } from "./basic/write.js";
import type { BasicToolContext } from "./support/context.js";

export {
  createBasicToolResultRenderer,
  renderBasicToolResult,
} from "./support/result-renderer.js";
export type { BasicToolContext } from "./support/context.js";

export const BASIC_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "grep",
  "bash",
] as const);

export type BasicToolName = typeof BASIC_TOOL_NAMES[number];

export interface BasicToolsOptions {
  readonly read?: ReadToolOptions;
  readonly write?: WriteToolOptions;
  readonly edit?: EditToolOptions;
  readonly grep?: GrepToolOptions;
  readonly bash?: BashToolOptions;
}

/** Register the complete Basic Tool set into one externally owned Registry. */
export function registerBasicTools(
  registry: ToolRegistry<BasicToolContext>,
  options: BasicToolsOptions = {},
): readonly ToolRegistration[] {
  const conflict = BASIC_TOOL_NAMES.find((name) => registry.has(name));
  if (conflict !== undefined) {
    throw new Error(
      `Cannot register Basic Tools because Tool "${conflict}" is already registered`,
    );
  }

  const registrations: ToolRegistration[] = [];
  const register = <Name extends string, Input, Output>(
    definition: ToolDefinition<Name, Input, Output, BasicToolContext>,
  ): void => {
    registrations.push(registry.register(definition));
  };

  try {
    register(createReadTool(options.read));
    register(createWriteTool(options.write));
    register(createEditTool(options.edit));
    register(createGrepTool(options.grep));
    register(createBashTool(options.bash));
  } catch (error: unknown) {
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      registrations[index]?.unregister();
    }
    throw error;
  }

  return Object.freeze([...registrations]);
}
