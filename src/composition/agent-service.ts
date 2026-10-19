import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { AgentScope } from "./agent-scope.js";
import { parseAgentScopePresets, snapshotAgentScopePreset, type AgentScopePreset } from "./agent-preset.js";
import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  WishAgentConfiguration,
  WishAgentProtocol,
} from "../apps/types.js";
import type { ContextInstruction } from "../context/types.js";
import {
  PERMISSION_PROFILES,
  TOOL_CAPABILITY_KINDS,
  type AgentPermissionConfiguration,
  type PermissionProfile,
} from "../permissions/index.js";
import type { CapabilityKind } from "../permissions/authorization.js";
import {
  Agent as CoreAgent,
  type AgentDefinition,
} from "../core/agent/agent.js";
import type {
  OpenRuntimeInput,
  RuntimeDependencies,
  RuntimeResources,
  WishRunGeneration,
} from "./runtime-service.js";

const DEFAULT_AGENT_ID = "wish";
/** Loader-owned definition of the default Wish Agent. */
export interface Config {
  readonly agentId?: string;
  /** Deployment or Agent-specific addition appended after Wish base instructions. */
  readonly agentInstructions?: string;
  readonly permissionProfile?: PermissionProfile;
  readonly availableTools?: string[] | undefined;
  readonly allowedCapabilities?: CapabilityKind[] | undefined;
  /** Host-owned role presets, serialized for the CLI child boundary. */
  readonly childPresetsJson?: string;
  /** Resolved preset supplied only to a launched child process. */
  readonly scopePresetJson?: string;
}

export const Config: s<Config> = s.object({
  agentId: s.string(),
  agentInstructions: s.string(),
  permissionProfile: s.union(
    PERMISSION_PROFILES.map((profile) => s.const(profile)),
  ),
  availableTools: s.union([
    s.array(s.string()),
    s.const(undefined),
  ]),
  allowedCapabilities: s.union([
    s.array(s.union(
      TOOL_CAPABILITY_KINDS.map((capability) => s.const(capability)),
    )),
    s.const(undefined),
  ]),
  childPresetsJson: s.string(),
  scopePresetJson: s.string(),
});

export type WishAgent = CoreAgent<WishAgentProtocol>;

/** Narrow Agent capability consumed by explicit standalone composition. */
export interface AgentDependencies {
  readonly agent: WishAgent;
  /** Present for Loader-managed graphs; standalone composition may omit it. */
  readonly generation?: WishRunGeneration;
}

/** Inputs supplied by the Application service when opening one generation. */
export type OpenAgentInput = Omit<
  OpenRuntimeInput,
  "agentId" | "agentInstructions" | "agentScope"
> & { readonly composition?: { readonly scope: AgentScope; readonly instructions: readonly ContextInstruction[]; readonly permissions: AgentPermissionConfiguration } };

export interface AgentResources extends RuntimeResources {
  readonly agent: WishAgent;
}

/** Explicit standalone constructor; product processes use the service. */
export function createWishAgent(
  definition: AgentDefinition<WishAgentConfiguration>,
  runtime: RuntimeDependencies,
): WishAgent {
  return new CoreAgent<WishAgentProtocol>(definition, runtime.runtime);
}

/** Cordis owner of the default Agent definition and facade. */
export class Agents extends Service {
  static readonly inject = ["runEngine"];
  static readonly Config = Config;

  readonly definition: AgentDefinition<WishAgentConfiguration>;
  readonly agentId: string;
  readonly agentInstructions: readonly ContextInstruction[];
  readonly permissions: AgentPermissionConfiguration;
  readonly scope: AgentScope;
  readonly childPresets: readonly AgentScopePreset[];
  readonly scopePreset: AgentScopePreset | undefined;
  private readonly work: PluginWorkOwner;
  private readonly generations = new Set<WishRunGeneration>();
  private readonly installedPrompts = new WeakSet<object>();
  private readonly installedCompactions = new WeakSet<object>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "agents");
    this.work = new PluginWorkOwner(ctx, {
      code: "agents",
      codeReload: true,
      replacement: "generation",
    });
    this.agentId = requireIdentifier(
      config.agentId ?? DEFAULT_AGENT_ID,
      "Wish Agent id",
    );
    this.childPresets = parseAgentScopePresets(config.childPresetsJson);
    this.scopePreset = config.scopePresetJson === undefined || config.scopePresetJson === ""
      ? undefined
      : snapshotAgentScopePreset(JSON.parse(config.scopePresetJson));
    this.scope = new AgentScope(this.scopePreset === undefined ? this.agentId : `${this.agentId}:${this.scopePreset.role}`);
    ctx.effect(() => async () => {
      const retirements = Promise.allSettled([...this.generations].map(generation =>
        generation.retire({ reason: `Agent Scope ${this.scope.generation} closed` })
      ));
      // Closing the Scope signals Agent-local work that an aborting Run may be
      // awaiting. Start both drains before waiting for either to finish.
      const [scopeResult] = await Promise.allSettled([this.scope.dispose(), retirements]);
      if (scopeResult.status === "rejected") throw scopeResult.reason;
    }, `agents.scope(${JSON.stringify(this.agentId)})`);
    this.agentInstructions = config.agentInstructions === undefined
      ? Object.freeze([])
      : createInstructions(config.agentInstructions);
    this.installPresetContributions(false);
    this.permissions = snapshotPermissions(config);
    this.definition = Object.freeze({
      id: this.agentId,
      name: "Wish",
      configuration: Object.freeze({
        agentInstructions: this.agentInstructions,
        permissions: this.permissions,
      }),
    });
  }

  presetForRole(role: string | undefined): AgentScopePreset | undefined {
    return this.childPresets.find(preset => preset.role === (role ?? "worker"));
  }

  /** Build one Agent/Application generation from the current Runtime owner. */
  open(input: OpenAgentInput): AgentResources {
    this.work.assertAttached();
    this.installPresetContributions(true);
    for (const tool of this.scopePreset?.localTools ?? []) {
      if (!this.ctx.get("tools")?.registryFor(this.scope).has(tool.name)) {
        throw new Error(`Agent Scope role ${this.scopePreset!.role} did not register local Tool ${tool.name}`);
      }
    }
    const { composition, ...runtimeInput } = input;
    const resources = this.ctx.runEngine.open({
      ...runtimeInput,
      agentId: this.agentId,
      agentInstructions: composition?.instructions ?? this.agentInstructions,
      agentScope: composition?.scope ?? this.scope,
    });
    this.generations.add(resources.generation);
    return Object.freeze({
      ...resources,
      agent: createWishAgent(composition === undefined ? this.definition : Object.freeze({ ...this.definition,
        configuration: Object.freeze({ agentInstructions: composition.instructions, permissions: composition.permissions }),
      }), resources),
    });
  }

  private installPresetContributions(required: boolean): void {
    const prompt = this.scopePreset?.prompt === undefined ? undefined : this.ctx.get("systemPrompt");
    const compaction = this.scopePreset?.compaction === undefined ? undefined : this.ctx.get("compaction");
    if (required && this.scopePreset?.prompt !== undefined && prompt === undefined) throw new Error("Agent Scope Prompt service is unavailable");
    if (required && this.scopePreset?.compaction !== undefined && compaction === undefined) throw new Error("Agent Scope Compaction service is unavailable");
    if (prompt !== undefined && !this.installedPrompts.has(prompt)) {
      prompt.registerScoped(this.ctx, this.scope, {
        id: "agent-scope-preset", content: this.scopePreset!.prompt!, authority: "developer", order: 100,
      });
      this.installedPrompts.add(prompt);
    }
    if (compaction !== undefined && !this.installedCompactions.has(compaction)) {
      compaction.selectScoped(this.ctx, this.scope, this.scopePreset!.compaction!);
      this.installedCompactions.add(compaction);
    }
  }
}

function snapshotPermissions(config: Config): AgentPermissionConfiguration {
  return Object.freeze({
    ...(config.permissionProfile === undefined
      ? {}
      : { profile: config.permissionProfile }),
    ...(config.availableTools === undefined
      ? {}
      : {
          availableTools: Object.freeze(uniqueIdentifiers(
            config.availableTools,
            "Wish Agent available Tool",
          )),
        }),
    ...(config.allowedCapabilities === undefined
      ? {}
      : {
          allowedCapabilities: Object.freeze(uniqueCapabilities(
            config.allowedCapabilities,
          )),
        }),
  });
}

function uniqueIdentifiers(values: readonly string[], label: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = requireIdentifier(value, label);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueCapabilities(
  values: readonly CapabilityKind[],
): CapabilityKind[] {
  const supported = new Set<CapabilityKind>(TOOL_CAPABILITY_KINDS);
  const result: CapabilityKind[] = [];
  const seen = new Set<CapabilityKind>();
  for (const value of values) {
    if (!supported.has(value)) {
      throw new TypeError(`Unknown Tool capability ${JSON.stringify(value)}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function createInstructions(content: string): readonly ContextInstruction[] {
  const normalized = requireText(content, "Wish Agent instructions");
  return Object.freeze([Object.freeze({
    id: "wish-agent-addition",
    authority: "system" as const,
    content: normalized,
  })]);
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    agents: Agents;
  }
}

export default Agents;
