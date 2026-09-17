import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage, type FeatureDocumentProps } from "../../../apps/webui/client/ui/feature.js";
import { TerminalSnapshot } from "../../../apps/webui/client/ui/terminal.js";
import { useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { SubagentObservationView } from "../observation-view.js";
import type { SubagentRecord } from "../../types.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import type { FeaturesClientModel } from "../../../apps/webui/client/model/features.js";
import { GenericToolDetails } from "../../../apps/webui/client/ui/tool.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";

const status: Record<string, string> = { starting: "启动记录", running: "运行记录", exited: "已退出记录", stopped: "已停止记录", failed: "失败记录", lost: "需要核对" };
const statusEn: Record<string, string> = { starting: "Starting record", running: "Running record", exited: "Exited record", stopped: "Stopped record", failed: "Failed record", lost: "Needs review" };
function SubagentEvidence({ model, view, sessionId, record }: FeatureDocumentProps & { record: SubagentRecord }) {
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
function SubagentsDocument(props: FeatureDocumentProps) {
  const t = useText();
  const data = props.view.data as SubagentObservationView | undefined;
  if (data?.kind !== "subagent-observation" || !Array.isArray(data.records)) return <p>{props.view.text}</p>;
  return <div className="child-list">{data.records.length ? data.records.map(record => <SubagentEvidence key={record.id} {...props} record={record} />) : <p className="list-empty">{t("这个会话尚无子 Agent 记录。", "No subagent records in this session.")}</p>}</div>;
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
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "subagents", label: "Subagents", labelEn: "Subagents", area: "workspace", View: () => <FeaturePage model={model} featureKey="subagents" title="Subagents" description="按父会话查看子 Agent 的身份、目标、结果与终端快照。" descriptionEn="Inspect subagent identities, targets, results, and terminal snapshots by parent session." empty="当前没有子 Agent 观察入口。" emptyEn="No subagent observation is available." DocumentView={SubagentsDocument} /> }));
  ctx.effect(() => ctx.wishUiSlots.tool({ toolName: "spawn_agent", category: { id: "child", label: "子 Agent", labelEn: "Subagents" }, View: ({ block }) => <InlineChild model={model} block={block} /> }));
} };
