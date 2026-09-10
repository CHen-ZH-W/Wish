import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { BasicToolContext, ToolApprovalPort } from "../tools/index.js";
import { ApplicationFacade } from "./application.js";
import {
  loadWishHostConfiguration,
  type WishHostConfiguration,
} from "./config.js";
import type { WishApplication } from "./types.js";

/** Application owns no Loader row settings; its inputs come from its services. */
export interface Config {}

export const Config: s<Config> = s.object({});

export const inject = [
  "launch",
  "sessions",
  "models",
  "contextEngine",
  "compaction",
  "agents",
];

/** Explicit process-surface overrides; all other settings stay service-owned. */
export interface ApplicationConfigurationOverrides {
  readonly dataDirectory?: string;
  readonly modelsConfigurationPath?: string;
}

export interface ApplicationOpenInput extends ApplicationConfigurationOverrides {
  readonly approval?: ToolApprovalPort<BasicToolContext>;
}

/** Cordis owner of the transport-neutral Wish Application facade. */
export class Application extends Service {
  static readonly inject = inject;

  constructor(ctx: Context) {
    super(ctx, "application");
  }

  /** Resolve the current service graph plus optional surface overrides. */
  async resolve(
    overrides: ApplicationConfigurationOverrides = {},
  ): Promise<WishHostConfiguration> {
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
      ...(this.ctx.contextEngine.reservedOutputTokens === undefined
        ? {}
        : { reservedOutputTokens: this.ctx.contextEngine.reservedOutputTokens }),
      ...(this.ctx.compaction.keepRecentTokens === undefined
        ? {}
        : { keepRecentTokens: this.ctx.compaction.keepRecentTokens }),
      ...(this.ctx.compaction.summaryMaxOutputTokens === undefined
        ? {}
        : {
            summaryMaxOutputTokens: this.ctx.compaction.summaryMaxOutputTokens,
          }),
      agentId: this.ctx.agents.agentId,
      agentInstructions: this.ctx.agents.agentInstructions,
      resolvedModels: models,
    });
  }

  /** Open one lifecycle-bound Application generation for a process surface. */
  async open(input: ApplicationOpenInput = {}): Promise<WishApplication> {
    const { approval, ...overrides } = input;
    const configuration = await this.resolve(overrides);
    const resources = this.ctx.agents.open({
      dataDirectory: configuration.dataDirectory,
      modelsConfiguration: configuration.models,
      reservedOutputTokens: configuration.reservedOutputTokens,
      keepRecentTokens: configuration.keepRecentTokens,
      summaryMaxOutputTokens: configuration.summaryMaxOutputTokens,
      ...(approval === undefined ? {} : { approval }),
    });
    return new ApplicationFacade({
      sessions: resources.sessions,
      models: resources.models,
      agent: resources.agent,
      runGeneration: resources.generation,
    });
  }
}

/** Give every Loader config generation a distinct service-provider fiber. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  Config(config);
  await ctx.plugin(Application);
}

export default { inject, Config, apply };

declare module "@deepseek-ai/cordis" {
  interface Context {
    application: Application;
  }
}
