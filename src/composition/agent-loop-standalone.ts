import { ToolRegistry } from "../core/tools/registry.js";
import { createUnavailableFilesystem } from "../filesystem/index.js";
import { LocalFilesystemSearchBackend } from "../filesystem/search/providers/local.js";
import type { FilesystemSearch } from "../filesystem/search/types.js";
import { createUnavailableShell } from "../shell/index.js";
import { registerBasicTools, type BasicToolsOptions } from "./coding-tools.js";
import {
  createAgentLoopPipeline as createInjectedAgentLoopPipeline,
  type AgentLoopToolsOptions,
  type CreateAgentLoopPipelineOptions as InjectedPipelineOptions,
  type WishStepPipeline,
} from "./agent-loop-service.js";
import type { WishToolExecutionContext } from "./tool-context.js";

export interface CreateAgentLoopPipelineOptions extends Omit<InjectedPipelineOptions, "tools"> {
  readonly filesystemSearch?: FilesystemSearch;
  readonly tools?: Omit<AgentLoopToolsOptions, "registry"> & {
    readonly registry?: ToolRegistry<WishToolExecutionContext>;
    readonly basic?: BasicToolsOptions;
  };
}

/** Standalone defaults are explicit here, never a dependency of the Cordis service. */
export function createAgentLoopPipeline(options: CreateAgentLoopPipelineOptions): WishStepPipeline {
  const filesystem = options.filesystem ?? createUnavailableFilesystem();
  const shell = options.shell ?? createUnavailableShell();
  const registry = options.tools?.registry ?? new ToolRegistry<WishToolExecutionContext>();
  if (options.tools?.registry === undefined) {
    const configured = options.tools?.basic;
    const filesystemSearch = options.filesystemSearch ?? new LocalFilesystemSearchBackend(filesystem);
    registerBasicTools(registry, {
      read: { ...configured?.read, filesystem: configured?.read?.filesystem ?? filesystem },
      write: { ...configured?.write, filesystem: configured?.write?.filesystem ?? filesystem },
      edit: { ...configured?.edit, filesystem: configured?.edit?.filesystem ?? filesystem },
      grep: { ...configured?.grep, search: configured?.grep?.search ?? filesystemSearch },
      bash: { ...configured?.bash, shell: configured?.bash?.shell ?? shell },
    });
  }
  return createInjectedAgentLoopPipeline({
    ...options, filesystem, shell, tools: { ...options.tools, registry },
  });
}
