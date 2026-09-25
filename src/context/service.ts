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
import { ContextObservations, type ContextObservationListener } from "./observation.js";

/** Loader-owned Context budget settings. */
export interface Config {
  readonly reservedOutputTokens?: number;
}

export const Config: s<Config> = s.object({
  reservedOutputTokens: s.number().step(1).min(0),
});

export interface OpenContextInput {
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
  static readonly inject = ["sessions", "models", "toolResultArchive"];
  static readonly Config = Config;

  readonly reservedOutputTokens: number | undefined;
  readonly observations = new ContextObservations();
  private readonly work: PluginWorkOwner;
  private readonly additionalProviders = new Map<
    string,
    ContextProvider<ContextInput>
  >();

  constructor(ctx: CordisContext, config: Config = {}) {
    super(ctx, "contextEngine");
    this.work = new PluginWorkOwner(ctx, { code: "context_engine", codeReload: true });
    this.reservedOutputTokens = config.reservedOutputTokens;
  }

  /** Register a Context source for exactly the lifetime of the calling Fiber. */
  registerProvider(
    provider: ContextProvider<ContextInput>,
  ): ContextProviderRegistration {
    this.work.assertAttached();
    if (provider === null || typeof provider !== "object") {
      throw new TypeError("Context Provider must be an object");
    }
    const id = requireIdentifier(provider.id, "Context Provider id");
    if (typeof provider.provide !== "function") {
      throw new TypeError(`Context Provider ${JSON.stringify(id)} must implement provide()`);
    }
    if (this.additionalProviders.has(id)) {
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
    this.additionalProviders.set(id, tracked);
    const registration: ContextProviderRegistration = Object.freeze({
      id,
      unregister: (): boolean => {
        if (!active) return false;
        active = false;
        cancellation.abort(new Error(`Context Provider ${id} was unregistered`));
        if (this.additionalProviders.get(id) !== tracked) return false;
        this.additionalProviders.delete(id);
        return true;
      },
    });
    try {
      this.ctx.effect(
        () => async () => {
          registration.unregister();
          await Promise.allSettled([...reads]);
        },
        `contextEngine.registerProvider(${JSON.stringify(id)})`,
      );
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
        observe: (facts, projection) => { this.observations.record(facts, projection); input.observe?.(facts, projection); },
        additionalProviderSource: () => Object.freeze([
          ...this.additionalProviders.values(),
          ...(input.additionalProviderSource?.() ?? []),
        ]),
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
