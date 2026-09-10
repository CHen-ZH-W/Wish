import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type {
  WishAgentConfiguration,
  WishAgentProtocol,
} from "../../apps/types.js";
import type { ContextInstruction } from "../../context/types.js";
import {
  Agent as CoreAgent,
  type AgentDefinition,
} from "./agent.js";
import type {
  OpenRuntimeInput,
  RuntimeDependencies,
  RuntimeResources,
  WishRunGeneration,
} from "../runtime/service.js";

const DEFAULT_AGENT_ID = "wish";
const DEFAULT_AGENT_INSTRUCTION =
  "You are Wish, a coding agent. Work carefully within the provided workspace and report results truthfully.";

/** Loader-owned definition of the default Wish Agent. */
export interface Config {
  readonly agentId?: string;
  readonly agentInstructions?: string;
}

export const Config: s<Config> = s.object({
  agentId: s.string(),
  agentInstructions: s.string(),
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

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "agents");
    this.agentId = requireIdentifier(
      config.agentId ?? DEFAULT_AGENT_ID,
      "Wish Agent id",
    );
    this.agentInstructions = createInstructions(
      config.agentInstructions ?? DEFAULT_AGENT_INSTRUCTION,
    );
    this.definition = Object.freeze({
      id: this.agentId,
      name: "Wish",
      configuration: Object.freeze({
        agentInstructions: this.agentInstructions,
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
