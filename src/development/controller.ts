import type { WishApplication, WishRunHandle } from "../apps/types.js";
import type { Plan, PlanState } from "../plan/types.js";
import type { Goal } from "../goal/types.js";
import type { SessionFeatureInputContext } from "../apps/session-features.js";
import type { Development, DevelopmentChange, DevelopmentChangeRequest, DevelopmentProject, DevelopmentSpecInput } from "./types.js";
import { DevelopmentError, requireDevelopment } from "./validation.js";
import { digest } from "./validation.js";
import { MemoryDevelopmentOperations, operationIdentity, type DevelopmentOperations } from "./operations.js";
import { captureWorkspaceSnapshot } from "./snapshot.js";
import { randomUUID } from "node:crypto";

interface ActiveExecution { readonly application: WishApplication; readonly handle: WishRunHandle; readonly projectId: string; readonly changeId: string; readonly mode: "explore" | "implement"; readonly settled: Promise<void> }
interface ConversationInput { sessionId: string; workspaceRoot: string; rawWish: string; requestId?: string; runId?: string }
export interface DevelopmentControllerOptions { readonly state: Development; readonly plan: Plan; readonly goal?: () => Goal | undefined; readonly operations?: DevelopmentOperations; readonly executionAvailable?: () => boolean }

/** Product orchestration. Runtime, Plan, Goal and execution permissions retain
 * their own authority; this owner binds their exact versions and durable intent. */
export class DevelopmentController {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly conversations = new Map<string, { application: WishApplication; handle: WishRunHandle }>();
  private readonly revisionRequests = new Set<string>();
  private readonly pendingRevisions = new Map<string, ConversationInput>();
  private readonly humanInputs = new Map<string, { sessionId: string; rawWish: string; requestId: string }>();
  private startingRuns = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly operations: DevelopmentOperations;
  constructor(private readonly options: DevelopmentControllerOptions) { this.operations = options.operations ?? new MemoryDevelopmentOperations(); }
  get activeRunCount(): number { return this.active.size + this.startingRuns; }
  readonly list = () => this.options.state.list();
  readonly inspect = async (sessionId: string) => ({ project: await this.options.state.forSession(sessionId) ?? null });

  observeConversationRun(application: WishApplication, handle: WishRunHandle): void {
    requireDevelopment(!this.closed, "development_closed");
    this.conversations.set(handle.runId, { application, handle });
    const release = () => { this.conversations.delete(handle.runId); this.humanInputs.delete(handle.runId); };
    void handle.completion.then(release, release);
  }
  conversationInput(sessionId: string, runId: string): { rawWish: string; requestId: string } | undefined {
    const input = this.humanInputs.get(runId);
    return input?.sessionId === sessionId ? { rawWish: input.rawWish, requestId: input.requestId } : undefined;
  }
  begin(input: ConversationInput): Promise<DevelopmentProject> {
    return this.serial(async () => input.runId ? this.admitRun(() => this.beginAccepted(input)) : this.beginAccepted(input));
  }
  private async beginAccepted(input: ConversationInput): Promise<DevelopmentProject> {
    const conversation = input.runId ? this.conversations.get(input.runId) : undefined;
    if (input.runId) requireDevelopment(conversation?.handle.scope === input.sessionId, "development_conversation_unavailable", "当前会话运行尚未完成交接，请稍后重试。");
    let project = await this.options.state.forSession(input.sessionId);
    const activeId = project?.activeChangeId;
    const existing = project?.changes.find(change => change.id === activeId);
    const revisionKey = `${input.sessionId}:${input.requestId ?? input.runId ?? ""}`;
    if (conversation && project && existing && existing.originRequestId !== input.requestId && !this.revisionRequests.has(revisionKey)) {
      if (existing.phase === "stopping" && existing.starts.some(start => start.runId === input.runId && ["dispatching", "running"].includes(start.status))) {
        this.pendingRevisions.set(input.runId!, input);
        return project;
      }
      requireDevelopment(existing.sessionId === input.sessionId && !existing.starts.some(start => ["dispatching", "running"].includes(start.status)), "development_still_running", "请先停止当前实施，再讨论新的需求。");
      project = await this.options.state.revise({ projectId: project.id, changeId: existing.id, sessionId: input.sessionId, expectedRevision: project.revision, rawWish: input.rawWish });
      this.revisionRequests.add(revisionKey);
    } else project = await this.options.state.open(input);
    const change = currentChange(project);
    if (conversation && !this.active.has(conversation.handle.runId)) this.track(conversation.application, conversation.handle, project, "explore");
    const plan = await this.options.plan.get({ sessionId: input.sessionId });
    if (!plan?.active) await this.options.plan.enter({ sessionId: input.sessionId, goal: change.wishUpdates.at(-1) ?? change.rawWish });
    await this.disarm(input.sessionId);
    return project;
  }

  async beforeConversationInput(sessionId: string, text: string, context?: SessionFeatureInputContext): Promise<void> {
    if (context?.runId && context.kind !== "start" && context.inputSource === "user") this.humanInputs.set(context.runId, { sessionId, rawWish: text, requestId: randomUUID() });
    const project = await this.options.state.forSession(sessionId), change = project?.changes.find(item => item.id === project.activeChangeId);
    if (!project || !change || change.sessionId !== sessionId || !change.starts.some(start => ["dispatching", "running"].includes(start.status))) return;
    // The implementation request is already bound to its durable reservation.
    if (context?.kind === "start" && change.starts.some(start => start.runId === context.runId && start.status === "dispatching")) return;
    await this.options.state.requestPause({ projectId: project.id, changeId: change.id, sessionId, expectedRevision: project.revision });
    await this.disarm(sessionId);
  }

  propose: Development["propose"] = input => this.serial(async () => {
    const project = await this.options.state.propose(input);
    const change = currentChange(project), spec = change.specs.at(-1)!;
    let plan = await this.options.plan.get({ sessionId: input.sessionId });
    if (!plan?.active) plan = await this.options.plan.enter({ sessionId: input.sessionId, goal: spec.objective });
    plan = await this.options.plan.update({ sessionId: input.sessionId, markdown: spec.planMarkdown,
      expectedPlanVersion: plan.document?.version ?? 0,
      artifacts: [...spec.artifacts ?? [], { kind: "wish-spec", id: change.id, version: spec.version, digest: spec.digest }],
    });
    await this.options.plan.review({ sessionId: input.sessionId, markdown: spec.planMarkdown, expectedPlanVersion: plan.document!.version });
    await this.disarm(input.sessionId);
    return project;
  });

  report: Development["report"] = async input => {
    const project = await this.options.state.report(input);
    const goal = this.options.goal?.();
    const current = await goal?.get({ sessionId: input.sessionId });
    if (current && current.phase !== "complete" && current.objective.startsWith("实现已确认愿望并生成真实验收记录：") && currentChange(project).starts.length) await goal!.complete({ sessionId: input.sessionId, ref: current });
    return project;
  };
  recordVerification: Development["recordVerification"] = input => this.options.state.recordVerification(input);

  control(application: WishApplication, sessionId: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ project: DevelopmentProject | null; runId?: string }> {
    return this.serial(async () => {
      text(body.requestId);
      const identity = operationIdentity(sessionId, body), prior = await this.operations.get(identity.id);
      if (prior) {
        requireDevelopment(prior.fingerprint === identity.fingerprint, "development_request_conflict", "相同请求不能用于另一个版本或操作。");
        requireDevelopment(prior.status !== "pending", "development_operation_incomplete", "上次操作结果需要核对，请刷新项目状态。");
        if (prior.status === "failed") throw new DevelopmentError(prior.errorCode ?? "development_action_failed", prior.errorMessage);
        return { project: prior.projectId ? await this.options.state.get(prior.projectId) ?? null : null, ...(prior.runId ? { runId: prior.runId } : {}) };
      }
      await this.operations.create({ ...identity, sessionId, status: "pending" });
      try {
        const result = await this.performControl(application, sessionId, body, signal);
        await this.operations.finish(identity.id, { status: "completed", ...(result.project ? { projectId: result.project.id } : {}), ...(result.runId ? { runId: result.runId } : {}) });
        return result;
      } catch (error) {
        await this.operations.finish(identity.id, { status: "failed", errorCode: error instanceof DevelopmentError ? error.code : "development_action_failed", errorMessage: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }
  private async performControl(application: WishApplication, sessionId: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ project: DevelopmentProject | null; runId?: string }> {
      signal?.throwIfAborted();
      const session = await application.getSession({ sessionId, ...(signal ? { signal } : {}) });
      requireDevelopment(session.status === "active", "development_session_archived");
      const action = text(body.action), requestId = text(body.requestId);
      const data = object(body.data ?? {});
      if (action === "open") {
        const project = await this.beginAccepted({ sessionId, workspaceRoot: session.scope, rawWish: text(data.rawWish), requestId });
        const existing = [...this.active.values()].find(item => item.projectId === project.id);
        if (existing) return { project, runId: existing.handle.runId };
        return this.explore(application, project, sessionId, signal);
      }
      let project = await this.options.state.get(text(body.projectId));
      requireDevelopment(project && project.workspaceRoot === session.scope, "development_project_session_mismatch");
      const change = currentChange(project);
      // Repeating an accepted start returns its original identity, even after
      // completion. A new action must carry the current project revision.
      const replay = change.starts.find(item => item.id === requestId);
      if (replay && (action === "approve-and-start" || action === "resume")) {
        requireDevelopment(replay.sessionId === sessionId, "development_request_conflict");
        return { project, runId: replay.runId };
      }
      const expectedRevision = integer(body.expectedRevision);
      requireDevelopment(project.revision === expectedRevision, "development_conflict", "愿望已变化，请刷新后重新检查。");
      requireDevelopment(data.changeId === undefined || data.changeId === change.id, "development_change_conflict");
      const request: DevelopmentChangeRequest = { projectId: project.id, changeId: change.id, sessionId, expectedRevision };
      if (action === "explore") return this.explore(application, project, sessionId, signal);
      if (action === "propose") return { project: await this.proposeAccepted(request, data.spec) };
      if (action === "approve-and-start") {
        requireDevelopment(change.sessionId === sessionId, "development_session_mismatch");
        requireDevelopment(change.gate === "confirmation", "development_proposal_missing", "需求已更新，请等待重新整理方案后再确认。");
        requireDevelopment(![...this.active.values()].some(item => item.projectId === project!.id), "development_exploration_busy", "探索仍在结束，请稍后刷新再确认。");
        requireDevelopment(!application.runGeneration?.snapshot().activeRuns.some(run => run.scope === sessionId), "development_exploration_busy", "当前会话仍在运行，请等待结束后再确认。");
        // Completion may have advanced the ledger; approval still uses exactly
        // the displayed specification rather than silently selecting a new one.
        project = (await this.options.state.get(project.id))!;
        const spec = currentChange(project).specs.at(-1);
        requireDevelopment(spec && spec.version === integer(data.specVersion) && spec.digest === text(data.specDigest), "development_stale_spec");
        await this.requireImplementationPermission(application, sessionId);
        requireDevelopment((await captureWorkspaceSnapshot(project.workspaceRoot)).digest === spec.code.digest, "development_proposal_code_changed", "项目代码已变化，请重新调查并更新方案后确认。");
        const plan = await this.approvePlan(sessionId, change.id, spec);
        project = await this.options.state.confirm({ ...request, expectedRevision: project.revision, specVersion: spec.version, specDigest: spec.digest,
          actor: "human-session-surface", planApproval: planReceipt(plan),
        });
        return this.startImplementation(application, project, sessionId, requestId, signal);
      }
      if (action === "pause") return { project: await this.pauseAccepted(project, sessionId) };
      if (action === "resume") {
        requireDevelopment(["paused", "interrupted", "verifying", "review"].includes(change.phase), "development_not_resumable");
        const spec = change.specs.at(-1);
        requireDevelopment(spec, "development_spec_missing");
        await this.requireImplementationPermission(application, sessionId);
        // Resuming explicitly reconfirms the same requirements against the
        // current dirty workspace; it never resets files or revives an old Run.
        const approval = change.confirmations.at(-1)?.planApproval;
        project = await this.options.state.confirm({ ...request, specVersion: spec.version, specDigest: spec.digest, actor: "human-resume",
          ...(approval ? { planApproval: approval } : {}),
        });
        return this.startImplementation(application, project, sessionId, requestId, signal);
      }
      if (action === "revise") {
        if (["running", "stopping"].includes(change.phase) || [...this.active.values()].some(item => item.projectId === project!.id)) project = await this.pauseAccepted(project, sessionId);
        const revised = await this.options.state.revise({ ...request, expectedRevision: project.revision, ...(data.rawWish === undefined ? {} : { rawWish: text(data.rawWish) }) });
        const plan = await this.options.plan.get({ sessionId });
        if (plan?.active) { /* The next proposal replaces the pending document. */ }
        else await this.options.plan.enter({ sessionId, goal: currentChange(revised).rawWish });
        return this.explore(application, revised, sessionId, signal);
      }
      if (action === "report") return { project: await this.report({ ...request, summary: text(data.summary), limitations: strings(data.limitations), nextSteps: strings(data.nextSteps) }) };
      if (action === "accept") return { project: await this.options.state.accept({ ...request, reportId: text(data.reportId), reportDigest: text(data.reportDigest), actor: "human-session-surface" }) };
      throw new DevelopmentError("development_invalid_action", "未知的愿望开发操作。");
  }

  // The public propose method serializes model calls; an already-admitted human
  // control uses this body directly to avoid recursively acquiring the queue.
  private async proposeAccepted(request: DevelopmentChangeRequest, value: unknown): Promise<DevelopmentProject> {
    const project = await this.options.state.propose({ ...request, spec: value as DevelopmentSpecInput });
    const spec = currentChange(project).specs.at(-1)!;
    let plan = await this.options.plan.get({ sessionId: request.sessionId });
    if (!plan?.active) plan = await this.options.plan.enter({ sessionId: request.sessionId, goal: spec.objective });
    plan = await this.options.plan.update({ sessionId: request.sessionId, markdown: spec.planMarkdown, expectedPlanVersion: plan.document?.version ?? 0,
      artifacts: [...spec.artifacts ?? [], { kind: "wish-spec", id: request.changeId, version: spec.version, digest: spec.digest }],
    });
    await this.options.plan.review({ sessionId: request.sessionId, markdown: spec.planMarkdown, expectedPlanVersion: plan.document!.version });
    await this.disarm(request.sessionId);
    return project;
  }

  private async approvePlan(sessionId: string, changeId: string, spec: DevelopmentSpecInput & { version: number; digest: string }): Promise<PlanState> {
    const plan = await this.options.plan.get({ sessionId });
    requireDevelopment(plan?.document?.markdown === spec.planMarkdown && (plan.review?.status === "pending" || plan.review?.status === "approved") &&
      digest(plan.document.artifacts ?? []) === digest([...spec.artifacts ?? [], { kind: "wish-spec", id: changeId, version: spec.version, digest: spec.digest }]),
    "development_plan_changed", "方案已变化，请重新生成并检查当前版本。");
    requireDevelopment(spec.questions.length === 0, "development_unresolved_questions", "请先明确方案中的待确认问题。");
    if (plan.review.status === "approved") return plan;
    return this.options.plan.decide({ sessionId, reviewId: plan.review.id, expectedPlanVersion: plan.document.version, digest: plan.document.digest, decision: "approve", actor: "human-session-surface" });
  }

  private async explore(application: WishApplication, project: DevelopmentProject, sessionId: string, signal?: AbortSignal) {
    return this.admitRun(() => this.dispatchExploration(application, project, sessionId, signal));
  }
  private async dispatchExploration(application: WishApplication, project: DevelopmentProject, sessionId: string, signal?: AbortSignal) {
    const change = currentChange(project);
    requireDevelopment(change.sessionId === sessionId && ["exploring", "ready"].includes(change.phase), "development_not_exploring");
    requireDevelopment(![...this.active.values()].some(item => item.projectId === project.id), "development_already_running");
    const handle = await application.startRun({ sessionId, payload: { text: `继续梳理当前目标与方案：${change.wishUpdates.at(-1) ?? change.rawWish}` }, inputSource: "follow_up", metadata: { source: "wish-development", projectId: project.id, changeId: change.id, kind: "explore" }, ...(signal ? { signal } : {}) });
    this.track(application, handle, project, "explore");
    return { project: await this.options.state.get(project.id) ?? project, runId: handle.runId };
  }

  private async startImplementation(application: WishApplication, project: DevelopmentProject, sessionId: string, requestId: string, signal?: AbortSignal) {
    return this.admitRun(() => this.dispatchImplementation(application, project, sessionId, requestId, signal));
  }
  private async admitRun<T>(dispatch: () => Promise<T>): Promise<T> {
    requireDevelopment(this.options.executionAvailable?.() !== false, "development_execution_unavailable", "实施策略或验证工具不可用，请先恢复相应插件。");
    // Keep guard and Tool consumers attached across reservation, Goal work and
    // Application admission, before a handle exists in the active Run map.
    this.startingRuns++;
    try { return await dispatch(); }
    finally { this.startingRuns--; }
  }
  private async dispatchImplementation(application: WishApplication, project: DevelopmentProject, sessionId: string, requestId: string, signal?: AbortSignal) {
    const change = currentChange(project), confirmation = change.confirmations.at(-1)!;
    project = await this.options.state.reserveStart({ projectId: project.id, changeId: change.id, sessionId, expectedRevision: project.revision, requestId, confirmationDigest: confirmation.digest });
    const start = currentChange(project).starts.find(item => item.id === requestId)!;
    if (start.status !== "dispatching" || this.active.has(start.runId)) return { project, runId: start.runId };
    try {
      const goal = this.options.goal?.(), current = await goal?.get({ sessionId });
      // Product continuation is bounded by the existing Goal driver. Creating a
      // delivery record completes this execution goal, not product acceptance.
      if (goal) {
        const objective = `实现已确认愿望并生成真实验收记录：${change.specs.at(-1)!.objective}`;
        if (current && current.phase !== "complete") {
          requireDevelopment(current.objective.startsWith("实现已确认愿望并生成真实验收记录："), "development_unrelated_goal", "当前会话还有其他目标，请先完成或清除该目标。");
          const updated = await goal.edit({ sessionId, ref: current, objective, maxGoalRounds: current.roundsStarted + 8 });
          await goal.resume({ sessionId, ref: updated });
        } else await goal.create({ sessionId, objective, maxGoalRounds: 8 });
      }
      const handle = await application.startRun({ sessionId, runId: start.runId,
        payload: { text: `按已确认方案继续实施并验证：${change.specs.at(-1)!.objective}` },
        inputSource: "follow_up", metadata: { source: "wish-development", projectId: project.id, changeId: change.id, requestId, confirmationDigest: confirmation.digest }, ...(signal ? { signal } : {}),
      });
      this.track(application, handle, project, "implement");
      project = await this.options.state.bindStart({ projectId: project.id, requestId, runId: start.runId });
      return { project, runId: handle.runId };
    } catch (error) {
      const active = this.active.get(start.runId);
      if (active) active.application.controlRun(start.runId, { type: "abort", source: "wish-development", reason: "Execution admission failed" });
      await this.options.state.finishRun({ projectId: project.id, runId: start.runId, status: "failed" });
      await this.disarm(sessionId);
      throw error;
    }
  }
  private async requireImplementationPermission(application: WishApplication, sessionId: string): Promise<void> {
    requireDevelopment(this.options.executionAvailable?.() !== false, "development_execution_unavailable", "实施策略或验证工具不可用，请先恢复相应插件。");
    const profile = await application.sessionPermissions?.forRun(sessionId);
    requireDevelopment(profile !== "read-only", "development_read_only_profile", "当前会话为只读权限。请先选择允许实施的权限，再确认开始。");
  }

  private track(application: WishApplication, handle: WishRunHandle, project: DevelopmentProject, mode: "explore" | "implement"): void {
    const settled = handle.completion.then(async completion => {
      if (completion.status === "aborted") {
        const latest = await this.options.state.get(project.id), change = latest && currentChange(latest);
        if (latest && change && change.id === currentChange(project).id && change.phase !== "accepted") {
          await this.options.state.requestPause({ projectId: latest.id, changeId: change.id, sessionId: change.sessionId, expectedRevision: latest.revision });
          await this.disarm(change.sessionId);
        }
      }
      if (mode === "implement") await this.options.state.finishRun({ projectId: project.id, runId: handle.runId, status: completion.status });
      const latest = await this.options.state.get(project.id);
      if (latest && currentChange(latest).phase === "stopping") await this.options.state.settlePause({ projectId: project.id, changeId: currentChange(project).id });
      const pending = this.pendingRevisions.get(handle.runId);
      this.pendingRevisions.delete(handle.runId);
      if (pending && !this.closed) {
        let revised = (await this.options.state.get(project.id))!;
        revised = await this.options.state.revise({ projectId: revised.id, changeId: currentChange(revised).id, sessionId: pending.sessionId, expectedRevision: revised.revision, rawWish: pending.rawWish });
        this.revisionRequests.add(`${pending.sessionId}:${pending.requestId ?? pending.runId ?? ""}`);
        const plan = await this.options.plan.get({ sessionId: pending.sessionId });
        if (!plan?.active) await this.options.plan.enter({ sessionId: pending.sessionId, goal: pending.rawWish });
        this.active.delete(handle.runId);
        if (completion.status !== "aborted") await this.explore(application, revised, pending.sessionId);
      }
    }, async error => {
      if (mode === "implement") await this.options.state.finishRun({ projectId: project.id, runId: handle.runId, status: "interrupted" });
      throw error;
    }).finally(() => { this.active.delete(handle.runId); });
    this.active.set(handle.runId, { application, handle, projectId: project.id, changeId: currentChange(project).id, mode, settled });
    void settled.catch(() => {});
  }

  private async pauseAccepted(project: DevelopmentProject, sessionId: string): Promise<DevelopmentProject> {
    const change = currentChange(project);
    project = await this.options.state.requestPause({ projectId: project.id, changeId: change.id, sessionId, expectedRevision: project.revision });
    await this.disarm(sessionId);
    const owned = [...this.active.values()].filter(item => item.projectId === project.id);
    for (const item of owned) this.pendingRevisions.delete(item.handle.runId);
    for (const item of owned) {
      const receipt = item.application.controlRun(item.handle.runId, { type: "abort", source: "wish-development", reason: "Wish development paused" });
      requireDevelopment(receipt.accepted || receipt.reason === "already_cancelled" || receipt.reason === "run_already_terminal", "development_stop_unconfirmed");
    }
    await boundedDrain(owned.map(item => item.settled));
    return this.options.state.settlePause({ projectId: project.id, changeId: change.id });
  }
  private async waitForExploration(projectId: string): Promise<void> {
    const owned = [...this.active.values()].filter(item => item.projectId === projectId);
    requireDevelopment(owned.every(item => item.mode === "explore"), "development_already_running");
    await boundedDrain(owned.map(item => item.settled));
  }
  private async disarm(sessionId: string): Promise<void> { await this.options.goal?.()?.disarm({ sessionId }); }
  async detachSession(sessionId: string): Promise<void> { await this.options.state.detachSession(sessionId); }
  async drainSession(sessionId: string): Promise<void> {
    const owned = [...this.active.values()].filter(item => item.handle.scope === sessionId);
    // Deletion has already requested cancellation through Application. Archive
    // must not claim that work is idle merely because a projection disappeared.
    requireDevelopment(owned.every(item => !item.application.runGeneration?.snapshot().activeRuns.some(run => run.runId === item.handle.runId)), "development_session_busy", "愿望开发仍在运行，请先暂停并等待停止。");
    await boundedDrain(owned.map(item => item.settled));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail.catch(() => {});
    for (const project of await this.options.state.list()) {
      if ([...this.active.values()].some(item => item.projectId === project.id)) await this.pauseAccepted(project, currentChange(project).sessionId);
    }
    this.conversations.clear();
    this.pendingRevisions.clear();
    this.revisionRequests.clear();
    this.humanInputs.clear();
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    requireDevelopment(!this.closed, "development_closed");
    const pending = this.tail.then(action);
    this.tail = pending.catch(() => {});
    return pending;
  }
}

export function currentChange(project: DevelopmentProject): DevelopmentChange {
  const change = project.changes.find(item => item.id === project.activeChangeId) ?? project.changes.at(-1);
  requireDevelopment(change, "development_change_missing");
  return change;
}
function planReceipt(plan: PlanState) {
  return { sessionId: plan.sessionId, reviewId: plan.review!.id, stateVersion: plan.version, documentVersion: plan.document!.version,
    digest: plan.document!.digest, markdown: plan.document!.markdown, ...(plan.document!.artifacts ? { artifacts: plan.document!.artifacts } : {}) };
}
function text(value: unknown): string { requireDevelopment(typeof value === "string" && value.trim().length > 0 && value.length <= 131072, "development_invalid_request"); return value; }
function integer(value: unknown): number { requireDevelopment(Number.isSafeInteger(value) && (value as number) >= 0, "development_invalid_revision"); return value as number; }
function object(value: unknown): Readonly<Record<string, unknown>> { requireDevelopment(value !== null && typeof value === "object" && !Array.isArray(value), "development_invalid_request"); return value as Record<string, unknown>; }
function strings(value: unknown): readonly string[] { if (value === undefined) return []; requireDevelopment(Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === "string" && item.length <= 16384), "development_invalid_request"); return value; }
async function boundedDrain(work: readonly Promise<unknown>[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.all(work), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DevelopmentError("development_stop_pending", "运行仍在收尾，请刷新状态后再恢复。")), 15_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
