import type { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import type { WishWebApproval } from "../../../apps/webui/types.js";
import type { ApprovalRuleScope } from "../../../permissions/rules/types.js";
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
  return <section className="approval-request" role="region" aria-label={t(`工具审批 ${approval.call.name}`, `Tool approval ${approval.call.name}`)}><header className="section-heading"><h2>{t("需要你的批准：", "Approval required: ")}{approval.call.name}</h2><small>{t("等待审批", "Waiting for approval")}</small></header><p className="muted">{t("本次命令与能力范围如下；批准不绕过权限策略或沙箱。", "The command and capability scope are below. Approval does not bypass permission policy or sandboxing.")}</p><pre>{JSON.stringify({ input: approval.call.input, capabilities: approval.capabilities, workspace: approval.workspace.cwd }, null, 2)}</pre><ErrorNotice text={error} />
    <div className="actions"><label>{t("允许范围", "Allow for")}<select value={scope} disabled={disabled} onChange={event => setScope(event.target.value as ApprovalRuleScope)}><option value="once">{t("仅本次", "This call")}</option><option value="run">{t("当前 Run", "This run")}</option><option value="session">{t("当前会话", "This session")}</option><option value="workspace">{t("当前 Workspace", "This workspace")}</option></select></label><button disabled={disabled} onClick={() => { void decide(false); }}>{t("拒绝", "Deny")}</button><button className="primary" disabled={disabled} onClick={() => { void decide(true); }}>{t("批准工具调用", "Approve tool call")}</button></div>
  </section>;
}
