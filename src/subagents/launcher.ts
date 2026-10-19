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
  /** Interaction and execution features that this child Host can actually supply. */
  private readonly resourceProviders = new Map<string, SubagentResourceProvider>();
  get runtimeFeatures(): readonly string[] {
    return Object.freeze([...new Set([...this.resourceProviders.values()]
      .flatMap(provider => provider.runtimeFeatures ?? []))]);
  }
  constructor(ctx: Context) {
    super(ctx, "subagentLauncher");
  }

  abstract resolve(
    request: SpawnSubagentRequest,
    identity: SubagentLaunchIdentity,
  ): Promise<SubagentLaunch> | SubagentLaunch;

  cleanupLaunchSecrets(
    _identity: SubagentLaunchIdentity,
  ): Promise<void> | void {}

  purgeChild(_identity: SubagentLaunchIdentity): Promise<void> | void {}

  registerResourceProvider(provider: SubagentResourceProvider): void {
    if (!provider || typeof provider.id !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(provider.id) || typeof provider.prepare !== "function" || this.resourceProviders.has(provider.id)) throw new Error("Invalid or duplicate Subagent resource provider");
    if (provider.runtimeFeatures !== undefined &&
        (!Array.isArray(provider.runtimeFeatures) || provider.runtimeFeatures.some(feature =>
          typeof feature !== "string" || feature.length === 0 || feature !== feature.trim()
        ))) throw new TypeError("Invalid Subagent runtime feature");
    this.ctx.effect(() => {
      this.resourceProviders.set(provider.id, provider);
      return () => { this.resourceProviders.delete(provider.id); };
    }, `subagent.resource-provider:${provider.id}`);
  }

  protected async prepareResources(request: SpawnSubagentRequest, identity: SubagentLaunchIdentity, excludedProviders: readonly string[] = []): Promise<readonly SubagentResource[]> {
    const resources = [] as SubagentResource[];
    for (const provider of this.resourceProviders.values()) {
      if (excludedProviders.includes(provider.id)) continue;
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
