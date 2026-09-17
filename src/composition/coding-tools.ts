import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistration,
} from "../core/tools/scheduler.js";
import {
  createEditTool,
  type EditToolOptions,
  createReadTool,
  type ReadToolOptions,
  createWriteTool,
  type WriteToolOptions,
} from "../filesystem/consumers/model-tools/index.js";
import {
  createGrepTool,
  type GrepToolOptions,
} from "../filesystem/search/consumers/model-tool.js";
import {
  createBashTool,
  type BashToolOptions,
} from "../shell/consumers/model-tool.js";
import type { WishToolExecutionContext } from "./tool-context.js";

export * from "../tools/presentation/result-renderer.js";

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

/** Standalone composition helper; product graphs compose Consumers individually. */
export function registerBasicTools(
  registry: ToolRegistry<WishToolExecutionContext>,
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
    definition: ToolDefinition<Name, Input, Output, WishToolExecutionContext>,
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
