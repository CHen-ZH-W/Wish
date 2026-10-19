import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

import type { ModelRef } from "../core/model/model.js";
import type { ModelDependencies } from "../models/runtime.js";
import type { SessionResources } from "../sessions/service.js";
import { SessionCompactor } from "./compaction.js";
import { ModelCompactionSummarizer } from "./summarizer.js";
import { AgentScope, AgentScopeContributionWork } from "../composition/agent-scope.js";
import type { ContextOverflowCompactor } from "./types.js";

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
  readonly agentScope?: AgentScope;
  readonly dataDirectory: string;
  readonly models: ModelDependencies;
  readonly keepRecentTokens: number;
  readonly summaryMaxOutputTokens: number;
  readonly summaryModel?: ModelRef;
}

/** A per-Agent strategy receives the same Session and Model ports as the default. */
export interface CompactionStrategy {
  readonly id: string;
  open(input: CompactionResourcesOptions): ContextOverflowCompactor;
}

export interface CompactionResourcesOptions extends OpenCompactionInput {
  readonly sessions: SessionResources;
}

interface ScopedCompactionStrategy {
  readonly strategy: CompactionStrategy;
  readonly work: AgentScopeContributionWork;
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
  private readonly work: PluginWorkOwner;
  private readonly scopedStrategies = new Map<AgentScope, ScopedCompactionStrategy>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "compaction");
    this.work = new PluginWorkOwner(ctx, { code: "compaction", codeReload: true });
    this.keepRecentTokens = config.keepRecentTokens;
    this.summaryMaxOutputTokens = config.summaryMaxOutputTokens;
  }

  registerScoped(owner: Context, scope: AgentScope, strategy: CompactionStrategy): () => void {
    this.work.assertAttached();
    if (!strategy || typeof strategy.id !== "string" || !strategy.id.trim() || typeof strategy.open !== "function") {
      throw new TypeError("Invalid Compaction strategy");
    }
    if (this.scopedStrategies.has(scope)) throw new Error("Compaction strategy already registered in this Agent Scope");
    const entry: ScopedCompactionStrategy = {
      strategy,
      work: new AgentScopeContributionWork(`compaction:${strategy.id}`),
    };
    this.scopedStrategies.set(scope, entry);
    const unregister = () => {
      if (!entry.work.revoke()) return;
      if (this.scopedStrategies.get(scope) === entry) this.scopedStrategies.delete(scope);
    };
    let detach = () => {};
    try {
      detach = scope.own(async () => { unregister(); await entry.work.drain(); });
      owner.effect(() => async () => { unregister(); detach(); await entry.work.drain(); }, `compaction.strategy(${strategy.id})`);
    } catch (error) { unregister(); detach(); throw error; }
    return () => { unregister(); void entry.work.drain().then(detach); };
  }

  /** Build one Application-facing compactor from the nearest Agent strategy. */
  open(input: OpenCompactionInput): ContextOverflowCompactor {
    this.work.assertAttached();
    const options = {
      ...input,
      sessions: this.ctx.sessions.open(input.dataDirectory),
    };
    let entry: ScopedCompactionStrategy | undefined;
    for (const scope of input.agentScope?.chain() ?? []) {
      entry = this.scopedStrategies.get(scope) ?? entry;
    }
    entry?.work.assertOpen();
    const compactor = entry === undefined
      ? createCompactionResources(options)
      : entry.strategy.open(options);
    if (!compactor || typeof compactor.compact !== "function") throw new TypeError("Invalid Compaction strategy result");
    if (entry === undefined) {
      const defaultCompactor = compactor as SessionCompactor;
      const compact = defaultCompactor.compact.bind(defaultCompactor);
      defaultCompactor.compact = request => this.work.run(() => compact(request));
      return defaultCompactor;
    }
    const keepRecentTokens = (compactor as { readonly keepRecentTokens?: unknown }).keepRecentTokens;
    return Object.freeze({
      ...(typeof keepRecentTokens === "number" ? { keepRecentTokens } : {}),
      compact: (request: Parameters<ContextOverflowCompactor["compact"]>[0]) =>
        this.work.run(() => entry.work.run(() => compactor.compact(request))),
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    compaction: Compaction;
  }
}

export default Compaction;
