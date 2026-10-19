import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { SessionCompactor } from "../compaction.js";
import { ModelCompactionSummarizer } from "../summarizer.js";
import type { CompactionResourcesOptions } from "../service.js";
import { DEFAULT_COMPACTION_STRATEGY_ID } from "../types.js";

/** Explicit standalone composition helper; product processes use the Provider. */
export function createCompactionResources(input: CompactionResourcesOptions): SessionCompactor {
  const summaryModel = input.models.configuredModel.resolve(
    input.summaryModel ?? input.models.configuredModel.getDefaultModel(),
  ).ref;
  const summarizer = new ModelCompactionSummarizer({
    model: input.models.model,
    summaryModel,
    maxOutputTokens: input.summaryMaxOutputTokens,
  });
  return new SessionCompactor({
    session: input.sessions.history.compaction,
    summarizer,
    counter: input.models.requestCounter,
    configuration: { keepRecentTokens: input.keepRecentTokens },
  });
}

/** The bundled algorithm is a normal, independently managed Cordis Provider. */
export default {
  name: "compaction-model-summary",
  inject: ["compaction"],
  apply(ctx: Context) {
    const work = new PluginWorkOwner(ctx, { code: "compaction_model_summary", codeReload: true });
    ctx.compaction.registerStrategy(ctx, {
      id: DEFAULT_COMPACTION_STRATEGY_ID,
      open(input) {
        const compactor = createCompactionResources(input);
        return Object.freeze({
          keepRecentTokens: compactor.keepRecentTokens,
          compact: (request: Parameters<SessionCompactor["compact"]>[0]) => work.run(() => compactor.compact(request)),
        });
      },
    });
  },
};
