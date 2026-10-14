import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useRef, useState } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import type { FeatureDocumentProps } from "../../../apps/webui/client/ui/feature.js";
import { TerminalSnapshot } from "../../../apps/webui/client/ui/terminal.js";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { TmuxObservationView } from "../observation-view.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";

const LIVE_SYNC_INTERVAL_MS = 1_500;

export function tmuxLiveSyncEnabled(visible: boolean, captureAvailable: boolean, targetCount: number): boolean {
  return visible && captureAvailable && targetCount > 0;
}

function TmuxDocument({ model, view, sessionId, visible }: FeatureDocumentProps & { readonly visible: boolean }) {
  const state = useSnapshot(model), data = view.data as TmuxObservationView | undefined;
  if (data?.kind !== "tmux-observation" || !Array.isArray(data.sessions)) return <p>{view.text}</p>;
  return <TmuxTerminalList model={model} view={view} sessionId={sessionId} data={data} state={state} visible={visible} />;
}

function TmuxTerminalList({ model, view, sessionId, data, state, visible }: {
  model: FeatureDocumentProps["model"]; view: FeatureDocumentProps["view"]; sessionId: string; data: TmuxObservationView; state: ReturnType<FeatureDocumentProps["model"]["getSnapshot"]>; visible: boolean;
}) {
  const t = useText(), latestView = useRef(view), captureItems = Array.isArray(data.captures) ? data.captures : [], captures = new Map(captureItems.map(capture => [capture.sessionId, capture]));
  latestView.current = view;
  const captureAvailable = view.actions.some(action => action.name === "capture");
  const deleteAvailable = view.actions.some(action => action.name === "delete");
  const syncIds = data.sessions.filter(item => {
    const capture = captures.get(item.target.sessionId);
    return item.active || capture === undefined || capture.active !== item.active;
  }).map(item => item.target.sessionId);
  const syncKey = syncIds.join("\u001f");
  useEffect(() => {
    if (!tmuxLiveSyncEnabled(visible, captureAvailable, syncIds.length)) return;
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => { timer = setTimeout(() => { void synchronize(); }, delay); };
    const synchronize = async () => {
      if (closed) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") { schedule(LIVE_SYNC_INTERVAL_MS); return; }
      for (const targetId of syncIds) {
        if (closed) return;
        try { await model.act(sessionId, latestView.current, "capture", targetId); }
        catch { break; }
      }
      if (!closed) schedule(LIVE_SYNC_INTERVAL_MS);
    };
    void synchronize();
    return () => { closed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [captureAvailable, model, sessionId, syncKey, visible]);
  return <div className="terminal-list">{!data.sessions.length ? <p className="list-empty">{t("当前 Workspace 没有保留的 tmux 终端。", "No retained tmux terminals in this workspace.")}</p> : data.sessions.map(item => <TmuxProcess key={item.target.sessionId} model={model} view={view} sessionId={sessionId} item={item} capture={captures.get(item.target.sessionId)} captureDisabled={!captureAvailable || !state.available || state.pending} deleteDisabled={!deleteAvailable || !state.available || state.pending} />)}</div>;
}

function TmuxProcess({ model, view, sessionId, item, capture, captureDisabled, deleteDisabled }: {
  model: FeatureDocumentProps["model"]; view: FeatureDocumentProps["view"]; sessionId: string; item: TmuxObservationView["sessions"][number]; capture: TmuxObservationView["captures"][number] | undefined; captureDisabled: boolean; deleteDisabled: boolean;
}) {
  const t = useText();
  const [confirming, setConfirming] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState<string | null>(null);
  async function remove() {
    setRemoving(true); setError(null);
    try { await model.act(sessionId, view, "delete", item.target.sessionId); }
    catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("终端删除失败", "Could not delete terminal"))); setRemoving(false); }
  }
  const label = item.metadata.label || item.target.sessionId;
  const deleteLabel = item.active ? t(`停止并删除 ${label}`, `Stop and delete ${label}`) : t(`删除 ${label}`, `Delete ${label}`);
  return <article className="process-record"><header><div className="tmux-process-heading"><h2 title={label}>{label}</h2><span className="record-state" data-active={item.active || undefined}>{item.active ? t("运行中", "Running") : item.exitCode === undefined ? t("已退出", "Exited") : t(`已退出 · ${item.exitCode}`, `Exited · ${item.exitCode}`)}</span></div><button type="button" className="tmux-delete-trigger" disabled={deleteDisabled || removing} aria-label={deleteLabel} title={deleteLabel} onClick={() => setConfirming(true)}><TrashIcon /></button></header><p className="tmux-process-meta"><code title={item.target.sessionId}>{item.target.sessionId}</code>{item.currentCommand ? <><span aria-hidden="true">·</span><span title={item.currentCommand}>{item.currentCommand}</span></> : null}</p>
    {confirming ? <div className="tmux-delete-confirm" role="alert"><p>{item.active ? t("这会立即停止正在运行的任务，并删除终端及其输出。", "This immediately stops the running task and deletes its terminal and output.") : t("删除后将无法再查看这次终端输出。", "After deletion, this terminal output can no longer be viewed.")}</p><div><button type="button" disabled={removing} onClick={() => setConfirming(false)}>{t("取消", "Cancel")}</button><button type="button" className="tmux-delete-action" disabled={removing} onClick={() => { void remove(); }}>{removing ? t("删除中…", "Deleting…") : item.active ? t("确认停止并删除", "Stop and delete") : t("确认删除", "Delete terminal")}</button></div></div> : null}
    <TerminalSnapshot target={item.target.target} attachCommand={item.target.attachCommand} output={capture?.output} observedAt={capture?.observedAt} active={item.active} disabled={captureDisabled || removing} refresh={() => model.act(sessionId, view, "capture", item.target.sessionId)} />
    <ErrorNotice text={error} />
  </article>;
}
function TmuxSidebar({ model, sessionId, visible }: { model: FeatureDocumentProps["model"]; sessionId: string; visible: boolean }) {
  const language = useLanguage(), t = useText(), state = useSnapshot(model);
  const current = state.sessionId === sessionId;
  const view = current ? state.views.find(item => item.key === "tmux") : undefined;
  const data = view?.data as TmuxObservationView | undefined;
  const observedAt = data?.kind === "tmux-observation" ? new Date(data.observedAt).toLocaleTimeString(language, { hour12: false }) : undefined;
  const status = state.pending ? t("正在刷新…", "Refreshing…") : observedAt ? data!.sessions.some(item => item.active) ? t(`自动同步 · ${observedAt}`, `Live · ${observedAt}`) : t(`已更新 · ${observedAt}`, `Updated · ${observedAt}`) : t("tmux 状态", "tmux status");
  return <section className="tmux-sidebar-view">
    <header className="tmux-sidebar-toolbar"><p role="status" title={status}>{status}</p><button type="button" disabled={state.pending} aria-label={state.pending ? t("正在刷新 tmux 列表", "Refreshing tmux list") : t("刷新 tmux 列表", "Refresh tmux list")} title={state.pending ? t("同步中…", "Syncing…") : t("刷新", "Refresh")} onClick={() => { void model.refresh(); }}><RefreshIcon /></button></header>
    <ErrorNotice text={state.error ? readableError(state.error) : null} />
    {!current && state.pending ? <p className="list-empty" role="status">{t("正在读取 tmux 状态…", "Loading tmux state…")}</p> : view ? <TmuxDocument key={`${sessionId}/${view.key}`} view={view} model={model} sessionId={sessionId} visible={visible} /> : <p className="list-empty">{t("当前没有 tmux 观察入口。", "No tmux observation is available.")}</p>}
  </section>;
}
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>; }
export const TmuxClientUi = { name: "ui-tmux", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.sessionSidebar({ id: "tmux", order: 30, label: "tmux", labelEn: "tmux", description: "观察当前 Workspace 中由 Wish 管理的 tmux 会话", descriptionEn: "Observe Wish-managed tmux sessions in this workspace", icon: "tmux", View: ({ sessionId, tab }) => <TmuxSidebar model={model} sessionId={sessionId} visible={tab.visible} /> }));
} };
