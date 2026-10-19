import type { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import { TerminalSnapshot } from "../../../apps/webui/client/ui/terminal.js";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { SessionFeatureView } from "../../../apps/session-features.js";
import type { SubagentObservationView } from "../observation-view.js";
import type { SubagentRecord } from "../../types.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import type { FeaturesClientModel } from "../../../apps/webui/client/model/features.js";
import { GenericToolDetails } from "../../../apps/webui/client/ui/tool.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";

const status: Record<string, string> = { starting: "启动记录", running: "运行记录", exited: "已退出记录", stopped: "已停止记录", failed: "失败记录", lost: "需要核对" };
const statusEn: Record<string, string> = { starting: "Starting record", running: "Running record", exited: "Exited record", stopped: "Stopped record", failed: "Failed record", lost: "Needs review" };
function SubagentConversationCard({ model, sessionId }: { model: FeaturesClientModel; sessionId: string }) {
  const t = useText(), state = useSnapshot(model);
  const [error, setError] = useState<string | null>(null);
  const view = state.sessionId === sessionId ? state.views.find(item => item.key === "subagents") : undefined;
  const data = view?.data as SubagentObservationView | undefined;
  const active = data?.kind === "subagent-observation"
    ? data.records.filter(item => item.target && !["stopped", "exited"].includes(item.status))
    : [];
  if (!view || !active.length) return null;
  return <section className="conversation-card" aria-label={t("子 Agent 运行状态", "Subagent status")}>
    <header><h2>{t("子 Agent", "Subagents")}</h2><span>{active.length}</span></header>
    <ol>{active.map(record => <li key={record.id}>
      <span>{record.role} · {t(status[record.status] ?? record.status, statusEn[record.status] ?? record.status)}</span>
      {view.actions.some(action => action.name === "stop") ? <button type="button" disabled={!state.available || state.pending} onClick={() => {
        setError(null);
        void model.act(sessionId, view, "stop", record.id).catch(cause => setError(readableError(cause instanceof Error ? cause.message : String(cause))));
      }}>{t("停止", "Stop")}</button> : null}
    </li>)}</ol><ErrorNotice text={error} />
  </section>;
}
function SubagentEvidence({ model, view, sessionId, record }: { model: FeaturesClientModel; view: SessionFeatureView; sessionId: string; record: SubagentRecord }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), data = view.data as SubagentObservationView;
  const capture = data.capture?.id === record.id ? data.capture : undefined;
  return <article className="child-evidence"><header><h3>{record.role} · {t("子 Agent", "subagent")}</h3><span className="record-state">{t(status[record.status] ?? record.status, statusEn[record.status] ?? record.status)}</span></header><p className="child-task">{record.task}</p>
    <p className="muted child-identity"><code>{record.id}</code> · {t("更新于 ", "Updated at ")}{new Date(record.updatedAt).toLocaleTimeString(language, { hour12: false })}{t("（持久记录，不代表实时进程状态）", " (durable record, not live process state)")}</p>
    {record.result ? <div className="child-result"><h3>{t("返回结果", "Result")}</h3><p>{record.result.text ?? record.result.error ?? record.result.status}</p></div> : null}
    {record.target ? <TerminalSnapshot target={record.target.target} attachCommand={record.target.attachCommand} output={capture?.output} observedAt={capture?.observedAt} disabled={!state.available || state.pending} refresh={() => model.act(sessionId, view, "capture", record.id)} /> : <p className="muted">{t("此记录没有可读取的终端目标。", "This record has no readable terminal target.")}</p>}
    <details className="child-provenance"><summary>{t("父子运行身份", "Parent and child run IDs")}</summary><p>{t("父 Run：", "Parent Run: ")}<code>{record.parentRunId}</code></p><p>{t("子 Session：", "Child Session: ")}<code>{record.childSessionId}</code></p><p>{t("子 Run：", "Child Run: ")}<code>{record.childRunId}</code></p></details>
  </article>;
}
function InlineChild({ model, block }: { model: FeaturesClientModel; block: LedgerBlock }) {
  const t = useText();
  const state = useSnapshot(model), view = state.views.find(item => item.key === "subagents"), data = view?.data as SubagentObservationView | undefined;
  let id: string | undefined;
  try { const value = JSON.parse(block.text); if (typeof value.agent?.id === "string") id = value.agent.id; } catch { /* Canonical transcript is safe plain text. */ }
  id ??= /^Agent: ([^\r\n]+)$/mu.exec(block.text)?.[1];
  const record = data?.kind === "subagent-observation" ? data.records.find(item => item.id === id && item.parentRunId === block.runId) : undefined;
  return <>{record && view && state.sessionId ? <SubagentEvidence model={model} view={view} sessionId={state.sessionId} record={record} /> : <p className="muted">{t("当前没有与此次调用身份匹配的子任务观察记录；保留下方原始证据。", "No subagent observation matches this call; the raw evidence remains below.")}</p>}<details className="raw-tool"><summary>{t("原始调用与结果", "Raw call and result")}</summary><GenericToolDetails block={block} /></details></>;
}
export const SubagentsClientUi = { name: "ui-subagents", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.conversationCard({ id: "subagents", order: 30,
    View: ({ sessionId }) => <SubagentConversationCard model={model} sessionId={sessionId} /> }));
  ctx.effect(() => ctx.wishUiSlots.tool({ toolName: "spawn_agent", category: { id: "child", label: "子 Agent", labelEn: "Subagents" }, View: ({ block }) => <InlineChild model={model} block={block} /> }));
} };
