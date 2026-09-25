import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { StepExecutionError } from "../composition/step-execution.js";
import { ApplicationFacade } from "./application.js";
import { SessionFeatureRegistry, type SessionFeature } from "./session-features.js";
import {
  loadWishHostConfiguration,
  type WishHostConfiguration,
} from "./config.js";
import type { WishApplication, WishRuntimeRecovery } from "./types.js";

/** Application owns no Loader row settings; its inputs come from its services. */
export interface Config {}

export const Config: s<Config> = s.object({});

export const inject = [
  "launch",
  "sessions",
  "models",
  "runtimeLifecycle",
  "agents",
];

/** Explicit process-surface overrides; all other settings stay service-owned. */
export interface ApplicationConfigurationOverrides {
  readonly dataDirectory?: string;
  readonly modelsConfigurationPath?: string;
}

export interface ApplicationOpenInput extends ApplicationConfigurationOverrides {}

const EXECUTION_READY_TIMEOUT_MS = 30_000;

/** Cordis owner of the transport-neutral Wish Application facade. */
export class Application extends Service {
  private readonly features = new SessionFeatureRegistry();
  private readonly work: PluginWorkOwner;
  private readonly closing = new AbortController();
  registerSessionFeature(key: string, feature: SessionFeature): () => void {
    const unregister = this.features.register(key, feature);
    try { this.ctx.effect(() => unregister, `session-feature:${key}`); }
    catch (error) { unregister(); throw error; }
    return unregister;
  }
  static readonly inject = inject;

  constructor(ctx: Context) {
    super(ctx, "application");
    this.work = new PluginWorkOwner(ctx, {
      code: "application",
      codeReload: true,
      replacement: "generation",
      beforeDrain: () => this.closing.abort(new StepExecutionError("step_execution_unavailable")),
    });
  }

  /** Resolve the current service graph plus optional surface overrides. */
  async resolve(
    overrides: ApplicationConfigurationOverrides = {},
  ): Promise<WishHostConfiguration> {
    return this.work.run(() => this.resolveConfiguration(overrides, true));
  }

  private async resolveConfiguration(overrides: ApplicationConfigurationOverrides, currentExecutionSettings: boolean): Promise<WishHostConfiguration> {
    // Execution services are acquired by AgentLoop for each Step. Merely reading
    // their configuration must not tie the Application/Run lifetime to a Step.
    const context = currentExecutionSettings ? this.ctx.get("contextEngine") : undefined;
    const compaction = currentExecutionSettings ? this.ctx.get("compaction") : undefined;
    const dataDirectory = overrides.dataDirectory ?? this.ctx.sessions.dataDirectory;
    const models = await this.ctx.models.load({
      dataDirectory,
      ...(overrides.modelsConfigurationPath === undefined
        ? {}
        : { configurationPath: overrides.modelsConfigurationPath }),
    });
    return loadWishHostConfiguration({
      homeDirectory: this.ctx.launch.homeDirectory,
      environment: this.ctx.launch.environment,
      dataDirectory,
      ...(context?.reservedOutputTokens === undefined
        ? {}
        : { reservedOutputTokens: context.reservedOutputTokens }),
      ...(compaction?.keepRecentTokens === undefined
        ? {}
        : { keepRecentTokens: compaction.keepRecentTokens }),
      ...(compaction?.summaryMaxOutputTokens === undefined
        ? {}
        : {
            summaryMaxOutputTokens: compaction.summaryMaxOutputTokens,
          }),
      agentId: this.ctx.agents.agentId,
      agentInstructions: this.ctx.agents.agentInstructions,
      resolvedModels: models,
    });
  }

  /** Open one lifecycle-bound Application generation for a process surface. */
  async open(input: ApplicationOpenInput = {}): Promise<WishApplication> {
    return this.work.runAttached(async () => {
      await this.waitForExecution();
      const configuration = await this.resolveConfiguration(input, false);
      const lifecycle = this.ctx.runtimeLifecycle;
      const recovery: WishRuntimeRecovery = Object.freeze({
        snapshot: (signal?: AbortSignal) => lifecycle.recoverySnapshot(signal),
        resolve: (request: Parameters<WishRuntimeRecovery["resolve"]>[0]) =>
          lifecycle.resolveReconciliation(request),
      });
      const resources = this.ctx.agents.open({
        dataDirectory: configuration.dataDirectory,
        modelsConfiguration: configuration.models,
        reservedOutputTokens: configuration.reservedOutputTokens,
        keepRecentTokens: configuration.keepRecentTokens,
        summaryMaxOutputTokens: configuration.summaryMaxOutputTokens,
      });
      return guardApplication(new ApplicationFacade({
        sessionFeatures: this.features,
        sessions: resources.sessions,
        models: resources.models,
        agent: resources.agent,
        runGeneration: resources.generation,
        recovery,
      }), this.work);
    });
  }

  /** Wait only while opening a new generation. Existing Runs keep using the
   * Runtime Step barrier during AgentLoop replacement and are not torn down.
   */
  private waitForExecution(): Promise<void> {
    if (this.ctx.get("agentLoop")) return Promise.resolve();
    const signal = this.closing.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        remove();
        signal.removeEventListener("abort", aborted);
        if (error === undefined) resolve();
        else reject(error);
      };
      const changed = (name: string) => {
        if (name === "agentLoop" && this.ctx.get("agentLoop")) finish();
      };
      const aborted = () => finish(signal.reason ?? new StepExecutionError("step_execution_unavailable"));
      const remove = this.ctx.on("internal/service", changed);
      const timeout = setTimeout(() => finish(new StepExecutionError("step_execution_unavailable")), EXECUTION_READY_TIMEOUT_MS);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else if (this.ctx.get("agentLoop")) finish();
    });
  }
}

/** Give every Loader config generation a distinct service-provider fiber. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  Config(config);
  const work = new PluginWorkOwner(ctx, {
    code: "application_entry",
    codeReload: true,
    replacement: "generation",
  });
  await work.runDuringActivation(ctx, () => ctx.plugin(Application));
}

export default { inject, Config, apply };

declare module "@deepseek-ai/cordis" {
  interface Context {
    application: Application;
  }
}

const trackedApplicationMethods = new Set<PropertyKey>([
  "createSession",
  "getSession",
  "listSessions",
  "updateSessionMetadata",
  "archiveSession",
  "restoreSession",
  "deleteSession",
  "readSessionHistory",
  "startRun",
]);

/** Old facades retain cleanup handles, but cannot accept work after replacement. */
function guardApplication(
  application: WishApplication,
  work: PluginWorkOwner,
): WishApplication {
  return new Proxy(application, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "observeRun") {
        return (...args: Parameters<WishApplication["observeRun"]>) =>
          work.stream(() => target.observeRun(...args));
      }
      if (trackedApplicationMethods.has(property)) {
        return (...args: unknown[]) => work.run(() => Reflect.apply(value, target, args));
      }
      return (...args: unknown[]) => {
        work.assertOpen();
        return Reflect.apply(value, target, args);
      };
    },
  });
}
