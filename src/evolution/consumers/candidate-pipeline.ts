import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { ModelEvolutionGenerator, LOCAL_USAGE } from "../generator.js";
import { createCandidateEvolutionPorts } from "../adapters/candidates.js";
import { resolveConfiguredModel } from "../../models/config.js";
import type {} from "../service.js";
import type {} from "../../models/service.js";
import type { EvolutionPorts, EvolutionStageContext } from "../types.js";
import { RuntimeEvolutionGenerator } from "../runtime-generator.js";
import { join } from "node:path";

/** Optional generation adapter; the domain can remain readable without this model consumer. */
export default {
  name: "evolution-candidate-pipeline",
  inject: ["evolution", "candidates", "agentProfiles", "models", "modelAttemptLedger", "launch"],
  apply(ctx: Context): void {
    if (ctx.launch.environment.WISH_EXPERIMENT_WORKER === "1") return;
    const retired = new AbortController();
    const work = new PluginWorkOwner(ctx, { code: "evolution_pipeline", codeReload: true, replacement: "generation", beforeDrain: () => retired.abort() });
    const generator = new ModelEvolutionGenerator(async context => {
      const snapshot = await ctx.agentProfiles.get(context.campaign.spec.baselineSnapshotDigest);
      const resources = ctx.models.open({ ...snapshot.models, maxRetries: 0, fallbackModels: [] }, {
        fixedConfiguration: true, attemptLedger: { ledger: ctx.modelAttemptLedger, currency: ctx.modelAttemptLedger.currency },
      });
      const spec = resolveConfiguredModel(snapshot.models, snapshot.model).spec;
      return { model: resources.model, reference: snapshot.model, ledger: ctx.modelAttemptLedger, currency: ctx.modelAttemptLedger.currency,
        maxOutputTokens: Math.min(spec.maxOutputTokens ?? 8192, spec.defaultMaxOutputTokens ?? 8192), ...(snapshot.resources ? { skillPackages: snapshot.resources.skills.packages } : {}) };
    });
    const runtime = new RuntimeEvolutionGenerator(async context => {
      const selection = context.campaign.spec.context?.generatorSnapshotDigest;
      if (!selection) throw new Error("evolution_generator_snapshot_required");
      const snapshot = await ctx.agentProfiles.get(selection), application = ctx.get("application");
      if (!application) throw new Error("evolution_runtime_unavailable");
      const config = await application.resolve();
      return { snapshot, directory: join(config.dataDirectory, "evolution-generation", context.campaign.id, context.attempt.id), environment: ctx.launch.environment, currency: ctx.modelAttemptLedger.currency };
    });
    const raw = createCandidateEvolutionPorts({ candidates: ctx.candidates, agentProfiles: ctx.agentProfiles,
      evidence: context => ctx.evolution.evidenceFor(context), generate: context => context.campaign.spec.context?.generatorId === "runtime" ? runtime.generate(context) : generator.generate(context),
    });
    const owned = <T>(context: EvolutionStageContext, call: (context: EvolutionStageContext) => Promise<T>) => work.run(() => call({ ...context, signal: AbortSignal.any([context.signal, retired.signal]) }));
    const ports: EvolutionPorts = {
      evidence: context => owned(context, raw.evidence), generate: context => owned(context, raw.generate),
      candidate: context => owned(context, raw.candidate), feedback: context => owned(context, raw.feedback),
      ...(raw.evaluate ? { evaluate: (context: EvolutionStageContext) => owned(context, raw.evaluate!) } : {}),
      ...(raw.publish ? { publish: (context: EvolutionStageContext, approvedDigest: string) => owned(context, value => raw.publish!(value, approvedDigest)) } : {}),
      reconcile: (context, operation) => owned(context, value => operation.stage === "generate" && value.campaign.spec.context?.generatorId === "runtime" ? runtime.reconcile(value) : raw.reconcile?.(value, operation) ?? Promise.resolve(undefined)),
    };
    const remove = ctx.evolution.registerPorts(ports, async (context, stage, error) => {
      if (["evidence", "feedback"].includes(stage)) return LOCAL_USAGE;
      if (stage === "candidate" && error instanceof Error && "code" in error && error.code === "evolution_candidate_validation_failed") return LOCAL_USAGE;
      if (stage !== "generate") return undefined;
      if (context.campaign.spec.context?.generatorId === "runtime") {
        if (error instanceof Error && "code" in error && ["profile_code_changed", "profile_code_unavailable", "experiment_permission_requires_confinement", "experiment_candidate_requires_sandbox"].includes(String(error.code))) return LOCAL_USAGE;
        return runtime.failureUsage(context);
      }
      const rows = await ctx.modelAttemptLedger.list({ runId: context.attempt.id, stepId: context.operationId });
      if (rows.some(row => row.status === "running" || !row.usage)) return undefined;
      const currency = ctx.modelAttemptLedger.currency;
      return { modelCalls: rows.length, tokens: rows.reduce((sum, row) => sum + row.usage!.totalTokens, 0), complete: true,
        costByCurrency: rows.length ? { [currency]: rows.every(row => row.cost?.status === "available" && row.cost.currency === currency) ? rows.reduce((sum, row) => sum + (row.cost?.status === "available" ? row.cost.totalCost : 0), 0) : null } : {} };
    });
    ctx.effect(() => remove, "Evolution candidate pipeline");
  },
};
