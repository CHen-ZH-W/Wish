import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage, type FeatureDocumentProps } from "../../../apps/webui/client/ui/feature.js";
import { TerminalSnapshot } from "../../../apps/webui/client/ui/terminal.js";
import { useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { TmuxObservationView } from "../observation-view.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";

function TmuxDocument({ model, view, sessionId }: FeatureDocumentProps) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), data = view.data as TmuxObservationView | undefined;
  if (data?.kind !== "tmux-observation" || !Array.isArray(data.sessions)) return <p>{view.text}</p>;
  return <div className="terminal-list"><p className="muted">{t("仅当前 Workspace 的 Wish 管理会话 · 列表核对于 ", "Wish-managed sessions in this workspace only · checked at ")}{new Date(data.observedAt).toLocaleTimeString(language, { hour12: false })}</p>
    {!data.sessions.length ? <p className="list-empty">{t("当前 Workspace 没有可观察的 tmux 会话。", "No observable tmux sessions in this workspace.")}</p> : data.sessions.map(item => {
      const capture = data.capture?.sessionId === item.target.sessionId ? data.capture : undefined;
      return <article className="process-record" key={item.target.sessionId}><header><h2>{item.metadata.label || item.target.sessionId}</h2><span className="record-state">{item.active ? t("观察时运行中", "Running when observed") : t("观察时已退出", "Exited when observed")}</span></header><p><code>{item.target.sessionId}</code>{item.currentCommand ? ` · ${item.currentCommand}` : ""}</p>
        <TerminalSnapshot target={item.target.target} attachCommand={item.target.attachCommand} output={capture?.output} observedAt={capture?.observedAt} disabled={!state.available || state.pending} refresh={() => model.act(sessionId, view, "capture", item.target.sessionId)} />
      </article>;
    })}</div>;
}
export const TmuxClientUi = { name: "ui-tmux", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "tmux", label: "tmux", labelEn: "tmux", area: "workspace", View: () => <FeaturePage model={model} featureKey="tmux" title="tmux" description="发现可观察进程，按需读取快照，或在本机终端 attach 到同一会话。" descriptionEn="Find observable processes, read snapshots, or attach to the same session in your local terminal." empty="当前没有 tmux 观察入口。" emptyEn="No tmux observation is available." DocumentView={TmuxDocument} /> }));
} };
