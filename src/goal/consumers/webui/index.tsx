import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useState } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import type { SessionFeatureView } from "../../../apps/session-features.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";
import type { FeaturesClientModel } from "../../../apps/webui/client/model/features.js";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { GoalPhase, GoalView } from "../../types.js";

function GoalConversationCard({ model, sessionId }: { readonly model: FeaturesClientModel; readonly sessionId: string }) {
  const language = useLanguage(), t = useText(), state = useSnapshot(model);
  const view = state.sessionId === sessionId ? state.views.find(item => item.key === "goal") : undefined;
  const goal = parseGoalView(view?.data);
  const [confirm, setConfirm] = useState<{ readonly view: SessionFeatureView; readonly action: string; readonly label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setConfirm(null); setError(null); }, [sessionId, goal?.id]);
  if (!view || !goal) return null;
  const stale = confirm !== null && JSON.stringify(confirm.view.token) !== JSON.stringify(view.token);
  const phase = phaseLabel(goal.phase, language);
  const activation = goal.activation === "armed" ? t("已启用", "Enabled") : t("未启用", "Disabled");
  async function act() {
    if (!confirm) return;
    setError(null);
    try { await model.act(sessionId, confirm.view, confirm.action, ""); setConfirm(null); }
    catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("操作失败", "Action failed"))); }
  }
  return <section className="conversation-card goal-card" aria-labelledby={`goal-card-title-${sessionId}`}>
    <header><h2 id={`goal-card-title-${sessionId}`}>Goal</h2><span className="goal-phase" data-phase={goal.phase}>{phase}</span></header>
    <p className="goal-objective">{goal.objective}</p>
    <dl><div><dt>{t("轮次", "Rounds")}</dt><dd>{goal.roundsStarted}<span aria-hidden="true"> / </span>{goal.maxGoalRounds}</dd></div><div><dt>{t("自动继续", "Auto continue")}</dt><dd>{activation}</dd></div></dl>
    {goal.blockedReason ? <p className="goal-blocked"><strong>{t("阻塞原因", "Blocked")}</strong><span>{goal.blockedReason.message}</span></p> : null}
    <ErrorNotice text={error} />
    {view.actions.length ? <div className="goal-card-actions">{view.actions.map(action => { const label = language === "en-US" ? action.labelEn ?? action.label : action.label; return <button key={action.name} className={action.name === "clear" ? "goal-card-clear" : undefined} disabled={!state.available || state.pending} onClick={() => { setConfirm({ view, action: action.name, label }); setError(null); }}>{label}</button>; })}</div> : null}
    {confirm ? <section className="goal-card-confirm" aria-label={t("确认 Goal 操作", "Confirm Goal action")}><p>{t(`确认“${confirm.label}”当前 Goal？`, `${confirm.label} this Goal?`)}</p>{stale ? <p>{t("Goal 已变化，请取消后重新确认。", "The Goal changed. Cancel and review it again.")}</p> : null}<div><button className={confirm.action === "clear" ? "goal-card-confirm-clear" : "primary"} disabled={stale || state.pending || !state.available} onClick={() => { void act(); }}>{t("确认", "Confirm")}</button><button disabled={state.pending} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</button></div></section> : null}
  </section>;
}

function phaseLabel(phase: GoalPhase, language: "zh-CN" | "en-US"): string {
  const labels: Record<GoalPhase, readonly [string, string]> = { active: ["进行中", "Active"], paused: ["已暂停", "Paused"], blocked: ["已阻塞", "Blocked"], complete: ["已完成", "Complete"] };
  return labels[phase][language === "en-US" ? 1 : 0];
}

function parseGoalView(value: unknown): GoalView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Partial<GoalView>;
  if (goal.schemaVersion !== 1 || typeof goal.id !== "string" || typeof goal.objective !== "string" || !["active", "paused", "blocked", "complete"].includes(goal.phase ?? "") || !["armed", "disarmed"].includes(goal.activation ?? "") || !Number.isSafeInteger(goal.revision) || !Number.isSafeInteger(goal.roundsStarted) || !Number.isSafeInteger(goal.maxGoalRounds)) return undefined;
  if (goal.blockedReason !== undefined && (typeof goal.blockedReason.code !== "string" || typeof goal.blockedReason.message !== "string")) return undefined;
  return goal as GoalView;
}

export const GoalClientUi = {
  name: "ui-goal",
  inject: ["wishFeatures", "wishSession", "wishUiSlots"],
  apply(ctx: Context) {
    const model = ctx.wishFeatures;
    let runId: string | null = null, sequence = 0;
    const refreshFromRun = () => {
      const run = ctx.wishSession.run.getSnapshot();
      if (run.runId !== runId) { runId = run.runId; sequence = 0; }
      const incoming = run.events.filter(event => event.sequence > sequence);
      sequence = incoming.reduce((latest, event) => Math.max(latest, event.sequence), sequence);
      if (incoming.some(event => event.type === "tool.lifecycle" && event.payload.type === "tool.completed" && (event.payload.call.name === "create_goal" || event.payload.call.name === "update_goal") || event.type === "runtime.transition" && ["user_turn.started", "user_turn.completed", "user_turn.failed", "user_turn.aborted", "run.completed", "run.failed", "run.aborted"].includes(event.payload.type))) void model.refresh();
    };
    ctx.effect(() => { const remove = ctx.wishSession.run.subscribe(refreshFromRun); refreshFromRun(); return remove; });
    ctx.effect(() => ctx.wishUiSlots.conversationCard({
      id: "goal",
      order: 10,
      View: ({ sessionId }) => <GoalConversationCard model={model} sessionId={sessionId} />,
    }));
  },
};
