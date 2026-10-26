import { useEffect, useId, useRef, useState } from "react";
import { useText } from "../../../apps/webui/client/i18n.js";
import { ErrorNotice, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { MarkdownContent } from "../../../apps/webui/client/ui/markdown.js";
import type { DevelopmentChange, DevelopmentGate, DevelopmentPhase, DevelopmentProject, DevelopmentReport, DevelopmentSpec } from "../../types.js";
import type { DevelopmentClientModel } from "./model.js";

interface ConfirmationView { readonly project: DevelopmentProject; readonly spec: DevelopmentSpec }
const latestChange = (project: DevelopmentProject): DevelopmentChange | undefined => project.changes.find(item => item.id === project.activeChangeId) ?? project.changes.at(-1);

/** A small conversation contribution. Wishes and revisions use the ordinary composer. */
export function DevelopmentConversationCard({ model, sessionId }: { readonly model: DevelopmentClientModel; readonly sessionId: string }) {
  const state = useSnapshot(model);
  const project = state.sessionId === sessionId ? state.projects.find(item => item.id === state.sessionProjectId) : undefined;
  if (!project || !latestChange(project)) return null;
  return <DevelopmentProjectView key={`${sessionId}:${project.id}`} project={project} model={model} />;
}

export function DevelopmentProjectView({ project, model }: { readonly project: DevelopmentProject; readonly model: DevelopmentClientModel }) {
  const t = useText(), state = useSnapshot(model), id = useId();
  const change = latestChange(project), spec = change?.specs.at(-1), report = change?.reports.at(-1);
  const writable = model.canAct(project), running = model.hasActiveRun();
  const historical = !project.activeChangeId || change?.sessionId !== state.sessionId;
  const [confirmation, setConfirmation] = useState<ConfirmationView | null>(null);
  const [error, setError] = useState<string | null>(null), [adjusting, setAdjusting] = useState(false);
  const editingIdentity = useRef({ changeId: change?.id, sessionId: state.sessionId });
  useEffect(() => {
    const previous = editingIdentity.current;
    if (previous.changeId === change?.id && previous.sessionId === state.sessionId) return;
    editingIdentity.current = { changeId: change?.id, sessionId: state.sessionId };
    setConfirmation(null); setError(null); setAdjusting(false);
  }, [change?.id, state.sessionId]);
  if (!change) return null;
  const staleConfirmation = confirmation !== null && (confirmation.project.revision !== project.revision || confirmation.spec.digest !== spec?.digest);
  const reportReady = report !== undefined && report.specDigest === spec?.digest && report.executionEpoch === change.executionEpoch && report.criteria.every(item => item.status === "verified" || item.status === "waiting-user");
  async function act(action: string, data: Readonly<Record<string, unknown>> = {}, displayedProject = project): Promise<boolean> {
    setError(null);
    try { await model.act(action, displayedProject, { changeId: change!.id, ...data }); return true; }
    catch (cause) { setError(errorText(cause, t)); return false; }
  }
  async function adjust() {
    if (running && writable && !await act("pause")) return;
    setAdjusting(true); setConfirmation(null); focusConversation();
  }
  return <section className="conversation-card development-conversation-card" aria-labelledby={`${id}-title`} data-development-phase={change.phase}>
    <header><h2 id={`${id}-title`}>{historical ? t("项目交付记录", "Project deliveries") : t("开发目标", "Development goal")}</h2><span>{phaseText(change.phase, t)}</span></header>
    <p className="development-objective">{spec?.objective ?? change.wishUpdates.at(-1) ?? change.rawWish}</p>
    <p className="development-gate" role="status">{state.pending ? t("正在核对操作结果…", "Checking the action result…") : historical ? t("这个工作区的目标与交付记录，可以在当前对话继续查看。", "This workspace’s goals and deliveries remain readable in this conversation.") : gateText(change.gate, t)}</p>
    <ErrorNotice text={error ?? (state.error ? errorText(state.error, t) : null)} />
    <div className="development-actions">
      {!historical && spec && change.gate === "confirmation" ? <button type="button" className="primary" disabled={!writable || running || spec.questions.length > 0} onClick={() => setConfirmation({ project, spec })}>{t("查看方案并确认", "Review and confirm plan")}</button> : null}
      {!historical && running && ["exploring", "running", "verifying"].includes(change.phase) ? <button type="button" disabled={!writable} onClick={() => { void act("pause"); }}>{t("暂停开发", "Pause development")}</button> : null}
      {!historical && ["paused", "interrupted"].includes(change.phase) ? <button type="button" disabled={!writable || running} onClick={() => { void (spec ? act("resume") : act("revise")); }}>{spec ? t("核对并恢复", "Review and resume") : t("继续探索", "Continue exploration")}</button> : null}
      {!historical && spec && (change.phase === "verifying" || change.phase === "review" && !reportReady) ? <button type="button" disabled={!writable || running} onClick={() => { void act("resume"); }}>{t("继续验证", "Continue verification")}</button> : null}
      {!historical && change.phase !== "stopping" && change.phase !== "accepted" ? <button type="button" disabled={!writable} onClick={() => { void adjust(); }}>{running ? t("暂停并调整需求", "Pause and revise") : t("调整需求", "Revise requirements")}</button> : null}
    </div>
    {adjusting ? <p className="development-conversation-hint" role="status">{t("直接在下方消息中说明想改什么，Wish 会更新目标与方案，再请你确认。", "Describe the change in the message box below. Wish will revise the goal and plan for your confirmation.")}</p> : null}
    {confirmation ? <section className="development-confirm" aria-label={t("确认准确版本方案", "Confirm the exact plan version")}>
      <h3>{t(`确认愿望与方案 v${confirmation.spec.version}`, `Confirm wish and plan v${confirmation.spec.version}`)}</h3>
      {staleConfirmation ? <p className="development-stale" role="alert">{t("目标或方案已变化。请取消后重新查看当前版本。", "The goal or plan changed. Cancel and review the current version.")}</p> : null}
      <div className="development-expanded"><WishContent change={latestChange(confirmation.project)!} /><SpecContent spec={confirmation.spec} /></div>
      <div className="development-actions"><button type="button" className="primary" disabled={!writable || running || staleConfirmation} onClick={() => { void act("approve-and-start", { specVersion: confirmation.spec.version, specDigest: confirmation.spec.digest }, confirmation.project).then(ok => { if (ok) setConfirmation(null); }); }}>{t("确认并开始", "Confirm and start")}</button><button type="button" disabled={state.pending} onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</button></div>
    </section> : null}
    <details className="development-details"><summary>{t("目标、方案与进展", "Goal, plan and progress")}</summary><div className="development-expanded">
      <WishContent change={change} />
      {spec ? <SpecContent spec={spec} /> : <p className="muted">{t("正在结合项目现状明确目标；你可以直接在对话中补充想法和回答问题。", "Wish is investigating the project. Share ideas and answer questions directly in the conversation.")}</p>}
      <VerificationContent change={change} />
    </div></details>
    {report ? <details className="development-delivery"><summary>{t("查看交付与验收", "Review delivery and acceptance")}</summary><div className="development-expanded">
      <ReportContent report={report} change={change} />
      <VerificationContent change={change} evidenceIds={new Set(report.criteria.flatMap(item => item.evidenceIds))} />
      {!historical && change.phase === "review" ? <><div className="development-actions"><button type="button" className="primary" disabled={!writable || running || !reportReady} onClick={() => { void act("accept", { reportId: report.id, reportDigest: report.digest }); }}>{t("我已核对，接受这次交付", "Accept this delivery after review")}</button></div>{!reportReady ? <p className="muted">{t("尚有未通过或未验证项，补充验证后再接受。", "Some criteria are failed or unverified. Complete verification before accepting.")}</p> : null}</> : null}
      {change.reports.length > 1 ? <details className="development-history"><summary>{t("本轮历史报告", "Earlier reports for this change")}</summary>{change.reports.slice(0, -1).map(previous => <ReportContent key={previous.id} report={previous} change={change} />)}</details> : null}
    </div></details> : null}
    {project.changes.some(item => item.id !== change.id && item.reports.length) ? <details className="development-history"><summary>{t("之前的交付", "Previous deliveries")}</summary><div className="development-expanded">{project.changes.filter(item => item.id !== change.id && item.reports.length).map(item => <details key={item.id}><summary>{item.specs.at(-1)?.objective ?? item.rawWish}</summary>{item.reports.map(previous => <ReportContent key={previous.id} report={previous} change={item} />)}<VerificationContent change={item} /></details>)}</div></details> : null}
    {historical || change.phase === "accepted" ? <p className="development-conversation-hint">{t("下一项修改，直接在对话中告诉 Wish。", "Tell Wish about the next change directly in the conversation.")}</p> : null}
  </section>;
}

function WishContent({ change }: { readonly change: DevelopmentChange }) {
  const t = useText();
  return <section className="development-section"><h3>{t("原始愿望", "Original wish")}</h3><p className="development-prose">{change.rawWish}</p>{change.wishUpdates.length ? <><h4>{t("最近的需求修订", "Latest revision")}</h4><p className="development-prose">{change.wishUpdates.at(-1)}</p></> : null}</section>;
}

function SpecContent({ spec }: { readonly spec: DevelopmentSpec }) {
  const t = useText();
  return <section className="development-spec development-section"><h3>{t("当前目标", "Current goal")} <span className="muted">v{spec.version}</span></h3><p className="development-prose">{spec.objective}</p>
    <TextList title={t("本轮范围", "In scope")} values={spec.scope} /><TextList title={t("本轮不做", "Out of scope")} values={spec.outOfScope} />
    <TextList title={t("约束", "Constraints")} values={spec.constraints} /><TextList title={t("待确认问题", "Open questions")} values={spec.questions} /><TextList title={t("尚未确认的假设", "Unconfirmed assumptions")} values={spec.assumptions} /><TextList title={t("关键决策", "Key decisions")} values={spec.decisions} />
    <h4>{t("验收标准", "Acceptance criteria")}</h4><ol className="development-criteria">{spec.criteria.map(criterion => <li key={criterion.id}><span>{criterion.text}</span><small>{criterion.kind === "user" ? t("由你体验确认", "User review") : t("需要技术证据", "Technical evidence")}</small></li>)}</ol>
    <h4>{t("实施方案", "Implementation plan")}</h4><div className="message-markdown"><MarkdownContent source={spec.planMarkdown} /></div>
    <h4>{t("流程判断", "Process assessment")}</h4><p>{spec.assessment.reason}</p><dl className="development-assessment"><div><dt>{t("复杂度", "Complexity")}</dt><dd>{assessmentText(spec.assessment.complexity, t)}</dd></div><div><dt>{t("不确定性", "Uncertainty")}</dt><dd>{assessmentText(spec.assessment.uncertainty, t)}</dd></div><div><dt>{t("风险", "Risk")}</dt><dd>{assessmentText(spec.assessment.risk, t)}</dd></div></dl>
  </section>;
}

function VerificationContent({ change, evidenceIds }: { readonly change: DevelopmentChange; readonly evidenceIds?: ReadonlySet<string> }) {
  const t = useText(), spec = change.specs.at(-1), receipts = evidenceIds ? change.verifications.filter(item => evidenceIds.has(item.id)) : change.verifications;
  if (!receipts.length) return null;
  return <section className="development-section"><h3>{t("实际验证记录", "Verification runs")}</h3><ol className="development-evidence">{receipts.map(item => <li key={item.id}>
    <div><strong>{item.exitCode === 0 && !item.timedOut ? t("命令成功", "Command succeeded") : t("命令未通过", "Command did not pass")}</strong><time dateTime={item.endedAt}>{item.endedAt}</time></div>
    <code>{item.command}</code><p className="muted">{t("退出码", "Exit code")}: {item.exitCode ?? t("无", "none")}{item.timedOut ? t(" · 已超时", " · timed out") : ""} · {t("规格", "Spec")} v{item.specVersion}</p>
    {item.specDigest !== spec?.digest || item.executionEpoch !== change.executionEpoch ? <p className="muted">{t("历史验证：不适用于当前版本。", "Historical verification: does not apply to the current version.")}</p> : null}
    <details><summary>{t("实际输出与摘要", "Output and digests")}</summary><pre className="development-output">{item.output || t("命令未产生文本输出。", "The command produced no text output.")}</pre><p><code>{item.outputDigest}</code></p><p><code>{item.code.digest}</code></p></details>
  </li>)}</ol></section>;
}

function ReportContent({ report, change }: { readonly report: DevelopmentReport; readonly change: DevelopmentChange }) {
  const t = useText(), spec = change.specs.find(item => item.version === report.specVersion && item.digest === report.specDigest);
  const stale = change.specs.at(-1)?.digest !== report.specDigest || report.executionEpoch !== change.executionEpoch;
  return <section className="development-report development-section" data-report-id={report.id}><header><h3>{t("交付与验收", "Delivery and acceptance")}</h3><span className="record-state">{report.acceptedAt ? t("用户已接受", "Accepted by user") : t("等待核对", "Awaiting review")}</span></header><p className="development-prose">{report.summary}</p>
    {stale ? <p className="development-stale">{t("这是较早版本的报告，不能证明当前愿望已实现。", "This report belongs to an earlier version and does not verify the current wish.")}</p> : null}
    <ol className="development-criteria">{report.criteria.map(result => <li key={result.criterionId}><span>{spec?.criteria.find(criterion => criterion.id === result.criterionId)?.text ?? result.criterionId}</span><strong data-result={result.status}>{report.acceptedAt && result.status === "waiting-user" ? t("用户已确认", "Confirmed by user") : resultText(result.status, t)}</strong></li>)}</ol>
    <TextList title={t("限制与未完成项", "Limitations")} values={report.limitations} /><TextList title={t("下一步可以做什么", "Possible next steps")} values={report.nextSteps} />
    <details><summary>{t("验证对象与来源", "Verified version and provenance")}</summary><p>{t("规格版本", "Specification")} v{report.specVersion} · <time dateTime={report.createdAt}>{report.createdAt}</time></p><p>{t("代码快照", "Code snapshot")}: <code>{report.code.digest}</code></p><p>{t("报告摘要", "Report digest")}: <code>{report.digest}</code></p><p>{t("来源会话", "Source conversation")}: <code>{change.sessionId}</code></p>{report.evidenceDigests.map(digest => <p key={digest}><code>{digest}</code></p>)}</details>
  </section>;
}

function TextList({ title, values }: { readonly title: string; readonly values: readonly string[] }) {
  return values.length ? <div className="development-text-list"><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></div> : null;
}
function focusConversation(): void { if (typeof document !== "undefined") document.getElementById("wish-composer")?.focus(); }
function phaseText(phase: DevelopmentPhase, t: ReturnType<typeof useText>): string {
  const labels: Record<DevelopmentPhase, readonly [string, string]> = { exploring: ["探索中", "Exploring"], ready: ["等待执行", "Ready"], running: ["开发中", "Developing"], stopping: ["正在停止", "Stopping"], paused: ["已暂停", "Paused"], verifying: ["待验证", "Awaiting verification"], review: ["等待验收", "Awaiting acceptance"], accepted: ["已交付", "Delivered"], interrupted: ["待恢复核对", "Needs recovery review"] };
  return t(...labels[phase]);
}
function gateText(gate: DevelopmentGate, t: ReturnType<typeof useText>): string {
  const labels: Record<DevelopmentGate, readonly [string, string]> = { confirmation: ["先讨论清楚目标与方案，确认后开始实施。", "Clarify the goal and plan before confirming implementation."], execution: ["实施按已确认版本推进。", "Implementation follows the confirmed version."], verification: ["实现结束后，还需要逐项验证。", "Implementation needs verification against each criterion."], "user-acceptance": ["交付结果已整理，可以展开核对。", "The delivery is ready for your review below."], recovery: ["执行曾中断，继续前需要核对现状。", "Execution was interrupted. Review its state before continuing."], none: ["可以继续在对话中补充想法。", "Continue sharing ideas in the conversation."] };
  return t(...labels[gate]);
}
function assessmentText(value: "low" | "medium" | "high", t: ReturnType<typeof useText>): string { return value === "low" ? t("低", "Low") : value === "medium" ? t("中", "Medium") : t("高", "High"); }
function resultText(value: "verified" | "failed" | "unverified" | "waiting-user", t: ReturnType<typeof useText>): string { return value === "verified" ? t("已验证", "Verified") : value === "failed" ? t("未通过", "Failed") : value === "waiting-user" ? t("等待用户体验确认", "Awaiting user review") : t("尚未验证", "Unverified"); }
function errorText(error: unknown, t: ReturnType<typeof useText>): string {
  const text = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : String(error);
  if (text === "development_session_changed") return t("会话或能力已变化，请重新查看后操作。", "The conversation or capability changed. Review it again before continuing.");
  if (text === "development_unresolved_questions") return t("先在对话中回答待确认问题，再开始实施。", "Answer the open questions in the conversation before implementation.");
  if (text === "development_verification_incomplete") return t("仍有未验证或失败的验收项，请先完成验证。", "Some acceptance criteria are unverified or failed. Complete verification first.");
  if (text === "development_read_only_profile") return t("当前会话为只读权限。请先选择允许实施的权限，再确认方案。", "This conversation is read-only. Select an implementation permission profile before confirming the plan.");
  if (text === "development_operation_incomplete") return t("上次操作结果需要核对。请检查当前目标与运行状态。", "The previous action needs review. Check the goal and Run state.");
  if (["development_already_running", "development_session_busy", "development_still_running", "development_exploration_busy"].includes(text)) return t("已有执行仍在进行，请等待完成或暂停后再操作。", "Execution is in progress. Wait for it to finish or pause it first.");
  if (["development_stop_pending", "development_stop_unconfirmed"].includes(text)) return t("停止结果尚未确认，请等待运行结束并核对状态。", "Stopping is not confirmed. Wait for execution to end and review its state.");
  if (text.includes("code_changed") || text === "development_snapshot_changed") return t("工作区内容已变化，需要重新核对代码与验收证据。", "Workspace contents changed. Review the code and acceptance evidence again.");
  if (text.startsWith("development_snapshot_") || text === "development_workspace_symlink") return t("无法安全记录代码快照，请检查工作区文件类型、链接或大小限制。", "The workspace cannot be safely captured. Check file types, links, and size limits.");
  if (text.includes("conflict") || text.startsWith("development_stale_") || text === "development_plan_changed") return t("目标或方案版本已变化，请核对最新内容后重新提交。", "The goal or plan changed. Review its latest version before submitting again.");
  if (text === "development_closed" || text === "control_not_found") return t("开发能力暂不可用，请检查插件状态。", "Development is unavailable. Check the plugin state.");
  if (text.startsWith("development_invalid_") || text === "development_empty_scope") return t("目标、范围、验收标准或方案不完整，请继续在对话中补充。", "The goal, scope, criteria, or plan is incomplete. Continue clarifying it in the conversation.");
  return text;
}
