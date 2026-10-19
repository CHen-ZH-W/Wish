import { Service, type Context } from "@deepseek-ai/cordis";
import type { ToolAuthorizationGrant } from "../../../core/tools/authorization.js";
import type { WishToolExecutionContext } from "../../../composition/tool-context.js";
import { composeAgentScope } from "../../../composition/agent-scope.js";
import type { AgentScopePreset } from "../../../composition/agent-preset.js";
import type { Tools } from "../../../tools/service.js";
import { canDelegatePermissionProfile } from "../../../permissions/delegation.js";
import type { SpawnSubagentRequest, SubagentRecord, Subagents } from "../../types.js";
import type { AgentToolOutput } from "./tools.js";

export type SubagentToolDispatchResult = SubagentRecord | AgentToolOutput;

export interface SubagentToolDispatchStrategy {
  readonly id: string;
  /** A replacement stays invisible until its Host transaction commits. */
  readonly active: () => boolean;
  dispatch(
    request: SpawnSubagentRequest,
    context: WishToolExecutionContext,
    grant: ToolAuthorizationGrant,
  ): Promise<SubagentToolDispatchResult>;
}

/**
 * Stable Tool-facing port. Optional schedulers contribute dispatch policy; they never
 * register another copy of the model Tools. With no active contribution, dispatch
 * falls back to the Subagents domain port.
 */
export class SubagentToolDispatchService extends Service {
  private readonly strategies: SubagentToolDispatchStrategy[] = [];

  constructor(
    ctx: Context,
    private readonly subagents: Subagents,
    private readonly tools: Pick<Tools, "registry" | "getCompositionContracts">,
    private readonly runtimeFeatures: readonly string[] | (() => readonly string[]) = [],
    private readonly presetForRole?: (role: string | undefined) => AgentScopePreset | undefined,
  ) {
    super(ctx, "subagentToolDispatch");
  }

  get activeStrategy(): string {
    return this.current()?.id ?? "direct";
  }

  register(strategy: SubagentToolDispatchStrategy): () => void {
    // A code replacement may stage a successor before retiring its predecessor.
    // Keep both registrations and select the newest committed contribution.
    this.strategies.push(strategy);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const index = this.strategies.indexOf(strategy);
      if (index >= 0) this.strategies.splice(index, 1);
    };
  }

  async dispatch(
    request: SpawnSubagentRequest,
    context: WishToolExecutionContext,
    grant: ToolAuthorizationGrant,
  ): Promise<SubagentToolDispatchResult> {
    const assembled = this.compose(request, context);
    const strategy = this.current();
    return strategy
      ? strategy.dispatch(assembled, context, grant)
      : this.subagents.spawn(assembled);
  }

  private compose(
    request: SpawnSubagentRequest,
    context: WishToolExecutionContext,
  ): SpawnSubagentRequest {
    const parent = context.permissions;
    if (request.parentAgentId !== parent.subject.agentId ||
        request.parentSessionId !== parent.subject.sessionId ||
        request.parentRunId !== parent.subject.runId ||
        request.workspaceRoot !== context.workspace.root) {
      throw new Error("Child Agent owner differs from the authorized parent Step");
    }
    const profile = request.permissionProfile ?? parent.profile;
    if (!canDelegatePermissionProfile(parent.profile, profile)) {
      throw new Error("Child Agent permission profile cannot exceed its parent");
    }
    const ceiling = parent.delegation ?? {
      availableTools: parent.availableTools,
      allowedCapabilities: parent.ceiling.allowedCapabilities,
    };
    const allowedCapabilities = request.allowedCapabilities ?? ceiling.allowedCapabilities;
    if (allowedCapabilities.some(kind => !ceiling.allowedCapabilities.includes(kind))) {
      throw new Error("Child Agent capabilities exceed the Host delegation ceiling");
    }
    const preset = this.presetForRole?.(request.role);
    const localTools = preset?.localTools ?? [];
    const features = typeof this.runtimeFeatures === "function"
      ? this.runtimeFeatures()
      : this.runtimeFeatures;
    const scope = composeAgentScope({
      availableTools: [...ceiling.availableTools, ...localTools.map(tool => tool.name)],
      ...(request.availableTools === undefined ? {} : { requestedTools: request.availableTools }),
      registeredTools: [...this.tools.registry.list().map(tool => tool.name), ...localTools.map(tool => tool.name)],
      toolContracts: new Map([...this.tools.getCompositionContracts(), ...localTools.map(tool => [tool.name, tool] as const)]),
      allowedCapabilities,
      permissionProfile: profile,
      runtimeFeatures: preset?.memory === "none" ? features.filter(feature => feature !== "memory.snapshot") : features,
    });
    return Object.freeze({
      ...request,
      permissionProfile: profile,
      availableTools: scope.availableTools,
      allowedCapabilities: Object.freeze([...allowedCapabilities]),
    });
  }

  private current(): SubagentToolDispatchStrategy | undefined {
    for (let index = this.strategies.length - 1; index >= 0; index--) {
      const strategy = this.strategies[index];
      if (strategy?.active()) return strategy;
    }
    return undefined;
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    subagentToolDispatch: SubagentToolDispatchService;
  }
}
