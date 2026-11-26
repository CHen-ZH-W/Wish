import { useContext, useEffect, useState, type ReactNode } from "react";
import { useText } from "../i18n.js";
import type { UiLoadingState } from "../slots.js";
import { SnapshotVisibility } from "./snapshot-visibility.js";

/** Mount readers behind one stable surface; background refreshes retain an already revealed resource. */
export function LoadingBoundary({ identity, pending, active = true, children }: { identity: string; pending: boolean; active?: boolean; children: ReactNode }) {
  const t = useText();
  const visible = useContext(SnapshotVisibility);
  const [presentation, setPresentation] = useState({ identity, revealed: !pending, delayed: false });
  const current = presentation.identity === identity ? presentation : { identity, revealed: !pending, delayed: false };
  const revealed = current.revealed || !pending;
  const delayed = current.delayed && pending;
  if (current !== presentation || revealed !== current.revealed || delayed !== current.delayed) setPresentation({ ...current, revealed, delayed });
  useEffect(() => {
    if (revealed) return;
    const timer = setTimeout(() => setPresentation(value => value.identity === identity ? { ...value, revealed: true, delayed: true } : value), 25_000);
    return () => clearTimeout(timer);
  }, [identity, revealed]);
  return <div className="view-loading-boundary" data-view-loading={revealed ? "ready" : "pending"} aria-busy={!revealed}>
    {delayed ? <p className="notice warning" role="status">{t("页面读取较慢，正在显示当前可用内容；连接恢复后会继续核对。", "Loading is taking longer. Available content is shown while Wish continues checking the connection.")}</p> : null}
    <div className="view-loading-content" inert={!revealed}><SnapshotVisibility.Provider value={visible && active}>{children}</SnapshotVisibility.Provider></div>
    {!revealed ? <div className="view-loading-status" role="status"><span className="wish-loading-spinner" aria-hidden="true" /><span className="sr-only">{t("加载中…", "Loading…")}</span></div> : null}
  </div>;
}

/** Combine only the active page's owner-declared reads. */
export function pageLoading(states: readonly UiLoadingState[], panelId: string): { identity: string; pending: boolean } {
  const relevant = states.filter(state => state.panels.includes(panelId)).sort((left, right) => left.id.localeCompare(right.id));
  return { identity: JSON.stringify(relevant.map(state => [state.id, state.key])), pending: relevant.some(state => state.pending) };
}
