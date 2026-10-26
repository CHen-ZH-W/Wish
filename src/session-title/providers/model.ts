import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { ModelRef } from "../../core/model/model.js";
import { resolveConfiguredModel } from "../../models/config.js";
import type { ModelsConfiguration } from "../../models/types.js";
import type {} from "../../models/service.js";
import type {} from "../../sessions/service.js";
import { ModelTitleGenerator, type TitleModelSelection } from "../generator.js";
import { SessionTitleGeneratorService } from "../service.js";
import { TitleGenerationError, type TitleGenerationInput, type TitleGenerationResult } from "../types.js";

export interface Config {
  readonly model?: string;
  readonly maxInputBytes?: number;
  readonly maxOutputTokens?: number;
}

export const Config: s<Config> = s.object({
  model: s.string(),
  maxInputBytes: s.number().step(1).min(64),
  maxOutputTokens: s.number().step(1).min(1),
});

/** Title requests use the measured single-attempt path, outside the Run ledger. */
export class ModelSessionTitleGenerator extends SessionTitleGeneratorService {
  static readonly inject = ["models", "sessions"];
  static readonly Config = Config;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx);
    this.work = new PluginWorkOwner(ctx, { code: "session_title_generator", codeReload: true });
  }

  generate(input: TitleGenerationInput): Promise<TitleGenerationResult> {
    return this.work.run(async () => {
      try {
        input.signal.throwIfAborted();
        const configuration = await this.ctx.models.load({ dataDirectory: this.ctx.sessions.dataDirectory });
        input.signal.throwIfAborted();
        const models = this.ctx.models.open(configuration);
        const reference = this.config.model === undefined
          ? input.model ?? models.configuredModel.getDefaultModel()
          : models.configuredModel.resolve(this.config.model).ref;
        const selection = selectTitleModel(configuration, reference, this.config.model !== undefined);
        return await new ModelTitleGenerator({
          model: models.measuredModel,
          resolveModel: () => selection,
          ...(this.config.maxInputBytes === undefined ? {} : { maxInputBytes: this.config.maxInputBytes }),
          maxOutputTokens: this.config.maxOutputTokens ?? (selection.reasoningOnly ? 2048 : 512),
        }).generate(input);
      } catch (error) {
        if (input.signal.aborted) throw new TitleGenerationError("aborted", false);
        if (error instanceof TitleGenerationError) throw error;
        throw new TitleGenerationError("model_unavailable", false);
      }
    });
  }
}

/** Honor explicit routes; implicit reasoning-only routes may use a same-provider text model. */
export function selectTitleModel(configuration: ModelsConfiguration, reference: ModelRef, explicit = false): TitleModelSelection & { readonly reasoningOnly: boolean } {
  let resolved = resolveConfiguredModel(configuration, reference);
  if (!explicit && resolved.spec.reasoning && !resolved.spec.reasoningControl?.efforts.includes("none")) {
    const alternate = configuration.providers.find(provider => provider.id === reference.provider)?.models
      .find(model => model.status === "active" && model.input.text && !model.reasoning);
    if (alternate) resolved = resolveConfiguredModel(configuration, { provider: reference.provider, model: alternate.id });
  }
  return {
    model: resolved.ref,
    reasoningOnly: resolved.spec.reasoning && !resolved.spec.reasoningControl?.efforts.includes("none"),
    ...(resolved.spec.reasoningControl?.efforts.includes("none") ? { reasoningEffort: "none" } : {}),
    ...(resolved.spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolved.spec.maxOutputTokens }),
  };
}

export default ModelSessionTitleGenerator;
