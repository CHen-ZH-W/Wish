import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";
import { useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { SessionContextOccupancyView } from "../webui-types.js";
import type { ContextOccupancyClientModel } from "./model.js";

/** Unknown counts remain absent; a known zero is a valid occupancy reading. */
export function contextOccupancy(view: SessionContextOccupancyView | null) {
  if (!view || view.status === "unknown" || view.usedTokens === undefined || view.contextWindow === undefined ||
    !Number.isFinite(view.usedTokens) || view.usedTokens < 0 || !Number.isFinite(view.contextWindow) || view.contextWindow <= 0) return null;
  return { usedTokens: view.usedTokens, contextWindow: view.contextWindow,
    percent: Math.min(100, Math.round(view.usedTokens / view.contextWindow * 100)) };
}

export function ContextOccupancyStatus({ model, sessionId }: { model: ContextOccupancyClientModel; sessionId: string }) {
  const state = useSnapshot(model);
  const view = state.sessionId === sessionId ? state.view : null;
  const occupancy = contextOccupancy(view);
  if (!view || !occupancy) return null;
  return <ContextOccupancyPopover key={sessionId}
    view={view} occupancy={occupancy} />;
}

function ContextOccupancyPopover({ view, occupancy }: {
  view: SessionContextOccupancyView;
  occupancy: NonNullable<ReturnType<typeof contextOccupancy>>;
}) {
  const t = useText(), language = useLanguage();
  const id = `context-occupancy-${useId().replaceAll(":", "")}`;
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const restoreOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 });
  const reading = `~${occupancy.percent}%`;
  const title = t(`上下文约已用 ${occupancy.percent}%`, `About ${occupancy.percent}% of context used`);
  const source = view.source === "provider-anchored" ? t("用量校准", "Usage calibrated")
    : view.source === "preflight" ? t("请求计数", "Request count") : t("估算", "Estimated");
  const capturedAt = view.capturedAt === undefined ? null : new Date(view.capturedAt);
  const time = capturedAt && Number.isFinite(capturedAt.getTime())
    ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(capturedAt) : null;
  const position = useCallback(() => {
    const anchor = trigger.current, node = panel.current;
    if (!anchor || !node) return;
    const box = anchor.getBoundingClientRect(), width = Math.min(312, window.innerWidth - 32);
    const height = node.offsetHeight;
    node.style.left = `${Math.max(16, Math.min(box.right - width, window.innerWidth - width - 16))}px`;
    node.style.top = `${Math.max(8, Math.min(box.top - height - 8, window.innerHeight - height - 8))}px`;
  }, []);
  useEffect(() => {
    if (!open) return;
    position();
    const resize = new ResizeObserver(position);
    if (panel.current) resize.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { resize.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, position]);
  useEffect(() => {
    const node = panel.current;
    if (restoreOpen.current && node) { node.showPopover(); queueMicrotask(position); }
    return () => {
      // Activity pauses effects while preserving this Session's view state.
      restoreOpen.current = !!node?.matches(":popover-open");
      if (restoreOpen.current) node!.hidePopover();
    };
  }, [position]);

  return <div className="context-occupancy-anchor">
    <button ref={trigger} type="button" className="context-occupancy-trigger" aria-label={title}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} popoverTarget={id} title={title}
      onClick={() => queueMicrotask(position)}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
        <circle className="context-occupancy-track" cx="8" cy="8" r="5.5" strokeWidth="2" />
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" pathLength="100"
          strokeDasharray={`${occupancy.percent} 100`} transform="rotate(-90 8 8)" />
      </svg><span>{reading}</span>
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("上下文占用", "Context usage")}
      className="context-occupancy-popover" onToggle={event => {
        const shown = event.currentTarget.matches(":popover-open"); setOpen(shown);
        if (shown) queueMicrotask(position);
      }}>
      <header><strong>{t("上下文占用", "Context usage")}</strong><span>{reading}</span></header>
      <div className="context-occupancy-total" title={`${t("约", "About ")}${number.format(occupancy.usedTokens)} / ${number.format(occupancy.contextWindow)} Token`}>
        <strong>~{compact.format(occupancy.usedTokens)}</strong><span> / {compact.format(occupancy.contextWindow)} Token</span>
      </div>
      <div className="context-occupancy-bar" aria-hidden="true"><span style={{ width: `${occupancy.percent}%` }} /></div>
      {view.breakdown ? <dl>
        <OccupancyRow label={t("系统提示词", "System prompt")} value={`~${compact.format(view.breakdown.systemTokens)}`} />
        <OccupancyRow label={t("工具定义", "Tool definitions")} value={`~${compact.format(view.breakdown.toolsTokens)}`} />
        <OccupancyRow label={t("对话消息", "Messages")} value={`~${compact.format(view.breakdown.messageTokens)}`} />
      </dl> : null}
      <p className="context-occupancy-note">{t("占用按最近一次请求估算，分项为近似值。", "Usage is estimated from the latest request; the breakdown is approximate.")}</p>
      <footer><span>{source}</span>{time ? <time dateTime={view.capturedAt}>{time}</time> : null}</footer>
      {view.model ? <div className="context-occupancy-model" title={`${view.model.provider} / ${view.model.model}`}>{view.model.provider} / {view.model.model}</div> : null}
    </div>
  </div>;
}

function OccupancyRow({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}
