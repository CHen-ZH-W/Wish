import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { ModelRef } from "../core/model/model.js";
import type { ModelDependencies } from "../models/runtime.js";
import type { SessionResources } from "../sessions/service.js";
import { SessionCompactor } from "./compaction.js";
import { ModelCompactionSummarizer } from "./summarizer.js";

/** Loader-owned Compaction retention and summary settings. */
export interface Config {
  readonly keepRecentTokens?: number;
  readonly summaryMaxOutputTokens?: number;
}

export const Config: s<Config> = s.object({
  keepRecentTokens: s.number().step(1).min(1),
  summaryMaxOutputTokens: s.number().step(1).min(1),
});

export interface OpenCompactionInput {
  readonly dataDirectory: string;
  readonly models: ModelDependencies;
  readonly keepRecentTokens: number;
  readonly summaryMaxOutputTokens: number;
  readonly summaryModel?: ModelRef;
}

export interface CompactionResourcesOptions extends OpenCompactionInput {
  readonly sessions: SessionResources;
}

/** Explicit standalone composition helper; product processes use the service. */
export function createCompactionResources(
  input: CompactionResourcesOptions,
): SessionCompactor {
  const summaryModel = input.models.configuredModel.resolve(
    input.summaryModel ?? input.models.configuredModel.getDefaultModel(),
  ).ref;
  const summarizer = new ModelCompactionSummarizer({
    model: input.models.model,
    summaryModel,
    maxOutputTokens: input.summaryMaxOutputTokens,
  });
  return new SessionCompactor({
    session: input.sessions.history.compaction,
    summarizer,
    counter: input.models.requestCounter,
    configuration: {
      keepRecentTokens: input.keepRecentTokens,
    },
  });
}

/** Cordis owner of the model summarizer and Session compactor graph. */
export class Compaction extends Service {
  static readonly inject = ["sessions", "models"];
  static readonly Config = Config;

  readonly keepRecentTokens: number | undefined;
  readonly summaryMaxOutputTokens: number | undefined;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "compaction");
    this.keepRecentTokens = config.keepRecentTokens;
    this.summaryMaxOutputTokens = config.summaryMaxOutputTokens;
  }

  /** Build one Application-facing compactor from injected capability views. */
  open(input: OpenCompactionInput): SessionCompactor {
    return createCompactionResources({
      ...input,
      sessions: this.ctx.sessions.open(input.dataDirectory),
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    compaction: Compaction;
  }
}

export default Compaction;
