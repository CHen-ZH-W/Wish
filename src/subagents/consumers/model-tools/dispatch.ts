import { Service, type Context } from "@deepseek-ai/cordis";
import type { ToolAuthorizationGrant } from "../../../core/tools/authorization.js";
import type { WishToolExecutionContext } from "../../../composition/tool-context.js";
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

  constructor(ctx: Context, private readonly subagents: Subagents) {
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
    const strategy = this.current();
    return strategy
      ? strategy.dispatch(request, context, grant)
      : this.subagents.spawn(request);
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
