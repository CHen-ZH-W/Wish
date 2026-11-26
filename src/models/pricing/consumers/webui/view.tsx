import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useLanguage, useText } from "../../../../apps/webui/client/i18n.js";
import { useSnapshot } from "../../../../apps/webui/client/ui/primitives.js";
import type { SessionModelUsageView } from "../webui-types.js";
import type { ModelUsageClientModel } from "./model.js";

export function ModelUsageStatus({
  model,
  sessionId,
}: {
  model: ModelUsageClientModel;
  sessionId: string;
}) {
  const state = useSnapshot(model);
  const view = state.sessionId === sessionId ? state.view : null;
  if (!view || view.attempts.completed === 0) return null;
  return <ModelUsagePopover key={sessionId} view={view} />;
}

function ModelUsagePopover({ view }: { view: SessionModelUsageView }) {
  const t = useText(), language = useLanguage();
  const id = `model-usage-${useId().replaceAll(":", "")}`;
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const restoreOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const partial = view.coverage === "partial";
  const percent = view.cacheHitRatio === undefined ? null : formatPercent(view.cacheHitRatio, language);
  const compact = percent === null
    ? t("缓存 —", "Cache —")
    : t(`缓存命中 ${percent}${partial ? " · 部分" : ""}`, `Cache hit ${percent}${partial ? " · Partial" : ""}`);
  const number = new Intl.NumberFormat(language);
  const position = useCallback(() => {
    const anchor = trigger.current, node = panel.current;
    if (!anchor || !node) return;
    const box = anchor.getBoundingClientRect(), width = Math.min(312, window.innerWidth - 32);
    const height = node.offsetHeight || 360;
    node.style.left = `${Math.max(16, Math.min(box.right - width, window.innerWidth - width - 16))}px`;
    node.style.top = `${Math.max(8, box.top - height - 8)}px`;
  }, []);
  useEffect(() => {
    const node = panel.current;
    if (restoreOpen.current && node) { node.showPopover(); queueMicrotask(position); }
    return () => {
      restoreOpen.current = !!node?.matches(":popover-open");
      if (restoreOpen.current) node!.hidePopover();
    };
  }, [position]);

  return <div className="model-usage-anchor">
    <button ref={trigger} className="model-usage-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={id} popoverTarget={id} title={t("查看本会话模型用量", "View model usage for this session")}
      onClick={() => queueMicrotask(position)}>
      <DatabaseIcon /><span>{compact}</span>
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("本会话模型用量", "Model usage for this session")}
      className="model-usage-popover" onToggle={event => {
        const shown = event.currentTarget.matches(":popover-open"); setOpen(shown);
        if (shown) queueMicrotask(position);
      }}>
      <header><div><strong>{t("本会话模型用量", "Model usage")}</strong><span>{t("会话累计", "Session total")}</span></div><DatabaseIcon /></header>
      <dl>
        {percent === null ? null : <UsageRow label={t("缓存命中率", "Cache hit rate")} value={percent} />}
        <UsageRow label={t("输入 Token", "Input tokens")} value={number.format(view.tokens.input)} />
        {view.tokens.cachedInput === undefined ? null : <UsageRow label={t("缓存读取", "Cache read")} value={number.format(view.tokens.cachedInput)} />}
        {view.tokens.cacheWriteInput === undefined ? null : <UsageRow label={t("缓存写入", "Cache write")} value={number.format(view.tokens.cacheWriteInput)} />}
        {view.tokens.uncachedInput === undefined ? null : <UsageRow label={t("未缓存输入", "Uncached input")} value={number.format(view.tokens.uncachedInput)} />}
        <UsageRow label={t("输出 Token", "Output tokens")} value={number.format(view.tokens.output)} />
        <UsageRow label={t("总 Token", "Total tokens")} value={number.format(view.tokens.total)} />
      </dl>
      <div className="model-usage-coverage">
        <span>{t("已完成请求", "Completed requests")} <strong>{number.format(view.attempts.completed)}</strong></span>
        <span>{t("缓存明细", "Cache details")} <strong>{number.format(view.attempts.cacheReadReported)}/{number.format(view.attempts.completed)}</strong></span>
      </div>
      {view.coverage === "partial" ? <p>{t("部分已完成请求未报告缓存明细；命中率只覆盖可核对请求。", "Some completed requests did not report cache details. The rate covers verifiable requests only.")}</p> : null}
      {view.coverage === "unavailable" ? <p>{t("Provider 未报告可计算命中率的缓存读取明细。", "The Provider did not report cache-read details needed to calculate a hit rate.")}</p> : null}
      {view.attempts.usageReported < view.attempts.completed ? <p>{t("Token 合计不包含未报告用量的已完成请求。", "Token totals exclude completed requests that did not report usage.")}</p> : null}
    </div>
  </div>;
}

function UsageRow({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function DatabaseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3Zm0 0v6c0 2 3.6 3 8 3s8-1 8-3V6M4 12v6c0 2 3.6 3 8 3s8-1 8-3v-6" /></svg>;
}

export function formatPercent(ratio: number, language: string): string {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return "—";
  const percent = ratio * 100;
  if (percent === 100) return "100%";
  const whole = Math.round(percent);
  if (whole < 100) return new Intl.NumberFormat(language).format(whole) + "%";
  // A partial hit must never be rounded into a visually full hit.
  for (let digits = 1; digits <= 15; digits++) {
    const rounded = Number(percent.toFixed(digits));
    if (rounded < 100) {
      return new Intl.NumberFormat(language, { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(rounded) + "%";
    }
  }
  return "<100%";
}
