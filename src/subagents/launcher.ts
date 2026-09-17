import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  SpawnSubagentRequest,
  SubagentLaunch,
  SubagentLauncher,
  SubagentLaunchIdentity,
  SubagentResult,
} from "./types.js";
import { snapshotResources, type SubagentResource, type SubagentResourceProvider } from "./resources.js";

/** Host-selected child application adapter; the domain never imports an App. */
export abstract class SubagentLauncherService extends Service implements
  SubagentLauncher {
  private readonly resourceProviders = new Map<string, SubagentResourceProvider>();
  constructor(ctx: Context) {
    super(ctx, "subagentLauncher");
  }

  abstract resolve(
    request: SpawnSubagentRequest,
    identity: SubagentLaunchIdentity,
  ): Promise<SubagentLaunch> | SubagentLaunch;

  registerResourceProvider(provider: SubagentResourceProvider): void {
    if (!provider || typeof provider.id !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(provider.id) || typeof provider.prepare !== "function" || this.resourceProviders.has(provider.id)) throw new Error("Invalid or duplicate Subagent resource provider");
    this.ctx.effect(() => {
      this.resourceProviders.set(provider.id, provider);
      return () => { this.resourceProviders.delete(provider.id); };
    }, `subagent.resource-provider:${provider.id}`);
  }

  protected async prepareResources(request: SpawnSubagentRequest, identity: SubagentLaunchIdentity): Promise<readonly SubagentResource[]> {
    const resources = [] as SubagentResource[];
    for (const provider of this.resourceProviders.values()) {
      request.signal?.throwIfAborted();
      resources.push(...await provider.prepare(request, identity));
    }
    return snapshotResources(resources);
  }

  readResult(
    _id: string,
    _signal?: AbortSignal,
  ): Promise<SubagentResult | undefined> {
    return Promise.resolve(undefined);
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    subagentLauncher: SubagentLauncherService;
  }
}

export default SubagentLauncherService;
