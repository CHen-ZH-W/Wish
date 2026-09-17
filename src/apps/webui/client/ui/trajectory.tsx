import type { Context } from "@deepseek-ai/cordis";
import type {} from "../plugins.js";
import type { SessionClientModel } from "../model/session.js";
import { useSnapshot } from "./primitives.js";
import { useText } from "../i18n.js";
export const TrajectoryClientUi = { name: "ui-trajectory", inject: ["wishSession", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishSession;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "trajectory", label: "执行轨迹", labelEn: "Trajectory", area: "workspace", View: () => <Trajectory model={model} /> }));
} };
function Trajectory({ model }: { model: SessionClientModel }) {
  const t = useText();
  const state = useSnapshot(model.run);
  const events = state.events.filter(event => event.type !== "model.stream" || !["text_delta", "reasoning_delta"].includes(event.payload.type));
  return <section className="settings-page"><header className="page-heading"><div><h1>{t("执行轨迹", "Trajectory")}</h1><p>{t("当前观察 Run 的有界事件窗口。刷新页面或进程重启后，不声称保留完整轨迹。", "A bounded event window for the current run. Reloading or restarting does not preserve a complete trajectory.")}</p></div></header>
    {state.runId ? <p className="muted"><code>{state.runId}</code></p> : <p className="notice">{t("尚未观察到运行。请在执行记录中发起或查看活动 Run。", "No run observed yet. Start or inspect an active run in Activity.")}</p>}
    {state.gap ? <p className="notice warning">{t("事件窗口存在缺口，不能据此证明早期步骤没有执行。", "The event window has gaps; this does not prove earlier steps were never executed.")}</p> : null}
    <div className="trajectory-list">{events.map(event => <details key={event.sequence}><summary><span>{event.sequence}</span><strong>{event.payload.type}</strong><code>{event.stepId ?? "Run"}</code></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div>
  </section>;
}
