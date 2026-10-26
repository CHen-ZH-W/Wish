import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useLanguage, useText } from "../../../../apps/webui/client/i18n.js";
import { useSnapshot } from "../../../../apps/webui/client/ui/primitives.js";
import type { SessionModelUsageView } from "../webui-types.js";
import type { ModelUsageClientModel } from "./model.js";

type SessionCost = NonNullable<SessionModelUsageView["cost"]>;
type CurrencyCost = SessionCost["currencies"][number];

/** Displays settled Host costs; the browser never selects a rate or recalculates usage. */
export function ModelCostStatus({ model, sessionId }: { model: ModelUsageClientModel; sessionId: string }) {
  const state = useSnapshot(model);
  const view = state.sessionId === sessionId ? state.view : null;
  if (!view) return null;
  return <ModelCostPopover key={sessionId} cost={view.cost} />;
}

function ModelCostPopover({ cost }: { cost: SessionModelUsageView["cost"] | undefined }) {
  const t = useText(), language = useLanguage();
  const id = `model-cost-${useId().replaceAll(":", "")}`;
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const restoreOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const number = new Intl.NumberFormat(language);
  const partial = cost?.coverage === "partial";
  const currencies = cost?.currencies ?? [];
  const compact = currencies.length > 0
    ? currencies.map(item => `${item.estimated ? t("约 ", "~") : ""}${formatCost(item.totalCost, item.currency, language)}`).join(" · ")
    : "—";
  const reading = t(`费用 ${compact}${partial ? " · 部分" : ""}`, `Cost ${compact}${partial ? " · Partial" : ""}`);
  const title = t("查看本会话累计费用", "View accumulated cost for this session");
  const position = useCallback(() => {
    const anchor = trigger.current, node = panel.current;
    if (!anchor || !node) return;
    const box = anchor.getBoundingClientRect(), width = Math.min(336, window.innerWidth - 32);
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
    window.addEventListener("scroll", position, { capture: true, passive: true });
    return () => { resize.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, position]);
  useEffect(() => {
    const node = panel.current;
    if (restoreOpen.current && node) { node.showPopover(); queueMicrotask(position); }
    return () => {
      restoreOpen.current = !!node?.matches(":popover-open");
      if (restoreOpen.current) node!.hidePopover();
    };
  }, [position]);

  return <div className="model-cost-anchor">
    <button ref={trigger} type="button" className="model-cost-trigger" title={title}
      aria-label={`${reading}, ${title}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      popoverTarget={id} onClick={() => queueMicrotask(position)}><span>{reading}</span></button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={t("本会话累计费用", "Accumulated session cost")}
      className="model-cost-popover" onToggle={event => {
        const shown = event.currentTarget.matches(":popover-open"); setOpen(shown);
        if (shown) queueMicrotask(position);
      }}>
      <header><strong>{t("本会话累计费用", "Accumulated session cost")}</strong>
        {partial ? <span>{t("部分", "Partial")}</span> : null}</header>
      {currencies.map(item => <CurrencyBreakdown key={item.currency} item={item} />)}
      {currencies.length === 0 ? <p className="model-cost-empty">{cost && cost.settledAttempts === 0
        ? t("尚无可计费的已结算请求。", "No settled requests with a cost yet.")
        : t("费用暂不可用；缺少请求用量或对应价格。", "Cost is unavailable: request usage or matching prices are missing.")}</p> : null}
      {cost ? <dl className="model-cost-coverage">
        <CostRow label={t("已计费请求", "Priced requests")} value={`${number.format(cost.pricedAttempts)} / ${number.format(cost.settledAttempts)}`} />
        {cost.unavailableAttempts > 0 ? <CostRow label={t("费用缺失", "Cost unavailable")} value={number.format(cost.unavailableAttempts)} /> : null}
        {cost.runningAttempts > 0 ? <CostRow label={t("请求进行中", "Requests in progress")} value={number.format(cost.runningAttempts)} /> : null}
      </dl> : null}
      <p className="model-cost-note">{t("按请求当时的用量与价格计算，按币种分别累计。", "Calculated from each request’s usage and price at that time; currencies are totaled separately.")}</p>
      {cost && cost.unavailableAttempts > 0 ? <p className="model-cost-note">{t("合计不含费用缺失的请求。", "Totals exclude requests whose cost is unavailable.")}</p> : null}
      {cost && cost.runningAttempts > 0 ? <p className="model-cost-note">{t("进行中的请求会在结算后计入。", "In-progress requests are added after settlement.")}</p> : null}
      <footer>{t("用于核对本会话的模型调用费用，账户账单以服务商为准。", "For reviewing this session’s model calls. Your provider’s account bill is authoritative.")}</footer>
    </div>
  </div>;
}

function CurrencyBreakdown({ item }: { item: CurrencyCost }) {
  const t = useText(), language = useLanguage();
  const number = new Intl.NumberFormat(language);
  const money = (value: number) => formatCost(value, item.currency, language);
  return <section className="model-cost-currency" aria-label={item.currency}>
    <div className="model-cost-subtotal"><span>{item.currency}</span>
      <strong>{item.estimated ? t("约 ", "~") : ""}{money(item.totalCost)}</strong></div>
    <dl>
      <CostRow label={t("未缓存输入", "Uncached input")} value={money(item.uncachedInputCost)} />
      <CostRow label={t("缓存读取", "Cache read")} value={money(item.cachedInputCost)} />
      <CostRow label={t("缓存写入", "Cache write")} value={money(item.cacheWriteInputCost)} />
      <CostRow label={t("输出", "Output")} value={money(item.outputCost)} />
    </dl>
    <div className="model-cost-periods">
      <h3>{t("计费时段", "Billing periods")}</h3>
      <dl>{item.periods.map(period => <CostRow key={period.period}
        label={`${periodLabel(period.period, language)} · ${number.format(period.attempts)} ${t("次", "calls")}`}
        value={`${period.estimated ? t("约 ", "~") : ""}${money(period.totalCost)}`} />)}</dl>
    </div>
    {item.estimated ? <p className="model-cost-estimate">{t("含估算费用。", "Includes estimated costs.")}</p> : null}
  </section>;
}

function CostRow({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

export function periodLabel(period: string, language: string): string {
  const zh = language.startsWith("zh");
  return period === "peak" ? zh ? "峰时" : "Peak"
    : period === "off_peak" ? zh ? "谷时" : "Off-peak"
    : period === "flat" ? zh ? "固定价" : "Flat rate"
    : period === "unknown" ? zh ? "时段未记录" : "Period not recorded" : period;
}

/** Retain four decimal places and show a bound for positive sub-unit costs. */
export function formatCost(value: number, currency: string, language: string): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const small = value > 0 && value < 0.0001;
  const amount = small ? 0.0001 : value;
  try {
    return `${small ? "<" : ""}${new Intl.NumberFormat(language, {
      style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 4,
    }).format(amount)}`;
  } catch {
    return `${small ? "<" : ""}${currency} ${new Intl.NumberFormat(language, { maximumFractionDigits: 4 }).format(amount)}`;
  }
}
