import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

import type { ModelRef } from "../core/model/model.js";
import type { ModelDependencies } from "../models/runtime.js";
import type { SessionResources } from "../sessions/service.js";
import { AgentScope, AgentScopeContributionWork } from "../composition/agent-scope.js";
import { DEFAULT_COMPACTION_STRATEGY_ID, type ContextOverflowCompactor } from "./types.js";
export { DEFAULT_COMPACTION_STRATEGY_ID } from "./types.js";
export { createCompactionResources } from "./providers/model-summary.js";

/** Loader-owned Compaction retention and summary settings. */
export interface Config {
  readonly keepRecentTokens?: number;
  readonly summaryMaxOutputTokens?: number;
  readonly strategyId?: string;
}

export const Config: s<Config> = s.object({
  keepRecentTokens: s.number().step(1).min(1),
  summaryMaxOutputTokens: s.number().step(1).min(1),
  strategyId: s.string(),
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

/** Selection is separate from a Provider registration and inherits by Agent Scope. */
export interface CompactionStrategySelection {
  readonly strategyId?: string;
  readonly keepRecentTokens?: number;
  readonly summaryMaxOutputTokens?: number;
}

/** A Step-local handle records the exact selection used for this invocation. */
export interface CompactionHandle extends ContextOverflowCompactor {
  readonly strategyId: string;
}

export interface CompactionResourcesOptions extends OpenCompactionInput {
  readonly sessions: SessionResources;
}

interface RegisteredCompactionStrategy {
  readonly strategy: CompactionStrategy;
  readonly work: AgentScopeContributionWork;
}

/** Cordis service for named strategy registration and per-Agent resolution. */
export class Compaction extends Service {
  static readonly inject = ["sessions", "models"];
  static readonly Config = Config;

  readonly keepRecentTokens: number | undefined;
  readonly summaryMaxOutputTokens: number | undefined;
  readonly strategyId: string;
  private readonly work: PluginWorkOwner;
  private readonly strategies = new Map<string, RegisteredCompactionStrategy>();
  private readonly scopedStrategies = new Map<AgentScope, Map<string, RegisteredCompactionStrategy>>();
  private readonly scopedSelections = new Map<AgentScope, CompactionStrategySelection>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "compaction");
    this.work = new PluginWorkOwner(ctx, { code: "compaction", codeReload: true });
    this.keepRecentTokens = config.keepRecentTokens;
    this.summaryMaxOutputTokens = config.summaryMaxOutputTokens;
    this.strategyId = strategyIdentifier(config.strategyId ?? DEFAULT_COMPACTION_STRATEGY_ID);
  }

  /** A Fiber may contribute several named strategies to the same Compaction module. */
  registerStrategy(owner: Context, strategy: CompactionStrategy, scope?: AgentScope): () => void {
    this.work.assertAttached();
    if (!strategy || typeof strategy.open !== "function") throw new TypeError("Invalid Compaction strategy");
    const id = strategyIdentifier(strategy.id);
    const open = strategy.open.bind(strategy);
    const entries = scope === undefined ? this.strategies : this.scopedStrategies.get(scope) ?? new Map<string, RegisteredCompactionStrategy>();
    if (entries.has(id)) throw new Error(`Compaction strategy ${JSON.stringify(id)} is already registered in this layer`);
    const entry: RegisteredCompactionStrategy = {
      strategy: Object.freeze({ id, open }),
      work: new AgentScopeContributionWork(`compaction:${id}`),
    };
    entries.set(id, entry);
    if (scope !== undefined) this.scopedStrategies.set(scope, entries);
    const unregister = () => {
      if (!entry.work.revoke()) return;
      if (entries.get(id) === entry) entries.delete(id);
      if (scope !== undefined && entries.size === 0 && this.scopedStrategies.get(scope) === entries) this.scopedStrategies.delete(scope);
    };
    let detach = () => {};
    try {
      if (scope !== undefined) detach = scope.own(async () => { unregister(); await entry.work.drain(); });
      owner.effect(() => async () => { unregister(); detach(); await entry.work.drain(); }, `compaction.strategy(${id})`);
    } catch (error) { unregister(); detach(); throw error; }
    return unregister;
  }

  /** Bind one Agent's choice and parameter overrides without modifying sibling Agents. */
  selectScoped(owner: Context, scope: AgentScope, selection: CompactionStrategySelection): () => void {
    this.work.assertAttached();
    if (this.scopedSelections.has(scope)) throw new Error("Compaction selection already registered in this Agent Scope");
    const snapshot = Object.freeze({
      ...(selection.strategyId === undefined ? {} : { strategyId: strategyIdentifier(selection.strategyId) }),
      ...(selection.keepRecentTokens === undefined ? {} : { keepRecentTokens: positive(selection.keepRecentTokens, "keepRecentTokens") }),
      ...(selection.summaryMaxOutputTokens === undefined ? {} : { summaryMaxOutputTokens: positive(selection.summaryMaxOutputTokens, "summaryMaxOutputTokens") }),
    });
    this.scopedSelections.set(scope, snapshot);
    const unregister = () => { if (this.scopedSelections.get(scope) === snapshot) this.scopedSelections.delete(scope); };
    let detach = () => {};
    try {
      detach = scope.own(unregister);
      owner.effect(() => () => { unregister(); detach(); }, `compaction.selection(${scope.agentId})`);
    } catch (error) { unregister(); detach(); throw error; }
    return unregister;
  }

  /** Compatibility shortcut: register one local Provider and select it for this Scope. */
  registerScoped(owner: Context, scope: AgentScope, strategy: CompactionStrategy): () => void {
    const unregisterStrategy = this.registerStrategy(owner, strategy, scope);
    try {
      const unselect = this.selectScoped(owner, scope, { strategyId: strategy.id });
      return () => { unselect(); unregisterStrategy(); };
    } catch (error) { unregisterStrategy(); throw error; }
  }

  /** Resolve once per AgentLoop Step; the returned handle pins this Provider generation. */
  open(input: OpenCompactionInput): CompactionHandle {
    this.work.assertAttached();
    const chain = input.agentScope?.chain() ?? [];
    let id = this.strategyId;
    let keepRecentTokens = input.keepRecentTokens;
    let summaryMaxOutputTokens = input.summaryMaxOutputTokens;
    for (const scope of chain) {
      const selection = this.scopedSelections.get(scope);
      if (selection?.strategyId !== undefined) id = selection.strategyId;
      if (selection?.keepRecentTokens !== undefined) keepRecentTokens = selection.keepRecentTokens;
      if (selection?.summaryMaxOutputTokens !== undefined) summaryMaxOutputTokens = selection.summaryMaxOutputTokens;
    }
    let entry = this.strategies.get(id);
    for (const scope of chain) entry = this.scopedStrategies.get(scope)?.get(id) ?? entry;
    if (entry === undefined) {
      throw new Error(`Compaction strategy ${JSON.stringify(id)} is unavailable`);
    }
    entry.work.assertOpen();
    const options: CompactionResourcesOptions = {
      ...input,
      keepRecentTokens,
      summaryMaxOutputTokens,
      sessions: this.ctx.sessions.open(input.dataDirectory),
    };
    const compactor = entry.strategy.open(options);
    if (!compactor || typeof compactor.compact !== "function") throw new TypeError("Invalid Compaction strategy result");
    const retainedTokens = (compactor as { readonly keepRecentTokens?: unknown }).keepRecentTokens;
    return Object.freeze({
      strategyId: id,
      ...(typeof retainedTokens === "number" ? { keepRecentTokens: retainedTokens } : {}),
      compact: (request: Parameters<ContextOverflowCompactor["compact"]>[0]) =>
        this.work.run(() => entry.work.run(() => compactor.compact(request))),
    });
  }
}

function strategyIdentifier(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(value)) throw new TypeError("Compaction strategy id must be a lowercase identifier");
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Compaction ${name} must be a positive integer`);
  return value;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    compaction: Compaction;
  }
}

export default Compaction;
