import { useEffect, useId, useState } from "react";
import { useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import type { EvolutionTarget } from "../../types.js";
import type { EvolutionCampaignView, EvolutionSourceDetail } from "../../presentation.js";
import type { EvolutionClientModel } from "./model.js";

const stateLabels: Record<string, readonly [string, string]> = {
  "waiting-input": ["待开始", "Ready"], running: ["正在开发", "In progress"],
  "awaiting-external-validation": ["候选已准备", "Candidate ready"], "awaiting-review": ["待审核", "Awaiting review"],
  completed: ["本轮已结束", "Finished"], paused: ["已暂停", "Paused"], cancelled: ["已取消", "Cancelled"],
  failed: ["需要处理", "Needs attention"], interrupted: ["执行已中断", "Interrupted"], "reconciliation-required": ["待核对执行结果", "Needs reconciliation"],
};
const stageLabels: Record<string, readonly [string, string]> = { evidence: ["整理证据", "Evidence"], generate: ["生成候选", "Generation"], candidate: ["技术验证", "Technical checks"], feedback: ["记录说明", "Notes"], evaluate: ["外部评测", "External evaluation"], publish: ["正式发布", "Publication"] };
export function EvolutionView({ model, sessionId }: { model: EvolutionClientModel; sessionId: string }) {
  const state = useSnapshot(model), text = useText();
  const objectiveId = useId();
  const [objective, setObjective] = useState(""), [target, setTarget] = useState<EvolutionTarget>("prompt");
  const [generator, setGenerator] = useState<"structured" | "runtime">("structured");
  useEffect(() => model.activate(sessionId), [model, sessionId]);
  return <section className="evolution-view" aria-label={text("自进化", "Evolution")}>
    <header><h2>{text("自进化", "Evolution")}</h2><p className="muted">{text("从当前工作区的任务经验出发，提出并验证能力修改。", "Turn task experience in this workspace into proposed capability changes.")}</p></header>
    <form onSubmit={event => { event.preventDefault(); void model.create(objective, target, generator).then(() => setObjective("")).catch(() => {}); }}>
      <label htmlFor={objectiveId}>{text("希望改进什么", "What should improve?")}</label>
      <textarea id={objectiveId} rows={3} value={objective} maxLength={12000} onChange={event => setObjective(event.target.value)} placeholder={text("描述遇到的问题，或希望增加的能力", "Describe a recurring problem or a capability to add")} />
      <div className="evolution-form-actions"><label>{text("修改对象", "Target")} <select value={target} onChange={event => setTarget(event.target.value as EvolutionTarget)}>
        <option value="prompt">{text("Prompt 指导", "Prompt guidance")}</option><option value="skill">{text("Skill 技能包", "Skill package")}</option><option value="tool">{text("工具能力", "Tool")}</option><option value="plugin">{text("插件能力", "Plugin")}</option>
      </select></label><label>{text("生成方式", "Generation")} <select value={generator} onChange={event => setGenerator(event.target.value as "structured" | "runtime")}><option value="structured">{text("结构化生成", "Structured")}</option><option value="runtime">Coding Agent</option></select></label><button type="submit" className="primary" disabled={!state.available || state.pending || !objective.trim()}>{state.pending ? text("正在提交…", "Submitting…") : text("发起改进", "Start improvement")}</button></div>
      {generator === "runtime" ? <p className="muted">{text("Coding Agent 在私有工作区使用读写和命令工具，每轮最多 8 次模型请求。", "Coding Agent uses file and command tools in a private workspace, with at most 8 model requests per round.")}</p> : null}
    </form>
    {state.error ? <p className="evolution-error" role="alert">{state.error}</p> : null}
    {state.loading ? <p role="status">{text("正在读取改进记录…", "Loading improvements…")}</p> : null}
    {!state.loading && !state.available ? <p role="status">{text("自进化能力暂不可用，已有记录仍保留。", "Evolution is unavailable; existing records are retained.")}</p> : null}
    <p className="evolution-evidence-note">{text(`当前会话已有 ${state.traces.length} 条任务证据。外部效果评测尚未接入。`, `${state.traces.length} task traces from this session. External effectiveness evaluation is not connected.`)}</p>
    {state.trigger ? <details className="evolution-suggestions"><summary>{text("任务观察建议", "Suggestions from task observations")} ({state.trigger.suggestions.length})</summary>
      <p className="muted">{state.trigger.mode === "automatic" ? text("已启用有界自动研究；证据不足时继续等待。", "Bounded automatic research is enabled; insufficient evidence remains pending.") : text("当前只整理建议，不自动发起研究。", "Suggestions only; research starts manually.")}</p>
      {state.trigger.suggestions.map(suggestion => <article key={suggestion.id}><p>{suggestion.summary}</p><small>{text(`${suggestion.taskIds.length} 个独立任务；分类为 ${suggestion.failureCategory}，原因待验证。`, `${suggestion.taskIds.length} independent tasks; ${suggestion.failureCategory} symptoms, cause unverified.`)}</small><p><button type="button" onClick={() => { setObjective(suggestion.summary); setTarget(suggestion.target); }}>{text("使用此建议填写目标", "Use as improvement objective")}</button></p></article>)}
    </details> : null}
    {!state.loading && !state.campaigns.length ? <p className="muted">{text("还没有改进记录。填写目标后，可以查看问题假设、生成的候选和技术验证过程。", "No improvements yet. Describe an objective to inspect hypotheses, candidates, and technical checks.")}</p> : null}
    <div className="evolution-records">{state.campaigns.map(campaign => <EvolutionRecord key={campaign.id} campaign={campaign} model={model} disabled={state.pending || !state.available} />)}</div>
  </section>;
}
function EvolutionRecord({ campaign, model, disabled }: { campaign: EvolutionCampaignView; model: EvolutionClientModel; disabled: boolean }) {
  const text = useText(), [feedback, setFeedback] = useState("");
  const label = stateLabels[campaign.state] ?? [campaign.state, campaign.state];
  const attempt = campaign.attempts.at(-1), proposal = attempt?.proposal;
  return <article className="evolution-record">
    <header><h3>{campaign.spec.objective}</h3><span role="status">{text(label[0], label[1])}</span></header>
    <small>{text(`第 ${attempt?.round ?? 1} 轮`, `Round ${attempt?.round ?? 1}`)} · <time dateTime={campaign.updatedAt}>{new Date(campaign.updatedAt).toLocaleString()}</time></small>
    {campaign.usage ? <p className="evolution-usage">{text(`模型请求 ${campaign.usage.modelCalls} / ${campaign.spec.budget.modelCalls}；Token ${campaign.usage.tokens.toLocaleString()} / ${campaign.spec.budget.tokens.toLocaleString()}`, `Model requests ${campaign.usage.modelCalls} / ${campaign.spec.budget.modelCalls}; tokens ${campaign.usage.tokens.toLocaleString()} / ${campaign.spec.budget.tokens.toLocaleString()}`)}<br />{Object.entries(campaign.usage.costByCurrency).map(([currency, value]) => <span key={currency}>{value === null ? text(`${currency} 金额未知`, `${currency} amount unknown`) : `${currency} ${value.toLocaleString(undefined, { maximumFractionDigits: 6 })}`} · </span>)}{!Object.keys(campaign.usage.costByCurrency).length && campaign.usage.modelCalls ? text("费用未计价；", "Cost unpriced; ") : ""}{text(`执行耗时 ${(campaign.elapsedMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} 秒`, `Execution time ${(campaign.elapsedMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`)}{!campaign.usage.complete ? text("；账本尚不完整", "; accounting is incomplete") : ""}</p> : null}
    {attempt ? <ol className="evolution-stages">{attempt.operations.map(operation => { const name = stageLabels[operation.stage] ?? [operation.stage, operation.stage]; return <li key={operation.id} data-state={operation.status}><span>{text(name[0], name[1])}</span><span>{operation.status === "completed" ? text("已记录", "Recorded") : operation.status === "failed" ? text("已确认失败", "Confirmed failure") : campaign.state === "running" ? text("进行中", "In progress") : text("结果待核对", "Outcome unconfirmed")}</span></li>; })}</ol> : null}
    {attempt?.evidence?.tickets.map(ticket => <details key={ticket.id}><summary>{text("问题与修改假设", "Problem and hypothesis")}</summary><p>{ticket.problem}</p><p>{ticket.hypothesis}</p><small>{text(`关联 ${ticket.traceIds.length} 条证据；原因仍待验证。`, `${ticket.traceIds.length} evidence references; the cause is a hypothesis.`)}</small></details>)}
    {attempt?.evidence?.experiences?.length ? <details><summary>{text("经验与策略依据", "Experience and strategy context")}</summary>{attempt.evidence.experiences.map(entry => <div key={entry.digest}><p><strong>{entry.topic}</strong></p><p>{entry.claim}</p><small>{text(`研究假设；关联 ${entry.evidence.length} 条证据，未直接写入生产知识。`, `Research hypothesis; ${entry.evidence.length} evidence records, independently of production knowledge.`)}</small></div>)}{attempt.evidence.strategies?.map(gene => <div key={gene.digest}><p>{gene.id}@{gene.version}</p><p>{gene.actions.join("\n")}</p>{gene.warnings.map((warning, index) => <p key={index}>{warning.condition}: {warning.avoid} → {warning.instead}</p>)}</div>)}</details> : null}
    {proposal && attempt ? <><p>{proposal.rationale}</p><SourceInspector key={proposal.sourceDigest} model={model} campaignId={campaign.id} attemptId={attempt.id} sourceDigest={proposal.sourceDigest} /><p><small>{text("候选版本", "Candidate version")} {proposal.source.id}@{proposal.source.version}</small></p></> : null}
    {attempt?.duplicateOf ? <p>{text("候选内容与已有轮次相同，已停止重复验证。", "Candidate content repeats an earlier round; repeated checks were stopped.")}</p> : null}
    {campaign.attempts.length > 1 ? <details><summary>{text("历史轮次", "Earlier rounds")} ({campaign.attempts.length - 1})</summary>{campaign.attempts.slice(0, -1).map(previous => <div key={previous.id}><p>{text(`第 ${previous.round} 轮`, `Round ${previous.round}`)} · {previous.candidate ? text("技术验证通过", "Technical checks passed") : previous.operations.some(item => item.status === "failed") ? text("已确认失败", "Confirmed failure") : text("保留原始状态", "Original state retained")}</p>{previous.proposal ? <SourceInspector key={previous.proposal.sourceDigest} model={model} campaignId={campaign.id} attemptId={previous.id} sourceDigest={previous.proposal.sourceDigest} /> : null}{previous.operations.filter(item => item.failure).map(item => <p key={item.id} className="evolution-error">{item.failure!.reason}</p>)}</div>)}</details> : null}
    <details><summary>{text("冻结版本与运行身份", "Frozen versions and execution identity")}</summary><p><small>{text("基线", "Baseline")} <code>{campaign.spec.baselineSnapshotDigest}</code></small></p>{proposal?.generation ? <p><small>Coding Runtime · <code>{proposal.generation.runId}</code><br />Profile · <code>{proposal.generation.snapshotDigest}</code><br />{text("轨迹", "Trajectory")} · <code>{proposal.generation.trajectoryDigest}</code></small></p> : null}{attempt?.candidate ? <p><small>{text("候选产物", "Candidate artifact")} · <code>{attempt.candidate.artifactDigest}</code></small></p> : null}</details>
    {attempt?.candidate ? <p className="evolution-technical-result">{text("技术验证已通过，候选尚未正式发布。", "Technical checks passed. The candidate has not been published.")}</p> : null}
    {attempt?.feedback ? <p>{attempt.feedback.summary}</p> : null}
    {campaign.error ? <pre className="evolution-error" role="alert">{campaign.error}</pre> : null}
    <div className="actions">
      {campaign.state === "running" ? <button disabled={disabled} onClick={() => { void model.act(campaign, "pause").catch(() => {}); }}>{text("暂停", "Pause")}</button> : null}
      {["paused", "interrupted"].includes(campaign.state) ? <button disabled={disabled} onClick={() => { void model.act(campaign, "resume").catch(() => {}); }}>{text("恢复", "Resume")}</button> : null}
      {campaign.state === "reconciliation-required" ? <button disabled={disabled} onClick={() => { void model.act(campaign, "recover").catch(() => {}); }}>{text("核对执行结果", "Reconcile")}</button> : null}
      {!["completed", "cancelled", "failed"].includes(campaign.state) ? <button disabled={disabled} onClick={() => { void model.act(campaign, "cancel").catch(() => {}); }}>{text("取消本次研究", "Cancel research")}</button> : null}
    </div>
    {(campaign.state === "awaiting-external-validation" || campaign.state === "failed" && attempt?.operations.some(item => item.status === "failed") && campaign.usage?.complete) && campaign.attempts.length < campaign.spec.maxRounds ? <form className="evolution-feedback" onSubmit={event => { event.preventDefault(); void model.act(campaign, "continue", feedback).then(() => setFeedback("")).catch(() => {}); }}>
      <label>{text("下一轮修改意见", "Feedback for the next round")}<textarea rows={2} value={feedback} maxLength={12000} onChange={event => setFeedback(event.target.value)} /></label>
      <button disabled={disabled || !feedback.trim()}>{text("根据反馈继续", "Continue with feedback")}</button>
    </form> : null}
  </article>;
}
function SourceInspector({ model, campaignId, attemptId, sourceDigest }: { model: EvolutionClientModel; campaignId: string; attemptId: string; sourceDigest: string }) {
  const text = useText(), [open, setOpen] = useState(false), [detail, setDetail] = useState<EvolutionSourceDetail | null>(null), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || detail) return;
    let current = true;
    void model.source({ id: campaignId }, attemptId, sourceDigest).then(value => { if (current) { setDetail(value); setError(null); } }, cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [open, detail, model, campaignId, attemptId, sourceDigest, retry]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{text("查看候选内容", "Inspect candidate")}</summary>{open ? detail ? <>
    {Object.entries(detail.source.files).map(([path, content]) => <SourceFile key={path} path={path} content={content} />)}
    {detail.previousSource ? <SourceDiff detail={detail} /> : null}
  </> : error ? <p role="alert" className="evolution-error">{error} <button type="button" onClick={() => { setError(null); setRetry(value => value + 1); }}>{text("重新读取", "Retry read")}</button></p> : <p role="status">{text("正在读取准确版本…", "Loading the exact version…")}</p> : null}</details>;
}
function SourceFile({ path, content }: { path: string; content: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary><code>{path}</code></summary>{open ? <pre>{content}</pre> : null}</details>;
}
function SourceDiff({ detail }: { detail: EvolutionSourceDetail }) {
  const text = useText(), [open, setOpen] = useState(false), [patch, setPatch] = useState<string | null>(null);
  useEffect(() => {
    if (!open || patch !== null) return;
    let current = true;
    void import("diff").then(({ createTwoFilesPatch }) => {
      const before = detail.previousSource!.files, after = detail.source.files;
      const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
      const rendered = changes.map(path => (before[path]?.length ?? 0) + (after[path]?.length ?? 0) > 64_000 ? `${path}: ${text("文件较大，请展开完整候选内容。", "Large file; inspect the full candidate content.")}` : createTwoFilesPatch(`previous/${path}`, `candidate/${path}`, before[path] ?? "", after[path] ?? "", undefined, undefined, { context: 3, timeout: 100 }) ?? `${path}: ${text("比较达到时间限制，请查看完整内容。", "Comparison timed out; inspect the complete source.")}`).join("\n");
      if (current) setPatch((rendered.length > 128_000 ? rendered.slice(0, 128_000) + text("\n差异已截断，可查看完整候选内容。", "\nDiff truncated; inspect the complete candidate source.") : rendered) || text("源码内容相同。", "Source content is identical."));
    }, () => { if (current) setPatch(text("暂时无法生成差异，可查看完整内容。", "Diff unavailable; inspect the complete source.")); });
    return () => { current = false; };
  }, [open, patch, detail, text]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{text("与上一轮比较", "Compare with the previous round")}</summary>{open ? <pre>{patch ?? text("正在比较…", "Comparing…")}</pre> : null}</details>;
}
