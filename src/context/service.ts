import { resolve } from "node:path";

import { Service, type Context as CordisContext } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

import type { ModelDependencies } from "../models/runtime.js";
import type { ContextItem, ContextProvider } from "../core/context/projector.js";
import type { SessionResources } from "../sessions/service.js";
import type { ToolResultArchiveHandle } from "../tools/results/service.js";
import type { ToolResultArchivePort } from "../tools/results/types.js";
import {
  createContextBundle,
  type ContextBundle,
  type ContextBundleConfigurationInput,
} from "./context.js";
import type { ContextInput } from "./types.js";
import { AgentScope } from "../composition/agent-scope.js";
import type { RegisteredSystemPromptSection } from "../system-prompt/types.js";
import { ContextObservations, type ContextObservationListener } from "./observation.js";

/** Loader-owned Context budget settings. */
export interface Config {
  readonly reservedOutputTokens?: number;
}

export const Config: s<Config> = s.object({
  reservedOutputTokens: s.number().step(1).min(0),
});

export interface OpenContextInput {
  readonly excludedProviderIds?: readonly string[];
  readonly agentScope?: AgentScope;
  readonly systemPromptSections?: readonly RegisteredSystemPromptSection[];
  readonly observe?: ContextObservationListener;
  readonly dataDirectory: string;
  readonly models: ModelDependencies;
  readonly configuration: ContextBundleConfigurationInput;
  /** Explicit standalone additions; product modules use registerProvider(). */
  readonly additionalProviders?: readonly ContextProvider<ContextInput>[];
  /** Generic live sources; no concrete product capability dependency. */
  readonly additionalProviderSource?: () => readonly ContextProvider<ContextInput>[];
}

export interface ContextProviderRegistration {
  readonly id: string;
  unregister(): boolean;
}

export interface ContextObserverRegistration {
  readonly id: string;
  unregister(): boolean;
}

export interface ContextResourcesOptions extends OpenContextInput {
  readonly sessions: SessionResources;
  readonly archive: ToolResultArchivePort;
}

/** Application-generation ownership of Context and its Archive lease. */
export interface ContextBundleHandle extends ContextBundle {
  readonly released: boolean;
  release(): boolean;
}

/** Explicit standalone composition helper; product processes use the service. */
export function createContextResources(
  input: ContextResourcesOptions,
): ContextBundle {
  return createContextBundle({
    ...(input.agentScope === undefined ? {} : { agentScope: input.agentScope }),
    ...(input.systemPromptSections === undefined ? {} : {
      systemPromptSections: input.systemPromptSections,
    }),
    ...(input.observe ? { observe: input.observe } : {}),
    history: input.sessions.history.context,
    archive: input.archive,
    models: input.models.configuredModel,
    counter: input.models.requestCounter,
    configuration: input.configuration,
    ...(input.additionalProviders === undefined
      ? {}
      : { additionalProviders: input.additionalProviders }),
    ...(input.additionalProviderSource === undefined
      ? {}
      : { additionalProviderSource: input.additionalProviderSource }),
  });
}

/** Cordis owner of the Context projection and Tool Result admission graph. */
export class ContextEngine extends Service {
  private currentProviderVersion = 0;
  get providerVersion(): number { return this.currentProviderVersion; }
  static readonly inject = ["sessions", "models", "toolResultArchive"];
  static readonly Config = Config;

  readonly reservedOutputTokens: number | undefined;
  readonly observations = new ContextObservations();
  private readonly work: PluginWorkOwner;
  private readonly additionalProviders = new Map<
    string,
    ContextProvider<ContextInput>
  >();
  private readonly scopedProviders = new Map<
    AgentScope,
    Map<string, ContextProvider<ContextInput>>
  >();
  private readonly observers = new Map<string, ContextObservationListener>();

  constructor(ctx: CordisContext, config: Config = {}) {
    super(ctx, "contextEngine");
    this.work = new PluginWorkOwner(ctx, { code: "context_engine", codeReload: true });
    this.reservedOutputTokens = config.reservedOutputTokens;
  }

  /** Register a Context source for exactly the lifetime of the calling Fiber. */
  registerProvider(
    provider: ContextProvider<ContextInput>,
    scope?: AgentScope,
    owner: CordisContext = this.ctx,
  ): ContextProviderRegistration {
    this.work.assertAttached();
    if (provider === null || typeof provider !== "object") {
      throw new TypeError("Context Provider must be an object");
    }
    const id = requireIdentifier(provider.id, "Context Provider id");
    if (typeof provider.provide !== "function") {
      throw new TypeError(`Context Provider ${JSON.stringify(id)} must implement provide()`);
    }
    const entries = scope === undefined ? this.additionalProviders :
      this.scopedProviders.get(scope) ?? new Map<string, ContextProvider<ContextInput>>();
    if (entries.has(id)) {
      throw new Error(`Context Provider ${JSON.stringify(id)} is already registered`);
    }
    let active = true;
    const cancellation = new AbortController();
    const reads = new Set<Promise<readonly ContextItem[]>>();
    const tracked: ContextProvider<ContextInput> = {
      id,
      async provide(input, signal) {
        if (!active) throw cancellation.signal.reason;
        const combined = signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal]);
        combined.throwIfAborted();
        const pending = Promise.resolve().then(() => {
          combined.throwIfAborted();
          return provider.provide(input, combined);
        });
        reads.add(pending);
        try {
          const items = await pending;
          combined.throwIfAborted();
          return items;
        } finally { reads.delete(pending); }
      },
    };
    entries.set(id, tracked);
    this.currentProviderVersion++;
    if (scope !== undefined) this.scopedProviders.set(scope, entries);
    const registration: ContextProviderRegistration = Object.freeze({
      id,
      unregister: (): boolean => {
        if (!active) return false;
        active = false;
        cancellation.abort(new Error(`Context Provider ${id} was unregistered`));
        if (entries.get(id) !== tracked) return false;
        entries.delete(id);
        this.currentProviderVersion++;
        if (scope !== undefined && entries.size === 0 && this.scopedProviders.get(scope) === entries) {
          this.scopedProviders.delete(scope);
        }
        return true;
      },
    });
    let detach = () => {};
    try {
      if (scope !== undefined) detach = scope.own(async () => {
        registration.unregister();
        await Promise.allSettled([...reads]);
      });
      owner.effect(
        () => async () => {
          registration.unregister();
          detach();
          await Promise.allSettled([...reads]);
        },
        `contextEngine.registerProvider(${JSON.stringify(id)})`,
      );
    } catch (error: unknown) {
      registration.unregister();
      detach();
      throw error;
    }
    return registration;
  }

  registerProviderScoped(
    owner: CordisContext,
    scope: AgentScope,
    provider: ContextProvider<ContextInput>,
  ): ContextProviderRegistration {
    return this.registerProvider(provider, scope, owner);
  }

  /** Observe final projections without teaching Context about a consuming domain. */
  registerObserver(
    idValue: string,
    observer: ContextObservationListener,
  ): ContextObserverRegistration {
    this.work.assertAttached();
    const id = requireIdentifier(idValue, "Context observer id");
    if (typeof observer !== "function") throw new TypeError("Context observer must be a function");
    if (this.observers.has(id)) throw new Error(`Context observer ${JSON.stringify(id)} is already registered`);
    this.observers.set(id, observer);
    let active = true;
    const registration = Object.freeze({
      id,
      unregister: (): boolean => {
        if (!active) return false;
        active = false;
        if (this.observers.get(id) !== observer) return false;
        this.observers.delete(id);
        return true;
      },
    });
    try {
      this.ctx.effect(() => () => { registration.unregister(); }, `contextEngine.registerObserver(${JSON.stringify(id)})`);
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }

  /** Build one Application-facing Context graph from injected capability views. */
  open(input: OpenContextInput): ContextBundleHandle {
    this.work.assertAttached();
    const archive = this.ctx.toolResultArchive.open({
      legacyLocatorRoot: resolve(input.dataDirectory),
    });
    try {
      return createContextBundleHandle(createContextResources({
        ...input,
        observe: async (facts, projection) => {
          this.observations.record(facts, projection);
          await Promise.allSettled([
            ...[...this.observers.values()].map(observer => Promise.resolve(observer(facts, projection))),
            ...(input.observe === undefined ? [] : [Promise.resolve(input.observe(facts, projection))]),
          ]);
        },
        additionalProviderSource: () => {
          const visible = new Map(this.additionalProviders);
          for (const scope of input.agentScope?.chain() ?? []) {
            for (const provider of this.scopedProviders.get(scope)?.values() ?? []) {
              visible.set(provider.id, provider);
            }
          }
          for (const provider of input.additionalProviderSource?.() ?? []) visible.set(provider.id, provider);
          return Object.freeze([...visible.values()].filter(provider => !input.excludedProviderIds?.includes(provider.id)));
        },
        sessions: this.ctx.sessions.open(input.dataDirectory),
        archive,
      }), archive, this.work);
    } catch (error: unknown) {
      archive.release();
      throw error;
    }
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function createContextBundleHandle(
  bundle: ContextBundle,
  archive: ToolResultArchiveHandle,
  work: PluginWorkOwner,
): ContextBundleHandle {
  let released = false;
  const assertOpen = () => {
    work.assertOpen();
    if (released) throw new Error("context_bundle_released");
  };
  // Bind the underlying projector so projectFromProviders -> project remains
  // one admitted operation, even when a stop fence arrives between both calls.
  const projector = new Proxy(bundle.projector, {
    get(target, key) {
      if (key === "project") return (...args: Parameters<typeof target.project>) => {
        try { assertOpen(); } catch (error) { return Promise.reject(error); }
        return work.run(() => target.project(...args));
      };
      if (key === "projectFromProviders") return (...args: Parameters<typeof target.projectFromProviders>) => {
        try { assertOpen(); } catch (error) { return Promise.reject(error); }
        return work.run(() => target.projectFromProviders(...args));
      };
      return Reflect.get(target, key, target);
    },
  });
  return Object.freeze<ContextBundleHandle>({
    get configuration() { return bundle.configuration; },
    projector,
    get providers() { return bundle.providers; },
    historyPolicy: bundle.historyPolicy,
    toolResults: bundle.toolResults,
    budget: bundle.budget,
    forStep: input => { assertOpen(); return bundle.forStep(input); },
    createToolResultRenderer: options => {
      work.assertAttached();
      if (released) throw new Error("context_bundle_released");
      const renderer = bundle.createToolResultRenderer(options);
      return { render: input => {
        assertOpen();
        return work.run(() => renderer.render(input));
      } };
    },
    get released(): boolean {
      return released;
    },
    release(): boolean {
      if (released) return false;
      released = true;
      return archive.release();
    },
  });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    contextEngine: ContextEngine;
  }
}

export default ContextEngine;
