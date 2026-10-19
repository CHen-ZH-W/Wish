import { Service, type Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

import {
  ToolRegistry,
  type ToolDefinition,
  type ToolRegistration,
} from "../core/tools/scheduler.js";
import type { AgentLoopToolResultRenderer } from
  "../core/agent-loop/agent-loop.js";
import type { ModelMessage } from "../core/model/model.js";
import type {
  ToolCall,
  ToolResult,
} from "../core/tools/scheduler.js";
import type { WishToolExecutionContext } from "../composition/tool-context.js";
import { AgentScope, AgentScopeContributionWork, type ToolCompositionContract } from "../composition/agent-scope.js";

type WishToolDefinition = ToolDefinition<string, any, any, WishToolExecutionContext>;
interface ScopedToolContribution {
  readonly definition: WishToolDefinition;
  readonly renderer?: ToolResultRendererContribution;
}
interface ScopedToolRegistry {
  readonly scope: AgentScope;
  readonly registry: ToolRegistry<WishToolExecutionContext>;
  readonly definitions: Map<string, WishToolDefinition>;
  readonly registrations: Map<string, ToolRegistration>;
}

export interface ToolResultRendererContribution {
  render(input: {
    readonly call: ToolCall;
    readonly result: ToolResult;
    readonly signal: AbortSignal;
  }): Promise<ModelMessage> | ModelMessage;
}

/** Cordis-owned registration surface around the pure Core ToolRegistry. */
export class Tools extends Service {
  readonly registry = new ToolRegistry<WishToolExecutionContext>();
  private readonly work: PluginWorkOwner;
  private readonly resultRenderers = new Map<
    string,
    ToolResultRendererContribution
  >();
  private readonly compositionContracts = new Map<string, ToolCompositionContract>();
  private readonly scoped = new Map<AgentScope, Map<string, ScopedToolContribution>>();
  private readonly scopedRegistries = new Map<AgentScope, ScopedToolRegistry>();

  constructor(ctx: Context) {
    super(ctx, "tools");
    this.work = new PluginWorkOwner(ctx, { code: "tools", codeReload: true });
    this.registry.subscribeChanges(() => this.refreshScopedRegistries());
  }

  /** Register a Tool for exactly the lifetime of the calling plugin fiber. */
  register<Name extends string, Input, Output>(
    definition: ToolDefinition<Name, Input, Output, WishToolExecutionContext>,
    resultRenderer?: ToolResultRendererContribution,
    compositionContract?: ToolCompositionContract,
  ): ToolRegistration {
    this.work.assertAttached();
    if (resultRenderer !== undefined && this.resultRenderers.has(definition.name)) {
      throw new Error(
        `Tool result renderer for ${JSON.stringify(definition.name)} is already registered`,
      );
    }
    const contract = compositionContract === undefined ? undefined : (() => {
      const requires = compositionContract.requires.map(feature => {
        if (typeof feature !== "string" || feature.length === 0 || feature !== feature.trim()) {
          throw new TypeError("Tool composition feature must be non-empty trimmed text");
        }
        return feature;
      });
      const requiredCapabilities = compositionContract.requiredCapabilities?.map(capability => {
        if (typeof capability !== "string" || capability.length === 0 || capability !== capability.trim()) {
          throw new TypeError("Tool composition capability must be non-empty trimmed text");
        }
        return capability;
      });
      return Object.freeze({
        requires: Object.freeze([...new Set(requires)]),
        ...(requiredCapabilities === undefined ? {} : {
          requiredCapabilities: Object.freeze([...new Set(requiredCapabilities)]),
        }),
      });
    })();
    const registration = this.registry.register(definition);
    if (contract !== undefined) this.compositionContracts.set(registration.descriptor.name, contract);
    if (resultRenderer !== undefined) {
      this.resultRenderers.set(registration.descriptor.name, resultRenderer);
    }
    const unregister = (): boolean => {
      if (contract !== undefined && this.compositionContracts.get(registration.descriptor.name) === contract) {
        this.compositionContracts.delete(registration.descriptor.name);
      }
      if (
          resultRenderer !== undefined &&
          this.resultRenderers.get(registration.descriptor.name) === resultRenderer
      ) this.resultRenderers.delete(registration.descriptor.name);
      return registration.unregister();
    };
    try {
      this.ctx.effect(() => () => { unregister(); }, `tools.register(${JSON.stringify(registration.descriptor.name)})`);
    } catch (error: unknown) {
      unregister();
      throw error;
    }
    return Object.freeze({ descriptor: registration.descriptor, unregister });
  }

  /** Register an Agent-local Tool; siblings may contribute the same name. */
  registerScoped<Name extends string, Input, Output>(
    owner: Context,
    scope: AgentScope,
    definition: ToolDefinition<Name, Input, Output, WishToolExecutionContext>,
    renderer?: ToolResultRendererContribution,
  ): ToolRegistration {
    this.work.assertAttached();
    if (this.scoped.get(scope)?.has(definition.name)) {
      throw new Error(`Tool ${JSON.stringify(definition.name)} is already registered in this Agent Scope`);
    }
    const validation = new ToolRegistry<WishToolExecutionContext>();
    const validated = validation.register(definition);
    const name = validated.descriptor.name;
    const work = new AgentScopeContributionWork(`tool:${name}`);
    const entries = this.scoped.get(scope) ?? new Map<string, ScopedToolContribution>();
    const contribution: ScopedToolContribution = {
      definition: {
        name: definition.name,
        description: definition.description,
        inputSchemaJson: definition.inputSchemaJson,
        executionMode: definition.executionMode,
        ...(definition.recoveryPolicy === undefined ? {} : { recoveryPolicy: definition.recoveryPolicy }),
        parse: input => { work.assertOpen(); return definition.parse(input); },
        resolveCapabilities: (...args) => work.run(() => definition.resolveCapabilities(...args)),
        execute: (...args) => work.run(() => definition.execute(...args)),
      },
      ...(renderer === undefined ? {} : {
        renderer: { render: input => work.run(() => renderer.render(input)) },
      }),
    };
    entries.set(name, contribution);
    this.scoped.set(scope, entries);
    this.refreshScopedRegistries();
    const unregister = (): boolean => {
      if (!work.revoke()) return false;
      if (entries.get(name) === contribution) entries.delete(name);
      if (entries.size === 0 && this.scoped.get(scope) === entries) this.scoped.delete(scope);
      this.refreshScopedRegistries();
      validated.unregister();
      return true;
    };
    let detach = () => {};
    try {
      detach = scope.own(async () => { unregister(); await work.drain(); });
      owner.effect(() => async () => { unregister(); detach(); await work.drain(); }, `tools.registerScoped(${JSON.stringify(name)})`);
    } catch (error: unknown) {
      unregister();
      detach();
      throw error;
    }
    return Object.freeze({ descriptor: validated.descriptor, unregister: () => {
      const removed = unregister();
      if (removed) void work.drain().then(detach);
      return removed;
    } });
  }

  /** Capture the inherited registry for one Agent Step, isolated from sibling changes. */
  registryFor(scope: AgentScope): ToolRegistry<WishToolExecutionContext> {
    this.work.assertOpen();
    const existing = this.scopedRegistries.get(scope);
    if (existing !== undefined) return existing.registry;
    const state: ScopedToolRegistry = {
      scope,
      registry: new ToolRegistry<WishToolExecutionContext>(),
      definitions: new Map(),
      registrations: new Map(),
    };
    if (scope.isClosing) {
      this.refreshScopedRegistry(state);
      return state.registry;
    }
    this.scopedRegistries.set(scope, state);
    try {
      scope.own(() => {
        for (const registration of state.registrations.values()) registration.unregister();
        state.registrations.clear();
        state.definitions.clear();
        this.scopedRegistries.delete(scope);
      });
      this.refreshScopedRegistry(state);
    } catch (error: unknown) {
      this.scopedRegistries.delete(scope);
      throw error;
    }
    return state.registry;
  }

  private refreshScopedRegistries(): void {
    for (const state of this.scopedRegistries.values()) this.refreshScopedRegistry(state);
  }

  private refreshScopedRegistry(state: ScopedToolRegistry): void {
    const visible = new Map<string, WishToolDefinition>();
    for (const definition of this.registry.listDefinitions()) visible.set(definition.name, definition);
    for (const ancestor of state.scope.chain()) {
      for (const contribution of this.scoped.get(ancestor)?.values() ?? []) {
        visible.set(contribution.definition.name, contribution.definition);
      }
    }
    for (const [name, definition] of state.definitions) {
      if (visible.get(name) === definition) continue;
      state.registrations.get(name)?.unregister();
      state.registrations.delete(name);
      state.definitions.delete(name);
    }
    for (const [name, definition] of visible) {
      if (state.definitions.get(name) === definition) continue;
      state.registrations.set(name, state.registry.register(definition));
      state.definitions.set(name, definition);
    }
  }

  /** Read-only composition facts for the current Application generation. */
  getCompositionContracts(): ReadonlyMap<string, ToolCompositionContract> {
    this.work.assertOpen();
    return new Map(this.compositionContracts);
  }

  /** Dynamic renderer view; a shadowed Tool without a renderer uses the fallback. */
  createResultRenderer<Payload>(
    fallback: AgentLoopToolResultRenderer<Payload>,
    scope?: AgentScope,
  ): AgentLoopToolResultRenderer<Payload> {
    this.work.assertAttached();
    return Object.freeze({
      render: (input: Parameters<
        AgentLoopToolResultRenderer<Payload>["render"]
      >[0]) => this.work.run(() => {
        const name = input.result.toolName;
        let renderer = this.resultRenderers.get(name);
        for (const ancestor of scope?.chain() ?? []) {
          const contribution = this.scoped.get(ancestor)?.get(name);
          if (contribution !== undefined) renderer = contribution.renderer;
        }
        if (renderer === undefined) return fallback.render(input);
        return renderer.render({
          call: input.call,
          result: input.result,
          signal: input.signal,
        });
      }),
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: Tools;
  }
}

export default Tools;
