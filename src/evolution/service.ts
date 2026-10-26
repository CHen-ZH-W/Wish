import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { digest } from "../agent-profiles/validation.js";
import { StorageEvolutionStore } from "./store.js";
import { EvolutionController } from "./controller.js";
import { EvolutionTraceArchive, EvolutionObservationRegistry, diagnoseTraces, type TraceRecord, type RunProvenance, type TaskOutcomeReceipt } from "./observations.js";
import { LOCAL_USAGE } from "./generator.js";
import { journalEvolutionPorts, StorageEvolutionOperationJournal } from "./journal.js";
import { ExperienceWiki } from "./experience.js";
import { SkillUsageLedger } from "./skill-research.js";
import { resolveConfiguredModel } from "../models/config.js";
import { SUPPORTED_EVOLUTION_TARGETS } from "./adapters/targets.js";
import { StrategyGeneStore } from "./strategy.js";
import type { EvolutionCampaign, EvolutionCampaignSpec, EvolutionEvidence, EvolutionPorts, EvolutionStageContext, EvolutionTicket, EvolutionTarget } from "./types.js";
import type {} from "../agent-profiles/service.js";
import type {} from "../apps/service.js";
import type {} from "../storage/binding.js";
import type {} from "../sessions/service.js";

export interface Config { readonly backendId?: string; readonly diagnosticMaxModelCalls?: number; readonly diagnosticMaxTokens?: number; readonly diagnosticRepeatedToolCalls?: number; readonly diagnosticMaxCostByCurrencyJson?: string }
export const Config: s<Config> = s.object({ backendId: s.string(), diagnosticMaxModelCalls: s.number().step(1).min(1), diagnosticMaxTokens: s.number().step(1).min(1), diagnosticRepeatedToolCalls: s.number().step(1).min(2), diagnosticMaxCostByCurrencyJson: s.string() });

/** Optional product owner. No Runtime or other foundation service depends on it. */
export class EvolutionService extends Service {
  static readonly inject = ["storageBackend", "agentProfiles", "sessions", "launch"];
  static readonly Config = Config;
  readonly controller: EvolutionController;
  readonly archive: EvolutionTraceArchive;
  private readonly observations: EvolutionObservationRegistry;
  private readonly journal: StorageEvolutionOperationJournal;
  private readonly wiki: ExperienceWiki;
  private readonly skillUsage: SkillUsageLedger;
  private readonly genes: StrategyGeneStore;
  private readonly diagnosticPolicy: Parameters<typeof diagnoseTraces>[2];
  private readonly owner: PluginWorkOwner;
  private ports: EvolutionPorts | undefined;
  private readonly jobs = new Map<string, Promise<EvolutionCampaign>>();
  private readonly ready: Promise<void>;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "evolution");
    const prices: unknown = JSON.parse(config.diagnosticMaxCostByCurrencyJson ?? "{}");
    if (!prices || typeof prices !== "object" || Array.isArray(prices) || Object.entries(prices).some(([currency, cost]) => !/^[A-Z]{3}$/u.test(currency) || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error("evolution_diagnostic_cost_policy_invalid");
    this.diagnosticPolicy = { maxModelCalls: config.diagnosticMaxModelCalls ?? 12, maxTokens: config.diagnosticMaxTokens ?? 32_000, repeatedToolCalls: config.diagnosticRepeatedToolCalls ?? 3, maxCostByCurrency: prices as Record<string, number> };
    const lease = ctx.storageBackend.acquire(config.backendId ?? ctx.storageBackend.id, { kv: { list: true } });
    const traceLease = ctx.storageBackend.acquire(lease.id, { kv: { list: true } });
    this.archive = new EvolutionTraceArchive(traceLease, traceLease.id);
    this.observations = new EvolutionObservationRegistry(traceLease, traceLease.id);
    this.journal = new StorageEvolutionOperationJournal(traceLease, traceLease.id);
    this.wiki = new ExperienceWiki(traceLease, traceLease.id);
    this.skillUsage = new SkillUsageLedger(traceLease, traceLease.id);
    this.genes = new StrategyGeneStore(traceLease, traceLease.id);
    const call = <K extends keyof EvolutionPorts>(key: K): NonNullable<EvolutionPorts[K]> => {
      const port = this.ports?.[key]; if (!port) throw new Error(`evolution_${key}_unavailable`);
      return port as NonNullable<EvolutionPorts[K]>;
    };
    const delegated: EvolutionPorts = {
      evidence: context => call("evidence")(context), generate: context => call("generate")(context),
      candidate: context => call("candidate")(context), feedback: context => call("feedback")(context),
      reconcile: (context, operation) => this.ports?.reconcile?.(context, operation) ?? Promise.resolve(undefined),
      cleanup: context => this.ports?.cleanup?.(context) ?? Promise.resolve(),
    };
    this.controller = new EvolutionController({ store: new StorageEvolutionStore(lease), ports: new Proxy(delegated, {
      get: (target, property, receiver) => property === "evaluate" || property === "publish" ? this.ports?.[property] : Reflect.get(target, property, receiver),
    }) });
    this.owner = new PluginWorkOwner(ctx, { code: "evolution", codeReload: true, replacement: "generation", beforeDrain: () => this.controller.suspend(),
      close: async () => { try { await Promise.allSettled([this.ready]); await this.controller.close(); await Promise.allSettled(this.jobs.values()); } finally { traceLease.release(); } } });
    const controller = this.controller;
    this.ready = (async () => {
      for (const campaign of await controller.list()) if (["running", "interrupted"].includes(campaign.state)) await controller.recover(campaign.id);
    })();
    void this.ready.catch(() => {});
    // Publish the capability before asynchronous recovery so CLI consumers register
    // their command hooks during composition; business calls still await ready.
    ctx.effect(async () => { await this.ready; return () => {}; }, "Evolution storage recovery");
  }
  registerPorts(ports: EvolutionPorts, failureUsage?: Parameters<typeof journalEvolutionPorts>[2]): () => void {
    this.owner.assertAttached(); if (this.ports) throw new Error("evolution_pipeline_duplicate");
    const registered = journalEvolutionPorts(ports, this.journal, failureUsage); this.ports = registered;
    return () => { if (this.ports === registered) this.ports = undefined; };
  }
  get available(): boolean { return !!this.ports; }
  list() { return this.owner.run(async () => { await this.ready; return this.controller.list(); }); }
  get(id: string) { return this.owner.run(async () => { await this.ready; return this.controller.get(id); }); }
  recordTrace(trace: TraceRecord) { return this.owner.run(async () => {
    const { origin, outcome } = await this.observations.get(trace.runId);
    if (origin && (origin.sourceKind !== trace.sourceKind || origin.taskId !== trace.taskId || origin.sessionId !== trace.sessionId) || outcome && trace.outcome && digest(outcome) !== digest(trace.outcome)) throw new Error("evolution_trace_registered_identity_mismatch");
    return this.archive.put(trace);
  }); }
  recordRunProvenance(value: RunProvenance) { return this.owner.run(async () => {
    const previous = (await this.archive.list()).filter(row => row.runId === value.runId);
    if (previous.some(row => row.sourceKind !== value.sourceKind || row.taskId !== value.taskId || row.sessionId !== value.sessionId)) throw new Error("evolution_provenance_must_precede_capture");
    return this.observations.recordOrigin(value);
  }); }
  recordTaskOutcome(value: TaskOutcomeReceipt) { return this.owner.run(() => this.observations.recordOutcome(value)); }
  observationFacts() { return this.owner.run(() => this.observations.list()); }
  diagnose(traces: readonly TraceRecord[]) { this.owner.assertOpen(); return diagnoseTraces(traces, 3, this.diagnosticPolicy); }
  experiences(scope: string) { return this.owner.run(() => this.wiki.inspect(scope)); }
  recordExperience(input: import("./experience.js").ExperienceDraft) { return this.owner.run(async () => {
    const traces = await this.traces(), selected = traces.filter(trace => input.traceIds.includes(trace.id)), sessions = this.ctx.sessions.acquire();
    try { for (const trace of selected) if (!trace.sessionId || (await sessions.manager.get({ sessionId: trace.sessionId })).scope !== input.scope) throw new Error("evolution_experience_scope_mismatch"); }
    finally { sessions.release(); }
    return this.wiki.record(input, traces);
  }); }
  reviewExperience(input: Parameters<ExperienceWiki["review"]>[0]) { return this.owner.run(() => this.wiki.review(input)); }
  proposeExperienceMemory(input: Parameters<ExperienceWiki["proposeMemory"]>[1]) { return this.owner.run(() => {
    const memory = this.ctx.get("memoryCuration"); if (!memory) throw new Error("evolution_memory_unavailable"); return this.wiki.proposeMemory(memory, input);
  }); }
  recordSkillUsage(input: import("./skill-research.js").SkillUsageReceipt) { return this.owner.run(() => this.skillUsage.record(input)); }
  skillUsageSummary(packageDigest?: string) { return this.owner.run(() => this.skillUsage.summary(packageDigest)); }
  strategyGenes(scope: string) { return this.owner.run(() => this.genes.list(scope)); }
  proposeStrategyGene(input: Parameters<StrategyGeneStore["propose"]>[0], profileSnapshotDigest: string) { return this.owner.run(async () => {
    const snapshot = await this.ctx.agentProfiles.get(profileSnapshotDigest);
    if (!snapshot.resources) throw new Error("evolution_frozen_resources_required");
    return this.genes.propose(input, await this.wiki.list(input.scope), snapshot.resources.skills.packages.map(pkg => pkg.digest));
  }); }
  traces() { return this.owner.run(() => this.archive.list({ forGeneration: true })); }
  async evidenceFor(context: EvolutionStageContext): Promise<EvolutionEvidence> {
    const scope = context.campaign.spec.context;
    const latestInput = context.campaign.inputs?.at(-1);
    const wanted = new Set(latestInput?.traceIds.length ? latestInput.traceIds : scope?.traceIds ?? []);
    const all = await this.archive.list({ forGeneration: true });
    const workspaceSessions = new Set<string>();
    if (scope?.workspaceRoot) {
      const sessions = this.ctx.sessions.acquire();
      try {
        await Promise.all([...new Set(all.map(trace => trace.sessionId).filter((id): id is string => !!id))].map(async sessionId => {
          try { if ((await sessions.manager.get({ sessionId, signal: context.signal })).scope === scope.workspaceRoot) workspaceSessions.add(sessionId); }
          catch (error) { if (context.signal.aborted) throw error; }
        }));
      } finally { sessions.release(); }
    }
    const matches = all.filter(trace => (!scope?.sessionId || trace.sessionId === scope.sessionId) &&
      (scope?.workspaceRoot ? !!trace.sessionId && workspaceSessions.has(trace.sessionId) : !!scope?.sessionId || wanted.has(trace.id)) && (!wanted.size || wanted.has(trace.id)));
    const traces = wanted.size ? matches : matches.slice(-20);
    if ([...wanted].some(id => !traces.some(trace => trace.id === id))) throw new Error("evolution_evidence_scope_mismatch");
    const automatic = this.diagnose(traces).filter(ticket => context.campaign.spec.allowedTargets.includes(ticket.target));
    const manual: EvolutionTicket = { id: `ticket-${digest({ campaign: context.campaign.id, traces: traces.map(trace => trace.digest) })}`,
      traceIds: traces.map(trace => trace.id), traceDigests: traces.map(trace => trace.digest),
      evidenceRefs: [...new Set(traces.flatMap(trace => trace.evidenceRefs))], failureCategory: "unknown",
      summary: "User-requested improvement; cause remains a hypothesis.", problem: context.campaign.spec.objective,
      hypothesis: latestInput?.feedback ?? scope?.hypothesis ?? context.campaign.spec.objective,
      target: context.campaign.spec.allowedTargets[0]!, confidence: 0 };
    const tickets = automatic.length ? automatic : [manual];
    if (traces.length && scope?.workspaceRoot) for (const ticket of tickets) await this.wiki.record({ scope: scope.workspaceRoot,
      topic: ticket.problem.slice(0, 500), claim: ticket.hypothesis.slice(0, 4000), conditions: [], actions: [], warnings: (ticket.alternatives ?? []).map(value => value.slice(0, 1000)), traceIds: ticket.traceIds }, traces);
    const experiences = scope?.workspaceRoot ? (await this.wiki.list(scope.workspaceRoot)).filter(entry => entry.evidence.every(evidence => traces.some(trace => trace.id === evidence.traceId))).slice(-8) : [];
    const strategies = scope?.workspaceRoot ? (await this.genes.retrieve({ scope: scope.workspaceRoot, query: context.campaign.spec.objective })).filter(gene => gene.experienceDigests.every(key => experiences.some(entry => entry.digest === key))) : [];
    return { traces, tickets, experiences, strategies, usage: LOCAL_USAGE };
  }
  create(spec: EvolutionCampaignSpec, requestId: string) { return this.owner.run(async () => { await this.ready; return this.controller.create(spec, requestId); }); }
  async begin(input: { readonly objective: string; readonly requestId: string; readonly sessionId?: string; readonly workspaceRoot: string; readonly target?: EvolutionTarget; readonly generator?: "structured" | "runtime"; readonly hypothesis?: string; readonly traceIds?: readonly string[] }): Promise<EvolutionCampaign> {
    return this.owner.run(async () => {
      await this.ready;
      if (!this.ports) throw new Error("evolution_pipeline_unavailable");
      if (!input.objective.trim() || input.objective.length > 12_000) throw new Error("evolution_objective_invalid");
      if (input.target && !(SUPPORTED_EVOLUTION_TARGETS as readonly string[]).includes(input.target)) throw new Error("evolution_target_contract_unavailable");
      const engine = input.generator ?? (this.ctx.launch.environment.WISH_EVOLUTION_GENERATOR === "runtime" ? "runtime" : "structured");
      const existing = (await this.controller.list()).find(item => item.requestId === input.requestId);
      if (existing) {
        if (existing.spec.objective !== input.objective || existing.spec.context?.workspaceRoot !== input.workspaceRoot || existing.spec.context?.sessionId !== input.sessionId ||
          existing.spec.allowedTargets.length !== 1 || existing.spec.allowedTargets[0] !== (input.target ?? "prompt") || existing.spec.context?.hypothesis !== (input.hypothesis || undefined) ||
          digest(existing.spec.context?.traceIds ?? []) !== digest(input.traceIds ?? [])) throw new Error("evolution_request_conflict");
        if ((existing.spec.context?.generatorId ?? "structured") !== engine) throw new Error("evolution_request_conflict");
        if (existing.state === "waiting-input") this.schedule(existing.id);
        return existing;
      }
      const host = await ctxConfiguration(this.ctx);
      const agents = this.ctx.get("agents"), tools = this.ctx.get("tools");
      if (!agents || !tools) throw new Error("evolution_baseline_unavailable");
      const names = tools.registryFor(agents.scope).list().map(item => item.name).filter(name => !name.startsWith("memory_") && (!agents.permissions.availableTools || agents.permissions.availableTools.includes(name)));
      const selection = typeof host.models.defaultModel === "string" ? host.models.defaultModel : `${host.models.defaultModel.provider}/${host.models.defaultModel.model}`;
      const id = `evolution-base-${digest(input.requestId).slice(0, 24)}`;
      await this.ctx.agentProfiles.register({ schemaVersion: 1, id, version: 1, model: selection, tools: names,
        permissionProfile: "read-only", memory: "none" });
      const baseline = await this.ctx.agentProfiles.capture(`${id}@1`, host, { resources: {
        cwd: input.workspaceRoot, skills: this.ctx.get("skills"), emptySkills: !this.ctx.get("skills"), memory: { kind: "empty" },
      } });
      let generatorSnapshotDigest: string | undefined;
      if (engine === "runtime") {
        const generatorId = `${id}-coding`;
        const modelSpec = resolveConfiguredModel(host.models, baseline.model).spec;
        await this.ctx.agentProfiles.register({ ...baseline.definition, id: generatorId, permissionProfile: "workspace-write", maxParallelCalls: 1,
          tools: names.filter(name => ["read", "write", "edit", "grep", "bash", "list_skills", "read_skill"].includes(name)),
          allowedCapabilities: ["filesystem.read", "filesystem.write", "process.exec", "runtime.read"], request: { maxOutputTokens: Math.min(8192, modelSpec.maxOutputTokens ?? 8192, modelSpec.defaultMaxOutputTokens ?? 8192) } });
        const generator = await this.ctx.agentProfiles.capture(`${generatorId}@1`, { ...host, models: { ...host.models, maxRetries: 0, fallbackModels: [] } }, { resources: {
          cwd: input.workspaceRoot, skills: this.ctx.get("skills"), emptySkills: !this.ctx.get("skills"), memory: { kind: "empty" },
        } });
        generatorSnapshotDigest = generator.digest;
      }
      const campaign = await this.controller.create({ objective: input.objective, baselineSnapshotDigest: baseline.digest,
        evaluationMode: "deferred", allowedTargets: [input.target ?? "prompt"], maxRounds: 3, patience: 3,
        budget: { modelCalls: engine === "runtime" ? 24 : 3, tokens: engine === "runtime" ? 256_000 : 32_000, costByCurrency: {}, timeoutMs: 600_000 },
        context: { workspaceRoot: input.workspaceRoot, generatorId: engine, ...(generatorSnapshotDigest ? { generatorSnapshotDigest } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.hypothesis ? { hypothesis: input.hypothesis } : {}), ...(input.traceIds ? { traceIds: input.traceIds } : {}) },
      }, input.requestId);
      this.schedule(campaign.id);
      return campaign;
    });
  }
  schedule(id: string): void {
    this.owner.assertOpen(); if (this.jobs.has(id)) return;
    const job = this.owner.run(() => this.controller.run(id)); this.jobs.set(id, job);
    void job.catch(error => this.ctx.logger.warn("Evolution task stopped", error)).finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); });
  }
  waitFor(id: string): Promise<EvolutionCampaign> { return this.owner.run(() => this.jobs.get(id) ?? this.controller.get(id)); }
  async continue(id: string, input: { readonly expectedRevision: number; readonly requestId: string; readonly feedback: string }) {
    return this.owner.run(async () => { const result = await this.controller.continue(id, input); this.schedule(id); return result; });
  }
  async control(id: string, action: "pause" | "cancel" | "resume" | "recover", expectedRevision: number) {
    return this.owner.run(async () => {
      const result = await this.controller[action](id, { expectedRevision });
      if (["resume", "recover"].includes(action) && result.state === "waiting-input") this.schedule(id);
      return result;
    });
  }
}
async function ctxConfiguration(ctx: Context) {
  const application = ctx.get("application");
  if (!application) throw new Error("evolution_baseline_unavailable");
  return application.resolve();
}
declare module "@deepseek-ai/cordis" { interface Context { evolution: EvolutionService } }
export default EvolutionService;
