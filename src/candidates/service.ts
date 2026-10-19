import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { overlayHash, serializeDeploymentOverlay, type DeploymentOverlayEntry } from "../boot/plugin-control/deployment-overlay.js";
import { ProfileRecordStore } from "../agent-profiles/store.js";
import { captureComposition, verifyCode } from "../agent-profiles/composition.js";
import { digest, identifier, record, validateDefinition, validateSnapshot } from "../agent-profiles/validation.js";
import { createProcessOwner, ownerIsDead } from "../agent-profiles/process-owner.js";
import type { AgentProfileSnapshot } from "../agent-profiles/types.js";
import type { ExperimentRun } from "../experiments/types.js";
import { CandidateArtifacts } from "./artifacts.js";
import { source, artifact, validation, evaluation, promotion, review, sha, target, text, fail, candidateChecks } from "./validation.js";
import type { CandidateEvaluation, CandidateEvaluationResult, CandidatePromotion, CandidateReview, CandidateRunner, CandidateSource, CandidateValidation } from "./types.js";
import { checkQualityGate } from "../plugin-admission/quality.js";
import { canonical } from "../agent-profiles/validation.js";

export interface Config { readonly directory?: string }
export const Config: s<Config> = s.object({ directory: s.string() });

/** Owns candidate provenance and evidence. Deployment remains Root's transaction. */
export class Candidates extends Service {
  static readonly inject = ["storageBackend", "agentProfiles", "experiments", "launch"];
  static readonly Config = Config;
  private readonly sources: ProfileRecordStore<CandidateSource>;
  private readonly versions: ProfileRecordStore<string>;
  private readonly validations: ProfileRecordStore<CandidateValidation>;
  private readonly evaluations: ProfileRecordStore<CandidateEvaluation>;
  private readonly promotions: ProfileRecordStore<CandidatePromotion>;
  private readonly work: PluginWorkOwner;
  private readonly artifacts: CandidateArtifacts;
  private readonly ownership = createProcessOwner();
  private readonly retirement = new AbortController();
  private readonly activePromotions = new Set<string>();
  private runner: CandidateRunner | undefined;
  private readonly directory: string;
  readonly ready: Promise<void>;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "candidates");
    this.directory = resolve(config.directory ?? join(ctx.launch.homeDirectory, ".wish", "candidates"));
    this.artifacts = new CandidateArtifacts(join(this.directory, "artifacts"));
    ctx.on("hmr/reload-prepare", (batch, _signal, next) => {
      for (const { filename } of batch.values()) {
        const path = resolve(filename.startsWith("file:") ? fileURLToPath(filename) : filename);
        if (path.startsWith(`${this.artifacts.directory}/`)) fail("candidate_artifact_requires_new_version");
      }
      return next();
    }, { global: true, prepend: true });
    const lease = ctx.storageBackend.acquire(ctx.storageBackend.id, { kv: { list: true } });
    this.sources = new ProfileRecordStore(lease, lease.id, "candidates/sources/v1", source);
    this.versions = new ProfileRecordStore(lease, lease.id, "candidates/versions/v1", sha);
    this.validations = new ProfileRecordStore(lease, lease.id, "candidates/validations/v1", validation);
    this.evaluations = new ProfileRecordStore(lease, lease.id, "candidates/evaluations/v1", evaluation);
    this.promotions = new ProfileRecordStore(lease, lease.id, "candidates/promotions/v1", promotion);
    this.work = new PluginWorkOwner(ctx, { code: "candidates", codeReload: true,
      beforeDrain: () => this.retirement.abort(new Error("candidate_owner_closed")),
      close: async () => { (await this.ownership).release(); lease.release(); } });
    this.ready = Promise.resolve().then(async () => {
      for (const item of await this.validations.list()) if (item.status === "running" && await ownerIsDead(item.owner)) await this.validations.update(item.id, previous => ({ ...previous, status: "interrupted", endedAt: new Date().toISOString() }));
      for (const item of await this.promotions.list()) if (["applying", "rolling-back"].includes(item.status) && await ownerIsDead(item.owner)) await this.promotions.update(item.id, previous => ({ ...previous, status: "interrupted", endedAt: new Date().toISOString() }));
    });
    void this.ready.catch(() => {});
    ctx.effect(async () => { await this.ready; return () => {}; }, "candidate recovery without replay");
  }
  get artifactDirectory(): string { return this.artifacts.directory; }
  artifactPath(key: string): string { return this.artifacts.path(key); }
  registerRunner(runner: CandidateRunner): () => void {
    this.work.assertAttached(); if (this.runner) fail("candidate_runner_duplicate"); this.runner = runner;
    return () => { if (this.runner === runner) this.runner = undefined; };
  }
  async submit(value: unknown): Promise<{ digest: string; source: CandidateSource }> {
    return this.work.run(async () => {
      await this.ready; const candidate = source(value), key = digest(candidate);
      await this.versions.create(`${candidate.id}@${candidate.version}`, key);
      await this.sources.create(key, candidate); return { digest: key, source: candidate };
    });
  }
  async list(): Promise<readonly { digest: string; source: CandidateSource }[]> {
    return this.work.run(async () => { await this.ready; return (await this.sources.list()).map(source => ({ digest: digest(source), source })); });
  }
  async history(): Promise<{ validations: readonly CandidateValidation[]; evaluations: readonly CandidateEvaluation[]; promotions: readonly CandidatePromotion[] }> {
    return this.work.run(async () => { await this.ready; return { validations: await this.validations.list(), evaluations: await this.evaluations.list(), promotions: await this.promotions.list() }; });
  }
  async validate(value: unknown, signal?: AbortSignal): Promise<CandidateValidation> {
    return this.work.run(async () => {
      await this.ready; const input = record(value), candidateDigest = sha(input.candidateDigest), base = await this.ctx.agentProfiles.get(sha(input.baseSnapshotDigest));
      if (base.candidate) fail("candidate_base_must_be_stable");
      if (!["read-only", "workspace-write"].includes(base.definition.permissionProfile)) fail("candidate_permission_requires_confinement");
      const candidate = await this.getSource(candidateDigest), to = target(input.target), profile = validateDefinition(input.profile);
      if (profile.model !== base.definition.model || profile.permissionProfile !== base.definition.permissionProfile || profile.memory !== base.definition.memory) fail("candidate_profile_model_or_authority_changed");
      await verifyCode(base.code); const runner = this.requireRunner();
      const id = randomUUID();
      const entry: CandidateValidation = { schemaVersion: 1, id, candidateDigest, owner: (await this.ownership).owner, status: "running", startedAt: new Date().toISOString(), baseSnapshotDigest: base.digest, target: to, profile };
      await this.validations.create(id, entry, false);
      const combined = AbortSignal.any([this.retirement.signal, ...(signal ? [signal] : [])]);
      try {
        const { candidateAdmission, checkCompiledCandidate } = await import("../plugin-admission/candidate.js");
        const admission = candidateAdmission(candidate, entry, base);
        const built = await runner.build(candidate, join(this.directory, "jobs", id, "build"), combined);
        checkCompiledCandidate(candidate, admission, built.files);
        const body = { schemaVersion: 1 as const, sourceDigest: candidateDigest, files: { ...built.files, "admission.json": canonical(admission) }, hostCode: base.code, imports: built.imports };
        const output = artifact({ ...body, digest: digest(body) }); await this.artifacts.put(output);
        const result = await runner.check({ source: candidate, artifact: output, base, validation: entry, directory: join(this.directory, "jobs", id, "check") }, combined);
        const snapshot = validateSnapshot(result.snapshot), checks = candidateChecks(result.checks);
        if (snapshot.candidate?.artifactDigest !== output.digest || snapshot.candidate.sourceDigest !== candidateDigest || digest(snapshot.definition) !== digest(profile)) fail("candidate_snapshot_identity_mismatch");
        await this.ctx.agentProfiles.importSnapshot(snapshot);
        return await this.validations.update(id, previous => ({ ...previous, status: "passed", checks, admissionDigest: admission.digest, artifactDigest: output.digest, snapshotDigest: snapshot.digest, endedAt: new Date().toISOString() }));
      } catch (error) {
        return await this.validations.update(id, previous => ({ ...previous, status: combined.aborted ? "cancelled" : "failed", endedAt: new Date().toISOString(), error: diagnostic(error) }));
      }
    });
  }
  async verifySnapshot(snapshot: AgentProfileSnapshot): Promise<void> {
    return this.work.run(async () => {
      if (!snapshot.candidate) fail("candidate_snapshot_required");
      const output = await this.artifacts.get(snapshot.candidate.artifactDigest);
      if (output.sourceDigest !== snapshot.candidate.sourceDigest || !snapshot.plugins.some(plugin => plugin.enabled && plugin.module === pathToFileURL(join(this.artifacts.path(output.digest), "plugin.mjs")).href)) fail("candidate_snapshot_identity_mismatch");
      const passed = (await this.validations.list()).find(item => item.status === "passed" && item.snapshotDigest === snapshot.digest && item.artifactDigest === output.digest);
      if (!passed) fail("candidate_validation_missing");
      await this.getValidation(passed.id);
    });
  }
  async evaluate(value: unknown, signal?: AbortSignal): Promise<CandidateEvaluationResult> {
    return this.work.run(async () => {
      await this.ready; const input = record(value), checked = await this.getValidation(text(input.validationId));
      const id = randomUUID(), experimentId = randomUUID();
      const evidence = evaluation({ schemaVersion: 1, id, validationId: checked.id, experimentId, datasetDigest: sha(input.datasetDigest), repetitions: input.repetitions ?? 1,
        gate: input.gate ?? { minimumSuccessRate: 1, maximumSuccessRateRegression: 0 } });
      await this.evaluations.create(id, evidence, false);
      const job = await this.ctx.experiments.start({ datasetDigest: evidence.datasetDigest, variants: [{ label: "baseline", snapshotDigest: checked.baseSnapshotDigest }, { label: "candidate", snapshotDigest: checked.snapshotDigest }], baseline: "baseline", repetitions: evidence.repetitions, timeoutMs: input.timeoutMs ?? 120_000, maxSteps: input.maxSteps ?? 30 }, experimentId);
      const combined = AbortSignal.any([this.retirement.signal, ...(signal ? [signal] : [])]);
      const cancel = () => { void this.ctx.experiments.cancel(job.id).catch(() => {}); };
      combined.addEventListener("abort", cancel, { once: true }); if (combined.aborted) cancel();
      try { return { evaluation: evidence, experiment: await job.completion }; }
      finally { combined.removeEventListener("abort", cancel); }
    });
  }
  async prepareReview(value: unknown): Promise<CandidateReview> {
    return this.work.run(async () => {
      await this.ready; const input = record(value), checked = await this.getValidation(text(input.validationId)), evidence = await this.getEvaluation(text(input.evaluationId));
      if (evidence.validationId !== checked.id) fail("candidate_evaluation_mismatch");
      const run = await this.ctx.experiments.get(evidence.experimentId); await this.checkEvidence(checked, evidence, run);
      const candidate = await this.getSource(checked.candidateDigest);
      const base = await this.ctx.agentProfiles.get(checked.baseSnapshotDigest);
      await verifyCode(base.code);
      if (digest(captureComposition(this.ctx).plugins) !== digest(base.plugins)) fail("candidate_deployment_changed_since_validation");
      const control = this.ctx.root.get("managedPlugins"); if (!control) fail("candidate_managed_host_required");
      const deployment = await control.deploymentSnapshot(checked.target.entryId);
      if (deployment.previousEntry) {
        // Only replace slots owned by this pipeline. Private state participates
        // in the existing Root transaction and is validated during activation.
        if (!deployment.entries.some(item => item.entry.id === checked.target.entryId)) fail("candidate_target_not_candidate_owned");
        const prior = record(deployment.previousEntry.manifest);
        if (prior.id !== candidate.manifest.id || record(prior.state).mode !== candidate.manifest.state.mode) fail("candidate_previous_identity_incompatible");
      }
      const body = { schemaVersion: 1 as const, admissionDigest: checked.admissionDigest!, validationId: checked.id, evaluationId: evidence.id, artifactDigest: checked.artifactDigest!, candidateDigest: checked.candidateDigest, snapshotDigest: checked.snapshotDigest!,
        evidenceDigest: digest({ validation: checked, evaluation: evidence, experiment: run }), deploymentDigest: deployment.deploymentDigest, managementRevision: deployment.revision, overlayDigest: deployment.overlayDigest,
        previousOverlay: deployment.entries, target: checked.target, previousEntry: deployment.previousEntry, reviewer: text(input.reviewer, 128), reason: text(input.reason, 4000), trust: "trusted-in-process" as const };
      return review({ ...body, digest: digest(body) });
    });
  }
  /** A human/Host submits the exact review digest; model tools expose no promotion method. */
  async promote(value: unknown, approvedReviewDigest: string, signal?: AbortSignal): Promise<CandidatePromotion> {
    return this.work.run(async () => {
      await this.ready; const approved = review(value);
      if (sha(approvedReviewDigest) !== approved.digest) fail("candidate_explicit_approval_required");
      const refreshed = await this.prepareReview(approved);
      if (refreshed.digest !== approved.digest) fail("candidate_review_stale");
      const candidate = await this.getSource(approved.candidateDigest), output = await this.artifacts.get(approved.artifactDigest);
      const entries = this.deployedEntries(approved, candidate);
      const id = randomUUID();
      await this.promotions.create(id, { schemaVersion: 1, id, review: approved, status: "applying", owner: (await this.ownership).owner, startedAt: new Date().toISOString() }, false);
      const control = this.ctx.root.get("managedPlugins")!;
      this.activePromotions.add(id);
      try {
        let appliedOverlayDigest: string;
        try { appliedOverlayDigest = await control.applyDeploymentOverlay({ requestId: `candidate:${id}`, revision: approved.managementRevision, deploymentDigest: approved.deploymentDigest, overlayDigest: approved.overlayDigest, entries,
          verifyArtifact: async () => { await this.artifacts.get(approved.artifactDigest); } }, signal); }
        catch (error) { return await this.promotions.update(id, previous => ({ ...previous, status: control.snapshot().status === "recovery-required" ? "recovery-required" : "rejected", endedAt: new Date().toISOString(), error: diagnostic(error) })); }
        // If this save fails, retain applying. Never label a committed runtime
        // rejected merely because recording the result failed; reconcile reads
        // the Root receipt and complete overlay before deciding its outcome.
        return await this.promotions.update(id, previous => ({ ...previous, status: "active", appliedOverlayDigest, endedAt: new Date().toISOString() }));
      } finally { this.activePromotions.delete(id); }
    });
  }
  async rollback(id: string, approvedReviewDigest: string, signal?: AbortSignal): Promise<CandidatePromotion> {
    return this.work.run(async () => {
      await this.ready; const current = await this.promotions.get(identifier(id));
      if (!current || current.status !== "active" || current.review.digest !== sha(approvedReviewDigest)) fail("candidate_rollback_approval_required");
      const control = this.ctx.root.get("managedPlugins"); if (!control) fail("candidate_managed_host_required");
      const deployment = await control.deploymentSnapshot(current.review.target.entryId);
      if (deployment.overlayDigest !== current.appliedOverlayDigest) fail("candidate_rollback_deployment_changed");
      const checkedBaseDigest = (await this.getValidation(current.review.validationId, false)).baseSnapshotDigest;
      await verifyCode((await this.ctx.agentProfiles.get(checkedBaseDigest)).code);
      await this.promotions.update(id, previous => { if (previous.status !== "active") fail("candidate_promotion_changed"); return { ...previous, status: "rolling-back" }; });
      this.activePromotions.add(id);
      try {
        try { await control.applyDeploymentOverlay({ requestId: `candidate-rollback:${id}`, revision: deployment.revision, deploymentDigest: deployment.deploymentDigest, overlayDigest: deployment.overlayDigest, entries: current.review.previousOverlay, restorePreviousState: true,
          verifyArtifact: () => this.ctx.agentProfiles.get(checkedBaseDigest).then(base => verifyCode(base.code)) }, signal); }
        catch (error) { return await this.promotions.update(id, previous => ({ ...previous, status: control.snapshot().status === "recovery-required" ? "recovery-required" : "active", error: diagnostic(error), endedAt: new Date().toISOString() })); }
        return await this.promotions.update(id, previous => ({ ...previous, status: "rolled-back", endedAt: new Date().toISOString() }));
      } finally { this.activePromotions.delete(id); }
    });
  }
  /** Inspect durable receipts after a crash/save failure. Never executes code or
   * replays a deployment. Ambiguous/more recent deployments remain explicit. */
  async reconcile(id: string): Promise<CandidatePromotion> {
    for (;;) {
      // A configuration watcher may still be settling after the Root receipt.
      // Wait outside the work lease so replacing this service cannot deadlock
      // while draining a reconciliation that is itself waiting on that change.
      await this.ctx.root.get("pluginChanges")?.wait(this.retirement.signal);
      const reconciled = await this.work.run(async () => {
        await this.ready; const current = await this.promotions.get(identifier(id));
        if (!current) fail("candidate_promotion_missing");
        if (this.activePromotions.has(id)) fail("candidate_promotion_still_running");
        if (!["applying", "rolling-back", "interrupted", "recovery-required"].includes(current.status)) return current;
        const control = this.ctx.root.get("managedPlugins"); if (!control) fail("candidate_management_recovery_required");
        const before = control.snapshot();
        if (before.status === "working") return undefined;
        if (before.status === "recovery-required" || before.pending) fail("candidate_management_recovery_required");
        const deployment = await control.deploymentSnapshot(current.review.target.entryId);
        const previous = overlayHash(serializeDeploymentOverlay(current.review.previousOverlay));
        const expected = overlayHash(serializeDeploymentOverlay(this.deployedEntries(current.review, await this.getSource(current.review.candidateDigest))));
        const receipt = control.receipt(`configuration:candidate:${id}`), rolledBack = control.receipt(`configuration:candidate-rollback:${id}`);
        let status: CandidatePromotion["status"] | undefined;
        if (rolledBack?.status === "succeeded" && deployment.overlayDigest === previous) status = "rolled-back";
        else if (receipt?.status === "succeeded" && deployment.overlayDigest === expected && control.snapshot().inspection.entries.some(entry => entry.id.endsWith(`:${current.review.target.entryId}`) && entry.phase === "active")) {
          await this.artifacts.get(current.review.artifactDigest); status = "active";
        } else if (deployment.overlayDigest === current.review.overlayDigest && (!receipt || receipt.status === "rejected")) status = "rejected";
        // Overlay, source and artifact reads may yield to another accepted Root
        // change. Retry the observation after it settles; never replay a switch.
        const after = control.snapshot();
        if (after.status === "working" || after.revision !== before.revision) return undefined;
        if (after.status === "recovery-required" || after.pending) fail("candidate_management_recovery_required");
        if (!status) fail("candidate_reconciliation_ambiguous");
        return this.promotions.update(id, previous => ({ ...previous, status, ...(status === "active" ? { appliedOverlayDigest: expected } : {}), endedAt: new Date().toISOString() }));
      });
      if (reconciled) return reconciled;
    }
  }
  private deployedEntries(approved: CandidateReview, candidate: CandidateSource): readonly DeploymentOverlayEntry[] {
    const directory = this.artifacts.path(approved.artifactDigest);
    return [...approved.previousOverlay.filter(row => row.entry.id !== approved.target.entryId), { parentId: approved.target.parentId, entry: { id: approved.target.entryId, name: pathToFileURL(join(directory, "plugin.mjs")).href, config: candidate.config, management: { manifest: pathToFileURL(join(directory, "wish-plugin.json")).href } } }];
  }
  private requireRunner(): CandidateRunner { if (!this.runner) fail("candidate_runner_unavailable"); return this.runner; }
  private async getSource(key: string): Promise<CandidateSource> { const value = await this.sources.get(sha(key)); if (!value) fail("candidate_source_missing"); return value; }
  private async getValidation(id: string, requireAdmission = true): Promise<CandidateValidation> {
    const value = await this.validations.get(identifier(id)); if (!value || value.status !== "passed" || !value.artifactDigest || !value.snapshotDigest) fail("candidate_validation_not_passed");
    const output = await this.artifacts.get(value.artifactDigest);
    // Undoing an already approved deployment must remain possible after a policy
    // upgrade. This branch still verifies artifact bytes and the Root receipt.
    if (!requireAdmission) return value;
    if (!value.admissionDigest || !value.checks) fail("candidate_admission_missing");
    const { candidateAdmission } = await import("../plugin-admission/candidate.js");
    const expected = candidateAdmission(await this.getSource(value.candidateDigest), value, await this.ctx.agentProfiles.get(value.baseSnapshotDigest));
    if (expected.digest !== value.admissionDigest || output.files["admission.json"] !== canonical(expected)) fail("candidate_admission_changed");
    return value;
  }
  private async getEvaluation(id: string): Promise<CandidateEvaluation> { const value = await this.evaluations.get(identifier(id)); if (!value) fail("candidate_evaluation_missing"); return value; }
  private async checkEvidence(checked: CandidateValidation, evidence: CandidateEvaluation, run: ExperimentRun): Promise<void> {
    const variants = run.plan.variants;
    if (run.status !== "completed" || run.plan.datasetDigest !== evidence.datasetDigest || run.plan.repetitions !== evidence.repetitions || variants.length !== 2 ||
      variants.find(item => item.label === "baseline")?.snapshotDigest !== checked.baseSnapshotDigest || variants.find(item => item.label === "candidate")?.snapshotDigest !== checked.snapshotDigest || run.plan.baseline !== "baseline") fail("candidate_experiment_incomplete");
    const dataset = (await this.ctx.experiments.listDatasets()).find(item => item.digest === evidence.datasetDigest);
    if (!dataset || run.results.length !== dataset.dataset.cases.length * evidence.repetitions * 2 || run.results.some(item => item.status !== "completed" || item.attemptsComplete === false)) fail("candidate_experiment_incomplete");
    const candidate = run.metrics.candidate, baseline = run.metrics.baseline;
    if (!candidate || !baseline) fail("candidate_quality_gate_failed");
    checkQualityGate(evidence.gate, candidate, baseline);
    await this.verifySnapshot(await this.ctx.agentProfiles.get(checked.snapshotDigest!));
  }
}
function diagnostic(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 6000); }
declare module "@deepseek-ai/cordis" { interface Context { candidates: Candidates } }
export default Candidates;
