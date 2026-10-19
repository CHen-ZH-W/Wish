import { randomUUID } from "node:crypto";
import type { PermissionProfile } from "../permissions/types.js";

/** One Agent generation's registration visibility and quiescent resource owner. */
export class AgentScope {
  readonly generation = randomUUID();
  private readonly children = new Set<AgentScope>();
  private readonly cleanups = new Set<() => Promise<void> | void>();
  private readonly operations = new Set<AbortController>();
  private activeLeases = 0;
  private releaseWaiters: Array<() => void> = [];
  private closing: Promise<void> | undefined;

  get isClosing(): boolean { return this.closing !== undefined; }

  constructor(readonly agentId: string, readonly parent?: AgentScope) {
    if (typeof agentId !== "string" || !agentId.trim() || agentId !== agentId.trim()) {
      throw new TypeError("Agent Scope id must be non-empty trimmed text");
    }
    if (parent?.closing !== undefined) throw new Error("Cannot create an Agent Scope under a closing parent");
    parent?.children.add(this);
  }

  /** Application contributions precede ancestors; exact Agent contributions come last. */
  chain(): readonly AgentScope[] {
    const result: AgentScope[] = [];
    for (let scope: AgentScope | undefined = this; scope !== undefined; scope = scope.parent) {
      result.unshift(scope);
    }
    return Object.freeze(result);
  }

  own(cleanup: () => Promise<void> | void): () => void {
    if (this.closing !== undefined) throw new Error("Agent Scope is closing");
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  /** Own a listener even when its Event source outlives this Agent. */
  listen(unsubscribe: () => void): () => void {
    return this.own(unsubscribe);
  }

  /** Abort and drain a background operation before releasing registrations. */
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let pending: Promise<T>;
    const detach = this.own(async () => {
      controller.abort(new Error(`Agent Scope ${this.agentId} closed`));
      await pending.catch(() => undefined);
    });
    this.operations.add(controller);
    pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    void pending.finally(() => { this.operations.delete(controller); detach(); }).catch(() => undefined);
    return pending;
  }

  /** An active Step keeps its resolved contributions alive through disposal. */
  acquire(): () => void {
    if (this.closing !== undefined) throw new Error("Agent Scope is closing");
    this.activeLeases++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeLeases--;
      if (this.activeLeases === 0) {
        const waiters = this.releaseWaiters;
        this.releaseWaiters = [];
        for (const wake of waiters) wake();
      }
    };
  }

  dispose(): Promise<void> {
    if (this.closing === undefined) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      // Mark closing before abort listeners run; a listener cannot admit new
      // work or reenter disposal while this Scope is being fenced.
      this.closing = closing;
      // An active Step may be awaiting Agent-local work. Signal that work before
      // waiting for its Step lease, then drain it during reverse cleanup.
      for (const controller of this.operations) {
        controller.abort(new Error(`Agent Scope ${this.agentId} closed`));
      }
      void this.close().then(resolve, reject);
    }
    return this.closing;
  }

  private async close(): Promise<void> {
    const children = await Promise.allSettled([...this.children].map(child => child.dispose()));
    if (this.activeLeases > 0) {
      await new Promise<void>(resolve => this.releaseWaiters.push(resolve));
    }
    const results: PromiseSettledResult<void>[] = [];
    for (const cleanup of [...this.cleanups].reverse()) {
      try { await cleanup(); results.push({ status: "fulfilled", value: undefined }); }
      catch (reason) { results.push({ status: "rejected", reason }); }
    }
    this.cleanups.clear();
    this.parent?.children.delete(this);
    const failures = [...children, ...results].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Agent Scope disposal failed");
  }
}

/** Fence a scoped contribution, then wait for calls admitted before its owner unloads. */
export class AgentScopeContributionWork {
  private active = true;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly name: string) {}

  assertOpen(): void {
    if (!this.active) throw new Error(`Agent Scope contribution ${this.name} is closed`);
  }

  async run<T>(action: () => T | PromiseLike<T>): Promise<T> {
    this.assertOpen();
    const work = Promise.resolve().then(action);
    this.pending.add(work);
    try { return await work; }
    finally { this.pending.delete(work); }
  }

  revoke(): boolean {
    if (!this.active) return false;
    this.active = false;
    return true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}

/** Host facts that a Tool contribution needs from the Agent running it. */
export interface ToolCompositionContract {
  readonly requires: readonly string[];
  /** Capabilities needed to make the Tool usable in the selected child Host. */
  readonly requiredCapabilities?: readonly string[];
}

export interface ComposeAgentScopeInput {
  /** The parent Agent's delegable Tool ceiling, already resolved by Permissions. */
  readonly availableTools: readonly string[];
  /** An explicit selection is checked, while an omitted selection is assembled. */
  readonly requestedTools?: readonly string[];
  /** Tool names actually registered in this Application generation. */
  readonly registeredTools: readonly string[];
  readonly toolContracts: ReadonlyMap<string, ToolCompositionContract>;
  /** Features provided by the selected child execution and interaction adapters. */
  readonly runtimeFeatures: readonly string[];
  readonly allowedCapabilities?: readonly string[];
  readonly permissionProfile?: PermissionProfile;
}

export interface AgentScopeComposition {
  readonly availableTools: readonly string[];
  readonly runtimeFeatures: readonly string[];
}

/** Resolve one Agent's Tool composition before its process or Run is admitted. */
export function composeAgentScope(input: ComposeAgentScopeInput): AgentScopeComposition {
  const ceiling = new Set(input.availableTools);
  const registered = new Set(input.registeredTools);
  const features = new Set(input.runtimeFeatures);
  const capabilities = new Set(input.allowedCapabilities ?? []);
  const executableCapabilities = eligibleCapabilities(capabilities, input.permissionProfile, features.has("human.review"));
  const explicit = input.requestedTools !== undefined;
  const selected = input.requestedTools ?? input.availableTools;
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const name of selected) {
    if (seen.has(name)) throw new Error(`Agent Scope has duplicate Tool ${JSON.stringify(name)}`);
    seen.add(name);
    if (!ceiling.has(name)) {
      throw new Error(`Agent Scope Tool ${JSON.stringify(name)} exceeds the Host delegation ceiling`);
    }
    if (!registered.has(name)) {
      if (explicit) throw new Error(`Agent Scope Tool ${JSON.stringify(name)} is not registered`);
      continue;
    }
    const missing = input.toolContracts.get(name)?.requires.filter(feature => !features.has(feature)) ?? [];
    if (missing.length > 0) {
      if (explicit) {
        throw new Error(`Agent Scope Tool ${JSON.stringify(name)} requires runtime feature(s): ${missing.join(", ")}`);
      }
      continue;
    }
    const missingCapabilities = input.toolContracts.get(name)?.requiredCapabilities?.filter(
      capability => !executableCapabilities.has(capability),
    ) ?? [];
    if (missingCapabilities.length > 0) {
      if (explicit) {
        const hint = input.permissionProfile === "read-only" && !features.has("human.review") && missingCapabilities.includes("process.exec")
          ? " A read-only child has no approval surface for process.exec; omit this Tool, or choose a parent-permitted execution profile if shell execution is intended."
          : "";
        throw new Error(`Agent Scope Tool ${JSON.stringify(name)} requires child capability(s): ${missingCapabilities.join(", ")}.${hint}`);
      }
      continue;
    }
    tools.push(name);
  }
  if (tools.length === 0) throw new Error("Agent Scope has no executable Tools");
  return Object.freeze({
    availableTools: Object.freeze(tools),
    runtimeFeatures: Object.freeze([...features]),
  });
}

/** Capabilities a child can actually use under its profile and review surface. */
export function eligibleCapabilities(
  capabilities: ReadonlySet<string>,
  profile: PermissionProfile | undefined,
  humanReview: boolean,
): ReadonlySet<string> {
  if (profile === undefined || profile === "full-access" || (profile !== "read-only" && humanReview)) return capabilities;
  const automatic = profile === "workspace-write"
    ? new Set(["filesystem.read", "filesystem.write", "process.exec", "runtime.read"])
    : new Set(["filesystem.read", "runtime.read"]);
  const approvalEligible = profile === "read-only" && humanReview
    ? new Set(["filesystem.read", "process.exec", "runtime.read"])
    : automatic;
  return new Set([...capabilities].filter(capability => approvalEligible.has(capability)));
}
