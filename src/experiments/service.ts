import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { ProfileRecordStore } from "../agent-profiles/store.js";
import { AgentProfileError, digest, freezeJson, identifier } from "../agent-profiles/validation.js";
import { validateDataset, validatePlan, validateRun } from "./validation.js";
import { summarize } from "./metrics.js";
import type { ExperimentDataset, ExperimentExecutor, ExperimentRun } from "./types.js";
import { createProcessOwner, ownerIsDead } from "../agent-profiles/process-owner.js";

export interface Config { readonly directory?: string }
export const Config: s<Config> = s.object({ directory: s.string() });

/** Experiments own benchmark facts and execution jobs, independently of Profile and Runtime state. */
export class Experiments extends Service {
  static readonly inject = ["storageBackend", "agentProfiles", "launch"];
  static readonly Config = Config;
  private readonly datasets: ProfileRecordStore<ExperimentDataset>;
  private readonly runs: ProfileRecordStore<ExperimentRun>;
  private readonly datasetVersions: ProfileRecordStore<string>;
  private readonly work: PluginWorkOwner;
  private readonly executors = new Map<string, { executor: ExperimentExecutor; supports?: (snapshot: import("../agent-profiles/types.js").AgentProfileSnapshot) => boolean }>();
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<ExperimentRun>; executorIds: ReadonlySet<string> }>();
  private readonly directory: string;
  private readonly instanceId: string;
  private readonly ownership = createProcessOwner();
  readonly ready: Promise<void>;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "experiments");
    this.directory = resolve(config.directory ?? join(ctx.launch.homeDirectory, ".wish", "experiments"));
    this.instanceId = ctx.root.get("pluginInspection")?.inspect().instanceId ?? randomUUID();
    const lease = ctx.storageBackend.acquire(ctx.storageBackend.id, { kv: { list: true } });
    this.datasets = new ProfileRecordStore(lease, lease.id, "experiments/datasets/v1", validateDataset);
    this.datasetVersions = new ProfileRecordStore(lease, lease.id, "experiments/dataset-versions/v1", value => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new AgentProfileError("experiment_invalid_dataset_digest");
      return value;
    });
    this.runs = new ProfileRecordStore(lease, lease.id, "experiments/runs/v1", validateRun);
    this.work = new PluginWorkOwner(ctx, { code: "experiments", codeReload: true,
      beforeDrain: () => { for (const job of this.active.values()) job.controller.abort(new Error("experiment_owner_closed")); },
      close: async () => { (await this.ownership).release(); lease.release(); },
    });
    this.ready = Promise.resolve().then(async () => {
      for (const run of await this.runs.list()) if (run.status === "running" && await ownerIsDead(run.owner)) await this.runs.update(run.id, prior => ({ ...prior, status: "interrupted", endedAt: new Date().toISOString() }));
    });
    void this.ready.catch(() => {});
    ctx.effect(async () => { await this.ready; return () => {}; }, "experiment recovery");
  }
  registerExecutor(executor: ExperimentExecutor, id = "default", supports?: (snapshot: import("../agent-profiles/types.js").AgentProfileSnapshot) => boolean): () => void {
    this.work.assertAttached();
    if (this.executors.has(id)) throw new AgentProfileError("experiment_executor_duplicate");
    this.executors.set(id, { executor, ...(supports ? { supports } : {}) });
    return () => { if (this.executors.get(id)?.executor === executor) this.executors.delete(id); for (const job of this.active.values()) if (job.executorIds.has(id)) job.controller.abort(); };
  }
  async registerDataset(value: unknown): Promise<{ readonly digest: string; readonly dataset: ExperimentDataset }> {
    return this.work.run(async () => {
      await this.ready; const dataset = validateDataset(value); const key = digest(dataset);
      try { await this.datasetVersions.create(`${dataset.id}@${dataset.version}`, key); }
      catch (error) { if (error instanceof AgentProfileError && error.code === "profile_immutable_conflict") throw new AgentProfileError("experiment_dataset_version_conflict"); throw error; }
      await this.datasets.create(key, dataset); return { digest: key, dataset };
    });
  }
  async listDatasets(): Promise<readonly { digest: string; dataset: ExperimentDataset }[]> {
    return this.work.run(async () => { await this.ready; return (await this.datasets.list()).map(dataset => ({ digest: digest(dataset), dataset })); });
  }
  async list(): Promise<readonly ExperimentRun[]> { return this.work.run(async () => { await this.ready; return this.runs.list(); }); }
  async get(id: string): Promise<ExperimentRun> {
    return this.work.run(async () => { await this.ready; const result = await this.runs.get(identifier(id)); if (!result) throw new AgentProfileError("experiment_missing"); return result; });
  }
  async start(value: unknown, id = randomUUID()): Promise<{ id: string; completion: Promise<ExperimentRun> }> {
    return this.work.run(async () => {
      await this.ready; identifier(id);
      const plan = validatePlan(value);
      if (await this.runs.get(id)) throw new AgentProfileError("experiment_id_conflict");
      const dataset = await this.datasets.get(plan.datasetDigest);
      if (!dataset) throw new AgentProfileError("experiment_dataset_missing");
      const snapshots = await Promise.all(plan.variants.map(variant => this.ctx.agentProfiles.get(variant.snapshotDigest)));
      const executors = snapshots.map(snapshot => {
        const matches = [...this.executors.entries()].filter(([id, value]) => id !== "default" && value.supports?.(snapshot));
        if (matches.length > 1) throw new AgentProfileError("experiment_executor_ambiguous");
        if (snapshot.candidate && matches[0]?.[0] !== "candidate-sandbox") throw new AgentProfileError("experiment_candidate_requires_sandbox");
        const executor = matches[0]?.[1].executor ?? this.executors.get("default")?.executor;
        if (!executor) throw new AgentProfileError("experiment_executor_unavailable"); return { id: matches[0]?.[0] ?? "default", executor };
      });
      const controller = new AbortController();
      const run: ExperimentRun = freezeJson({ schemaVersion: 1, id, instanceId: this.instanceId, owner: (await this.ownership).owner, plan, status: "running", startedAt: new Date().toISOString(), results: [], ...summarize(plan, []) });
      await this.runs.create(id, run, false);
      const completion = this.work.run(async () => {
        let current = run;
        try {
          for (let repetition = 0; repetition < plan.repetitions; repetition++) {
            for (const testCase of dataset.cases) {
              for (let index = 0; index < plan.variants.length; index++) {
                controller.signal.throwIfAborted();
                const variant = plan.variants[index]!;
                const key = `${repetition}.${testCase.id}.${variant.label}`;
                const result = await executors[index]!.executor.execute({ snapshot: snapshots[index]!, testCase, directory: join(this.directory, id, key), timeoutMs: plan.timeoutMs, maxSteps: plan.maxSteps }, controller.signal);
                const passed = result.status === "completed" && (testCase.assertion.kind === "exact" ? result.output === testCase.assertion.expected : testCase.assertion.kind === "contains" ? result.output.includes(testCase.assertion.expected) : result.assertionPassed === true);
                const results = [...current.results, { ...result, key, label: variant.label, snapshotDigest: variant.snapshotDigest, caseId: testCase.id, repetition, passed }];
                current = await this.runs.update(id, prior => ({ ...prior, results, ...summarize(plan, results) }));
              }
            }
          }
          controller.signal.throwIfAborted();
          current = await this.runs.update(id, prior => ({ ...prior, status: "completed", endedAt: new Date().toISOString() }));
        } catch (error) {
          current = await this.runs.update(id, prior => ({ ...prior, status: controller.signal.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error), endedAt: new Date().toISOString() }));
        }
        return current;
      }).finally(() => { this.active.delete(id); });
      this.active.set(id, { controller, completion, executorIds: new Set(executors.map(item => item.id)) });
      void completion.catch(() => {});
      return { id, completion };
    });
  }
  async cancel(id: string): Promise<ExperimentRun> {
    this.work.assertAttached();
    const active = this.active.get(identifier(id));
    if (!active) return this.get(id);
    active.controller.abort(new Error("experiment_cancelled"));
    return active.completion;
  }
}
declare module "@deepseek-ai/cordis" { interface Context { experiments: Experiments } }
export default Experiments;
