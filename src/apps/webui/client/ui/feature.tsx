import { useState, type ComponentType } from "react";
import type { SessionFeatureView } from "../../../session-features.js";
import type { FeaturesClientModel } from "../model/features.js";
import { ErrorNotice, readableError, useSnapshot } from "./primitives.js";
import { useLanguage, useText } from "../i18n.js";

/** Shared presentation primitive; module adapters choose keys, copy and registrations. */
export interface FeatureDocumentProps { readonly model: FeaturesClientModel; readonly view: SessionFeatureView; readonly sessionId: string }
export function FeaturePage({ model, featureKey, title, titleEn, description, descriptionEn, empty, emptyEn, DocumentView }: { model: FeaturesClientModel; featureKey: string; title: string; titleEn?: string; description: string; descriptionEn?: string; empty: string; emptyEn?: string; DocumentView?: ComponentType<FeatureDocumentProps> }) {
  const language = useLanguage(), t = useText();
  const state = useSnapshot(model), view = state.views.find(item => item.key === featureKey);
  return <section className="settings-page feature-page"><header className="page-heading"><div><h1>{language === "en-US" ? titleEn ?? title : title}</h1><p>{language === "en-US" ? descriptionEn ?? description : description}</p></div><button onClick={() => { void model.refresh(); }} disabled={state.pending}>{t("刷新状态", "Refresh status")}</button></header>
    <ErrorNotice text={state.error ? readableError(state.error) : null} />
    {!state.sessionId ? <p className="notice">{t("请先在执行工作区选择或创建会话。", "Choose or create a session in the workspace first.")}</p> : view ? DocumentView ? <DocumentView key={`${state.sessionId}/${view.key}`} view={view} model={model} sessionId={state.sessionId} /> : <FeatureContent key={`${state.sessionId}/${view.key}`} view={view} model={model} sessionId={state.sessionId} /> : <p className="list-empty">{language === "en-US" ? emptyEn ?? empty : empty}</p>}
  </section>;
}
function FeatureContent({ model, view, sessionId }: { model: FeaturesClientModel; view: SessionFeatureView; sessionId: string }) {
  const t = useText(), language = useLanguage();
  const state = useSnapshot(model), [feedback, setFeedback] = useState(""), [error, setError] = useState<string | null>(null), [result, setResult] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ view: SessionFeatureView; action: string; label: string } | null>(null);
  const stale = confirm && JSON.stringify(confirm.view.token) !== JSON.stringify(view.token);
  async function act() {
    if (!confirm) return; setError(null); setResult(null);
    try { await model.act(sessionId, confirm.view, confirm.action, feedback); setConfirm(null); setFeedback(""); setResult(t("操作已由 Host 接收，显示内容已重新读取。", "Host accepted the action. The content has been reloaded.")); }
    catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("操作失败", "Action failed"))); }
  }
  return <div className="feature-content"><h2>{language === "en-US" ? view.titleEn ?? view.title : view.title}</h2><pre className="feature-document">{language === "en-US" ? view.textEn ?? view.text : view.text}</pre><ErrorNotice text={error} />{result ? <p className="notice" role="status">{result}</p> : null}
    {view.actions.some(item => item.feedback) ? <label className="feature-feedback">{t("补充说明或要求", "Additional instructions")}<textarea rows={3} maxLength={16384} value={feedback} onChange={event => setFeedback(event.target.value)} /></label> : null}
    <div className="actions">{view.actions.map(action => <button key={action.name} disabled={!state.available || state.pending} onClick={() => { setConfirm({ view, action: action.name, label: language === "en-US" ? action.labelEn ?? action.label : action.label }); setError(null); setResult(null); }}>{language === "en-US" ? action.labelEn ?? action.label : action.label}</button>)}</div>
    {confirm ? <section className="notice feature-confirm" aria-label={t("模块操作确认", "Confirm module action")}><p>{t(`确认执行“${confirm.label}”？操作针对你刚才查看的版本。`, `Run “${confirm.label}”? This applies to the version you just reviewed.`)}</p>{stale ? <p>{t("内容已变化，请取消确认并重新检查。", "Content changed. Cancel and review it again.")}</p> : null}<div className="actions"><button className="primary" disabled={!!stale || state.pending || !state.available} onClick={() => { void act(); }}>{t("确认操作", "Confirm action")}</button><button disabled={state.pending} onClick={() => setConfirm(null)}>{t("取消", "Cancel")}</button></div></section> : null}
  </div>;
}
