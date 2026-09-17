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
const DEFAULT_AGENT_INSTRUCTION =
  "You are Wish, a coding agent. Work carefully within the provided workspace and report results truthfully.";

/** Loader-owned definition of the default Wish Agent. */
export interface Config {
  readonly agentId?: string;
  readonly agentInstructions?: string;
  readonly permissionProfile?: PermissionProfile;
  readonly availableTools?: string[] | undefined;
  readonly allowedCapabilities?: CapabilityKind[] | undefined;
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
  "agentId" | "agentInstructions"
>;

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

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "agents");
    this.agentId = requireIdentifier(
      config.agentId ?? DEFAULT_AGENT_ID,
      "Wish Agent id",
    );
    this.agentInstructions = createInstructions(
      config.agentInstructions ?? DEFAULT_AGENT_INSTRUCTION,
    );
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

  /** Build one Agent/Application generation from the current Runtime owner. */
  open(input: OpenAgentInput): AgentResources {
    const resources = this.ctx.runEngine.open({
      ...input,
      agentId: this.agentId,
      agentInstructions: this.agentInstructions,
    });
    return Object.freeze({
      ...resources,
      agent: createWishAgent(this.definition, resources),
    });
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
    id: "wish-agent-base",
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
