import { join, resolve } from "node:path";

import { Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { ModelDependencies } from "../models/runtime.js";
import type { SessionResources } from "../sessions/service.js";
import { FileToolResultArchive } from
  "../storage/tool-results/file-tool-result-archive.js";
import {
  createContextBundle,
  type ContextBundle,
  type ContextBundleConfigurationInput,
} from "./context.js";
import type { ContextInstruction } from "./types.js";

/** Loader-owned Context budget settings. */
export interface Config {
  readonly reservedOutputTokens?: number;
}

export const Config: s<Config> = s.object({
  reservedOutputTokens: s.number().step(1).min(0),
});

export interface OpenContextInput {
  readonly dataDirectory: string;
  readonly agentInstructions: readonly ContextInstruction[];
  readonly models: ModelDependencies;
  readonly configuration: ContextBundleConfigurationInput;
}

export interface ContextResourcesOptions extends OpenContextInput {
  readonly sessions: SessionResources;
}

/** Explicit standalone composition helper; product processes use the service. */
export function createContextResources(
  input: ContextResourcesOptions,
): ContextBundle {
  const dataDirectory = resolve(input.dataDirectory);
  return createContextBundle({
    history: input.sessions.history.context,
    agentInstructions: input.agentInstructions,
    archive: new FileToolResultArchive({
      directory: join(dataDirectory, "tool-results"),
      locatorRoot: dataDirectory,
    }),
    models: input.models.configuredModel,
    counter: input.models.requestCounter,
    configuration: input.configuration,
  });
}

/** Cordis owner of the Context projection and Tool Result admission graph. */
export class ContextEngine extends Service {
  static readonly inject = ["sessions", "models"];
  static readonly Config = Config;

  readonly reservedOutputTokens: number | undefined;

  constructor(ctx: CordisContext, config: Config = {}) {
    super(ctx, "contextEngine");
    this.reservedOutputTokens = config.reservedOutputTokens;
  }

  /** Build one Application-facing Context graph from injected capability views. */
  open(input: OpenContextInput): ContextBundle {
    return createContextResources({
      ...input,
      sessions: this.ctx.sessions.open(input.dataDirectory),
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    contextEngine: ContextEngine;
  }
}

export default ContextEngine;
