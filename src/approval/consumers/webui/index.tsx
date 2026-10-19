import type { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import type { WishWebApproval } from "../../../apps/webui/types.js";
import type { ApprovalRuleScope } from "../../../permissions/rules/types.js";
import type { CapabilityRequirement } from "../../../permissions/authorization.js";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { ApprovalClientModel } from "./model.js";
import { useText } from "../../../apps/webui/client/i18n.js";

export const ApprovalClientUi = { name: "ui-approval", inject: ["wishSession", "wishConnection", "wishUiSlots"], apply(ctx: Context) {
  const model = new ApprovalClientModel(ctx.wishConnection, ctx.wishSession); ctx.effect(() => () => model.close());
  ctx.effect(() => ctx.wishUiSlots.interaction({ id: "approval", View: () => <Approvals model={model} /> }));
} };
function Approvals({ model }: { model: ApprovalClientModel }) {
  const state = useSnapshot(model);
  return <div className="approval-interactions"><ErrorNotice text={state.error} />{state.approvals.map(approval => <Approval key={approval.approvalId} model={model} approval={approval} disabled={state.pending || !state.available} />)}</div>;
}
function Approval({ model, approval, disabled }: { model: ApprovalClientModel; approval: WishWebApproval; disabled: boolean }) {
  const t = useText();
  const [scope, setScope] = useState<ApprovalRuleScope>("once"), [error, setError] = useState<string | null>(null);
  async function decide(approved: boolean) { setError(null); try { await model.decide(approval, approved, scope); } catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("审批提交失败", "Could not submit approval"))); } }
  return <section className="approval-request" role="region" aria-label={t(`工具审批 ${approval.call.name}`, `Tool approval ${approval.call.name}`)}>
    <header className="section-heading"><h2>{t("需要批准：", "Approve: ")}{approval.call.name}</h2></header>
    <div className="approval-summary">
      <div><h3>{t("操作内容", "Operation")}</h3><ApprovalInput input={approval.call.input} /></div>
      <div><h3>{t("所需权限", "Required access")}</h3><ul className="approval-capability-list">{approval.capabilities.requirements.map((requirement, index) => <li key={index}><strong>{capabilityLabel(requirement, t)}</strong><span>{capabilityTarget(requirement, t)}</span></li>)}</ul>
        {!approval.capabilities.requirements.length ? <p className="muted">{t("此操作需要单独确认。", "This operation requires confirmation.")}</p> : null}
        {approval.capabilities.effects?.destructive ? <p className="approval-risk">{t("此操作可能删除或覆盖数据。", "This operation may delete or overwrite data.")}</p> : null}
        {approval.capabilities.effects?.openWorld ? <p className="approval-risk">{t("此操作可能访问未预先列出的目标。", "This operation may access targets not listed in advance.")}</p> : null}
      </div>
    </div>
    <p className="approval-workspace">{t("工作区", "Workspace")} <code>{approval.workspace.cwd}</code></p>
    <details className="approval-technical"><summary>{t("查看完整请求", "View full request")}</summary><pre>{JSON.stringify({ input: approval.call.input, capabilities: approval.capabilities, workspace: approval.workspace.cwd }, null, 2)}</pre></details>
    <ErrorNotice text={error} />
    <div className="actions"><label>{t("批准范围", "Approval scope")}<select value={scope} disabled={disabled} onChange={event => setScope(event.target.value as ApprovalRuleScope)}><option value="once">{t("仅这一次", "This call only")}</option><option value="run">{t("本次运行", "This run")}</option><option value="session">{t("本会话", "This session")}</option><option value="workspace">{t("此工作区", "This workspace")}</option></select></label><button disabled={disabled} onClick={() => { void decide(false); }}>{t("拒绝", "Deny")}</button><button className="primary" disabled={disabled} onClick={() => { void decide(true); }}>{t("批准", "Approve")}</button></div>
  </section>;
}

function ApprovalInput({ input }: { readonly input: unknown }) {
  const t = useText();
  if (!input || typeof input !== "object" || Array.isArray(input)) return <pre>{JSON.stringify(input, null, 2) ?? String(input)}</pre>;
  const entries = Object.entries(input);
  if (!entries.length) return <p className="muted">{t("没有参数", "No parameters")}</p>;
  return <dl className="approval-input">{entries.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{typeof value === "string" ? <pre>{value}</pre> : <pre>{JSON.stringify(value, null, 2) ?? String(value)}</pre>}</dd></div>)}</dl>;
}

function capabilityLabel(requirement: CapabilityRequirement, t: (zh: string, en: string) => string): string {
  switch (requirement.capability) {
    case "filesystem.read": return t("读取文件", "Read files");
    case "filesystem.write": return t("修改文件", "Modify files");
    case "process.exec": return t("执行命令", "Run command");
    case "network.connect": return t("连接网络", "Connect to network");
    case "web.search": return t("搜索网页", "Search the web");
    case "web.fetch": return t("读取网页", "Fetch web pages");
    case "external.side_effect": return t("外部操作", "External action");
    case "runtime.read": return t("读取运行状态", "Read runtime state");
    case "runtime.control": return t("控制运行", "Control runtime");
  }
}

function capabilityTarget(requirement: CapabilityRequirement, t: (zh: string, en: string) => string): string {
  switch (requirement.capability) {
    case "filesystem.read": case "filesystem.write": return requirement.paths.join("、");
    case "process.exec": return [requirement.commands?.join("、"), requirement.cwd, requirement.timeoutSeconds === undefined ? undefined : t(`最长 ${requirement.timeoutSeconds} 秒`, `Up to ${requirement.timeoutSeconds} seconds`)].filter(Boolean).join(" · ") || t("指定命令", "Specified command");
    case "network.connect": return requirement.hosts.join("、");
    case "web.search": return requirement.providers.join("、");
    case "web.fetch": return [...requirement.providers, ...requirement.origins].join("、");
    case "external.side_effect": case "runtime.read": case "runtime.control": return requirement.resources.join("、");
  }
}
