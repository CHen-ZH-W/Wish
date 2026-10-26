import { randomUUID } from "node:crypto";
import { captureWorkspaceSnapshot, canonicalWorkspaceRoot } from "./snapshot.js";
import type { Development, DevelopmentChange, DevelopmentChangeRequest, DevelopmentProject, DevelopmentReport, DevelopmentSpec, DevelopmentStartRequest, DevelopmentStore, DevelopmentVerification } from "./types.js";
import { bytesDigest, digest, identifier, requireDevelopment, text, timestamp, validateProject, validateSpec, validateWorkspaceSnapshot } from "./validation.js";

const unsettled = (start: DevelopmentStartRequest): boolean => ["dispatching", "running"].includes(start.status);
const active = (project: DevelopmentProject): DevelopmentChange | undefined => project.changes.find(change => change.id === project.activeChangeId);
export class DevelopmentRuntime implements Development {
  private tail = Promise.resolve();
  private closed = false;
  constructor(private readonly store: DevelopmentStore, private readonly now: () => Date = () => new Date()) {}
  async list() { await this.tail; this.assertOpen(); return this.store.list(); }
  async get(projectId: string) { await this.tail; this.assertOpen(); return this.store.get(identifier(projectId)); }
  async forSession(sessionId: string) { identifier(sessionId); return (await this.list()).find(project => project.sessionIds.includes(sessionId)); }
  open(input: Parameters<Development["open"]>[0]): Promise<DevelopmentProject> {
    return this.serial(async () => {
      const sessionId = identifier(input.sessionId), rawWish = text(input.rawWish), root = await canonicalWorkspaceRoot(input.workspaceRoot);
      const projects = await this.store.list();
      const originFingerprint = digest({ sessionId, workspaceRoot: root, rawWish, title: input.title ?? null, projectId: input.projectId ?? null });
      if (input.requestId !== undefined) {
        identifier(input.requestId);
        const prior = projects.find(project => project.changes.some(change => change.originRequestId === input.requestId));
        if (prior) { requireDevelopment(prior.changes.find(change => change.originRequestId === input.requestId)?.originFingerprint === originFingerprint, "development_open_idempotency_conflict"); return prior; }
      }
      const attached = projects.find(project => project.sessionIds.includes(sessionId));
      requireDevelopment(!attached || attached.workspaceRoot === root, "development_session_workspace_conflict");
      let project = input.projectId ? await this.store.get(identifier(input.projectId)) : projects.find(project => project.workspaceRoot === root);
      if (input.projectId) requireDevelopment(project, "development_project_missing");
      requireDevelopment(!project || project.workspaceRoot === root, "development_workspace_conflict");
      requireDevelopment(!attached || !project || attached.id === project.id, "development_session_project_conflict");
      if (project) {
        if (input.expectedRevision !== undefined) requireDevelopment(project.revision === input.expectedRevision, "development_conflict");
        const current = active(project);
        if (current) { requireDevelopment(current.sessionId === sessionId, "development_change_owned_by_other_session"); requireDevelopment(current.rawWish === rawWish, "development_active_change_exists", "Revise the active change before opening another wish"); return project; }
      }
      const at = this.at(), change: DevelopmentChange = { id: randomUUID(), sessionId, rawWish, ...(input.requestId === undefined ? {} : { originRequestId: input.requestId, originFingerprint }), wishUpdates: [], specs: [], phase: "exploring", gate: "confirmation", executionEpoch: 0, confirmations: [], starts: [], verifications: [], reports: [], createdAt: at, updatedAt: at };
      const previous = project?.revision ?? 0;
      project = project ? { ...project, sessionIds: [...new Set([...project.sessionIds, sessionId])], revision: previous + 1, changes: [...project.changes, change], activeChangeId: change.id, updatedAt: at }
        : { schemaVersion: 1, id: randomUUID(), workspaceRoot: root, title: input.title === undefined ? rawWish.slice(0, 120) : text(input.title, 1000), sessionIds: [sessionId], revision: 1, changes: [change], activeChangeId: change.id, createdAt: at, updatedAt: at };
      return this.save(project, previous);
    });
  }
  propose(input: Parameters<Development["propose"]>[0]) {
    return this.edit(input, async (project, change) => {
      this.requireIdle(change); requireDevelopment(change.phase !== "accepted", "development_change_accepted");
      const specInput = validateSpec(input.spec), code = await captureWorkspaceSnapshot(project.workspaceRoot);
      const spec: DevelopmentSpec = { ...specInput, code, version: change.specs.length + 1, digest: digest({ ...specInput, code }), createdAt: this.at() };
      return { ...change, specs: [...change.specs, spec], phase: "exploring", gate: "confirmation", executionEpoch: change.executionEpoch + 1 };
    });
  }
  confirm(input: Parameters<Development["confirm"]>[0]) {
    return this.edit(input, async (project, change) => {
      this.requireIdle(change); requireDevelopment(change.phase !== "accepted", "development_change_accepted");
      const spec = change.specs.at(-1); requireDevelopment(spec && spec.version === input.specVersion && spec.digest === input.specDigest, "development_stale_spec");
      requireDevelopment(spec.questions.length === 0, "development_unresolved_questions");
      const code = await captureWorkspaceSnapshot(project.workspaceRoot), executionEpoch = change.executionEpoch + 1;
      const resuming = change.confirmations.some(confirmation => confirmation.specVersion === spec.version && confirmation.specDigest === spec.digest) && ["paused", "interrupted", "verifying", "review"].includes(change.phase);
      requireDevelopment(resuming || code.digest === spec.code.digest, "development_proposal_code_changed", "Workspace changed since the proposal; investigate and propose the current source before confirming");
      requireDevelopment(resuming || change.gate === "confirmation", "development_proposal_missing", "Requirements changed; propose the current scope before confirming");
      if (input.planApproval !== undefined) {
        const approval = input.planApproval; identifier(approval.sessionId); identifier(approval.reviewId);
        const artifacts = [...spec.artifacts ?? [], { kind: "wish-spec", id: change.id, version: spec.version, digest: spec.digest }];
        requireDevelopment(approval.sessionId === change.sessionId && approval.markdown === spec.planMarkdown && bytesDigest(approval.markdown) === approval.digest && Number.isSafeInteger(approval.stateVersion) && approval.stateVersion > 0 && Number.isSafeInteger(approval.documentVersion) && approval.documentVersion > 0 && digest(approval.artifacts ?? []) === digest(artifacts), "development_plan_approval_conflict");
      }
      const content = { id: randomUUID(), executionEpoch, code, actor: text(input.actor, 1000), confirmedAt: this.at(), ...(input.planApproval === undefined ? {} : { planApproval: input.planApproval }) };
      const confirmation = { ...content, specVersion: spec.version, specDigest: spec.digest, digest: digest({ ...content, spec }) };
      return { ...change, confirmations: [...change.confirmations, confirmation], executionEpoch, phase: "ready", gate: "execution" };
    });
  }
  reserveStart(input: Parameters<Development["reserveStart"]>[0]) {
    return this.serial(async () => {
      const project = await this.requireProject(input.projectId), requestId = identifier(input.requestId);
      const fingerprint = digest({ projectId: input.projectId, changeId: input.changeId, sessionId: input.sessionId, confirmationDigest: input.confirmationDigest });
      const prior = project.changes.flatMap(change => change.starts).find(start => start.id === requestId);
      if (prior) { requireDevelopment(prior.fingerprint === fingerprint, "development_start_idempotency_conflict"); return project; }
      const change = this.requireChange(project, input); requireDevelopment(change.phase === "ready", "development_not_ready"); this.requireIdle(change);
      const confirmation = change.confirmations.at(-1), spec = change.specs.at(-1);
      requireDevelopment(confirmation && confirmation.digest === input.confirmationDigest && confirmation.executionEpoch === change.executionEpoch && spec?.digest === confirmation.specDigest, "development_stale_confirmation");
      requireDevelopment(!change.starts.some(start => start.confirmationDigest === confirmation.digest), "development_confirmation_already_started");
      const code = await captureWorkspaceSnapshot(project.workspaceRoot); requireDevelopment(code.digest === confirmation.code.digest, "development_code_changed", "Workspace changed since confirmation; confirm the current version again");
      const start: DevelopmentStartRequest = { id: requestId, fingerprint, sessionId: input.sessionId, runId: randomUUID(), confirmationDigest: confirmation.digest, specVersion: confirmation.specVersion, executionEpoch: change.executionEpoch, status: "dispatching", createdAt: this.at() };
      return this.replace(project, { ...change, starts: [...change.starts, start], phase: "running", gate: "none" });
    });
  }
  bindStart(input: Parameters<Development["bindStart"]>[0]) {
    return this.serial(async () => {
      const project = await this.requireProject(input.projectId), change = project.changes.find(change => change.starts.some(start => start.id === input.requestId));
      const start = change?.starts.find(start => start.id === input.requestId); requireDevelopment(change && start && start.runId === input.runId, "development_start_binding_conflict");
      if (start.status === "running") return project;
      requireDevelopment(start.status === "dispatching" && change.phase === "running" && start.executionEpoch === change.executionEpoch, "development_start_invalidated");
      return this.replace(project, { ...change, starts: change.starts.map(item => item === start ? { ...item, status: "running" } : item) });
    });
  }
  finishRun(input: Parameters<Development["finishRun"]>[0]) {
    return this.serial(async () => {
      const project = await this.requireProject(input.projectId), change = project.changes.find(change => change.starts.some(start => start.runId === input.runId));
      const start = change?.starts.find(start => start.runId === input.runId); requireDevelopment(change && start && ["completed", "failed", "aborted", "interrupted"].includes(input.status), "development_run_missing");
      if (!unsettled(start)) { requireDevelopment(start.status === input.status, "development_run_terminal_conflict"); return project; }
      const starts = change.starts.map(item => item === start ? { ...item, status: input.status, endedAt: this.at() } : item);
      const phase = change.phase === "stopping" ? "stopping" as const : input.status === "interrupted" ? "interrupted" as const : input.status === "completed" && change.phase === "review" ? "review" as const : "verifying" as const;
      return this.replace(project, { ...change, starts, phase, gate: phase === "interrupted" ? "recovery" : phase === "review" ? "user-acceptance" : "verification" });
    });
  }
  requestPause(input: DevelopmentChangeRequest) {
    return this.edit(input, async (_project, change) => {
      requireDevelopment(change.phase !== "accepted", "development_change_accepted");
      if (change.phase === "stopping" || change.phase === "paused") return change;
      const running = change.starts.some(unsettled);
      return { ...change, phase: running ? "stopping" : "paused", gate: "none", executionEpoch: change.executionEpoch + 1 };
    });
  }
  settlePause(input: Parameters<Development["settlePause"]>[0]) {
    return this.serial(async () => {
      const project = await this.requireProject(input.projectId), change = project.changes.find(change => change.id === input.changeId); requireDevelopment(change, "development_change_missing");
      if (change.phase === "paused") return project;
      requireDevelopment(change.phase === "stopping" && !change.starts.some(unsettled), "development_still_running");
      return this.replace(project, { ...change, phase: "paused", gate: "none" });
    });
  }
  revise(input: Parameters<Development["revise"]>[0]) {
    return this.edit(input, async (_project, change) => {
      this.requireIdle(change); requireDevelopment(change.phase !== "accepted", "development_change_accepted");
      return { ...change, phase: "exploring", gate: "none", executionEpoch: change.executionEpoch + 1,
        wishUpdates: input.rawWish === undefined ? change.wishUpdates : [...change.wishUpdates, text(input.rawWish)] };
    });
  }
  recordVerification(input: Parameters<Development["recordVerification"]>[0]) {
    return this.edit(input, async (project, change) => {
      this.requireReceiptAdmission(change, input.receipt.runId); requireDevelopment(change.phase !== "accepted" && change.phase !== "interrupted", "development_verification_not_ready");
      const spec = change.specs.at(-1); requireDevelopment(spec, "development_spec_missing");
      const receipt = input.receipt; identifier(receipt.id); validateWorkspaceSnapshot(receipt.code);
      requireDevelopment(receipt.code.workspaceRoot === project.workspaceRoot, "development_workspace_conflict");
      requireDevelopment(typeof receipt.output === "string" && Buffer.byteLength(receipt.output, "utf8") <= 16_384 && bytesDigest(receipt.output) === receipt.outputDigest, "development_output_digest_mismatch");
      requireDevelopment(Array.isArray(receipt.criterionIds) && receipt.criterionIds.length > 0 && new Set(receipt.criterionIds).size === receipt.criterionIds.length && receipt.criterionIds.every(id => spec.criteria.some(criterion => criterion.id === id && criterion.kind === "technical")), "development_unknown_criterion");
      requireDevelopment(timestamp(receipt.startedAt) <= timestamp(receipt.endedAt), "development_invalid_time");
      if (receipt.runId !== undefined) requireDevelopment(change.starts.some(start => start.runId === receipt.runId && start.specVersion === spec.version && start.executionEpoch === change.executionEpoch), "development_receipt_run_conflict");
      if (receipt.toolCallId !== undefined) identifier(receipt.toolCallId);
      const current = await captureWorkspaceSnapshot(project.workspaceRoot); requireDevelopment(current.digest === receipt.code.digest, "development_evidence_code_changed");
      const content = { ...receipt, specVersion: spec.version, specDigest: spec.digest, executionEpoch: change.executionEpoch };
      const verification: DevelopmentVerification = { ...content, digest: digest(content) };
      const existing = change.verifications.find(item => item.id === receipt.id);
      if (existing) { requireDevelopment(existing.digest === verification.digest, "development_evidence_idempotency_conflict"); return change; }
      return { ...change, verifications: [...change.verifications, verification], phase: change.starts.some(unsettled) ? "running" : "verifying", gate: "verification" };
    });
  }
  report(input: Parameters<Development["report"]>[0]) {
    return this.edit(input, async (project, change) => {
      this.requireReceiptAdmission(change, input.runId); requireDevelopment(change.phase !== "accepted" && change.phase !== "interrupted", "development_report_not_ready");
      const spec = change.specs.at(-1); requireDevelopment(spec, "development_spec_missing");
      const code = await captureWorkspaceSnapshot(project.workspaceRoot);
      const evidence = change.verifications.filter(receipt => receipt.specDigest === spec.digest && receipt.specVersion === spec.version && receipt.executionEpoch === change.executionEpoch && receipt.code.digest === code.digest);
      const criteria = spec.criteria.map(criterion => {
        const matches = evidence.filter(receipt => receipt.criterionIds.includes(criterion.id)), latest = matches.at(-1);
        return { criterionId: criterion.id, status: criterion.kind === "user" ? "waiting-user" as const : !latest ? "unverified" as const : latest.exitCode === 0 && !latest.timedOut ? "verified" as const : "failed" as const, evidenceIds: matches.map(item => item.id) };
      });
      const content = { id: randomUUID(), specVersion: spec.version, specDigest: spec.digest, executionEpoch: change.executionEpoch, code, evidenceDigests: evidence.map(item => item.digest), criteria, summary: text(input.summary), limitations: input.limitations ?? [], nextSteps: input.nextSteps ?? [], createdAt: this.at() };
      const report: DevelopmentReport = { ...content, digest: digest(content) };
      return { ...change, reports: [...change.reports, report], phase: "review", gate: "user-acceptance" };
    });
  }
  accept(input: Parameters<Development["accept"]>[0]) {
    return this.edit(input, async (project, change) => {
      this.requireIdle(change); requireDevelopment(change.phase === "review", "development_report_not_ready");
      const report = change.reports.at(-1), spec = change.specs.at(-1);
      requireDevelopment(report && report.id === input.reportId && report.digest === input.reportDigest && report.specDigest === spec?.digest && report.specVersion === spec.version && report.executionEpoch === change.executionEpoch, "development_stale_report");
      requireDevelopment(report.criteria.every(result => result.status === "verified" || result.status === "waiting-user"), "development_verification_incomplete");
      const code = await captureWorkspaceSnapshot(project.workspaceRoot); requireDevelopment(code.digest === report.code.digest, "development_report_code_changed");
      return { ...change, phase: "accepted", gate: "none", reports: change.reports.map(item => item === report ? { ...item, acceptedBy: text(input.actor, 1000), acceptedAt: this.at() } : item) };
    });
  }
  detachSession(sessionId: string): Promise<void> {
    return this.serial(async () => {
      identifier(sessionId);
      for (const project of await this.store.list()) {
        if (!project.sessionIds.includes(sessionId)) continue;
        const change = active(project);
        requireDevelopment(!change || change.sessionId !== sessionId || !change.starts.some(unsettled), "development_still_running");
        const { activeChangeId: _active, ...rest } = project;
        await this.save({ ...rest, ...(change?.sessionId === sessionId ? {} : project.activeChangeId ? { activeChangeId: project.activeChangeId } : {}), sessionIds: project.sessionIds.filter(id => id !== sessionId), revision: project.revision + 1, updatedAt: this.at() }, project.revision);
      }
    });
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      for (const project of await this.store.list()) {
        let changed = false;
        const changes = project.changes.map(change => {
          if (!change.starts.some(unsettled)) return change;
          changed = true;
          return { ...change, phase: "interrupted" as const, gate: "recovery" as const, executionEpoch: change.executionEpoch + 1, updatedAt: this.at(), starts: change.starts.map(start => unsettled(start) ? { ...start, status: "interrupted" as const, endedAt: this.at() } : start) };
        });
        if (changed) await this.save({ ...project, changes, revision: project.revision + 1, updatedAt: this.at() }, project.revision);
      }
    });
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.tail; await this.store.close(); }
  private requireIdle(change: DevelopmentChange): void { requireDevelopment(!change.starts.some(unsettled) && change.phase !== "stopping" && change.phase !== "running", "development_still_running"); }
  private requireReceiptAdmission(change: DevelopmentChange, runId: string | undefined): void {
    requireDevelopment(change.phase !== "stopping", "development_still_running");
    if (!change.starts.some(unsettled)) { this.requireIdle(change); return; }
    requireDevelopment(runId !== undefined && change.starts.some(start => start.runId === runId && unsettled(start) && start.executionEpoch === change.executionEpoch && start.specVersion === change.specs.at(-1)?.version), "development_receipt_run_conflict");
  }
  private async requireProject(id: string): Promise<DevelopmentProject> { const project = await this.store.get(identifier(id)); requireDevelopment(project, "development_project_missing"); return project; }
  private requireChange(project: DevelopmentProject, input: DevelopmentChangeRequest): DevelopmentChange {
    requireDevelopment(project.revision === input.expectedRevision, "development_conflict"); identifier(input.sessionId); identifier(input.changeId);
    const change = active(project); requireDevelopment(change && change.id === input.changeId, "development_change_missing");
    requireDevelopment(project.sessionIds.includes(input.sessionId) && change.sessionId === input.sessionId, "development_change_owned_by_other_session"); return change;
  }
  private edit(input: DevelopmentChangeRequest, mutate: (project: DevelopmentProject, change: DevelopmentChange) => Promise<DevelopmentChange>): Promise<DevelopmentProject> {
    return this.serial(async () => { const project = await this.requireProject(input.projectId), change = this.requireChange(project, input), next = await mutate(project, change); return next === change ? project : this.replace(project, next); });
  }
  private replace(project: DevelopmentProject, change: DevelopmentChange): Promise<DevelopmentProject> {
    const { activeChangeId, ...rest } = project, at = this.at();
    return this.save({ ...rest, ...(change.phase === "accepted" ? {} : activeChangeId === undefined ? {} : { activeChangeId }), revision: project.revision + 1, updatedAt: at, changes: project.changes.map(item => item.id === change.id ? { ...change, updatedAt: at } : item) }, project.revision);
  }
  private async save(project: DevelopmentProject, revision: number): Promise<DevelopmentProject> { const stable = validateProject(project); await this.store.put(stable, revision); return stable; }
  private at(): string { return this.now().toISOString(); }
  private assertOpen(): void { requireDevelopment(!this.closed, "development_closed"); }
  private serial<T>(work: () => Promise<T>): Promise<T> { this.assertOpen(); const result = this.tail.then(work); this.tail = result.then(() => {}, () => {}); return result; }
}
