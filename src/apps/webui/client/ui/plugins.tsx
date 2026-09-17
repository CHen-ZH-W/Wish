import { Fragment, useEffect, useRef, useState } from "react";
import type { PluginEntryView, PluginImpactCause } from "../../../../boot/plugin-control/types.js";
import type { PluginLifecycleCollection, PluginPreference, PluginStopDisposition } from "../../../../boot/plugin-control/management-types.js";
import type { PluginManagementModel } from "../model/management.js";
import type { ConnectionSnapshot } from "../connection.js";
import { ErrorNotice, readableError, useSnapshot, type ReadableSnapshot } from "./primitives.js";
import { useText } from "../i18n.js";

const phases: Record<string, string> = { active: "运行中", pending: "等待依赖", absent: "未运行", disposed: "已退出", failed: "失败", loading: "启动中", unloading: "退出中" };
const phasesEn: Record<string, string> = { active: "Running", pending: "Waiting for dependencies", absent: "Not running", disposed: "Stopped", failed: "Failed", loading: "Starting", unloading: "Stopping" };
const gates: Record<PluginEntryView["gate"], string> = { default: "部署默认状态", enabled: "部署显式启用", disabled: "部署或用户配置停用", conditional: "由部署条件决定（表达式不对浏览器公开）" };
const gatesEn: Record<PluginEntryView["gate"], string> = { default: "Deployment default", enabled: "Explicitly enabled by deployment", disabled: "Disabled by deployment or user settings", conditional: "Determined by deployment conditions (expression not exposed to browser)" };
const dispositions: Record<PluginStopDisposition, string> = { direct: "可直接停用", drain: "需要收尾", blocked: "当前阻止", maintenance: "需要维护", restart: "需要重启" };
const dispositionsEn: Record<PluginStopDisposition, string> = { direct: "Can stop directly", drain: "Requires draining", blocked: "Currently blocked", maintenance: "Requires maintenance", restart: "Requires restart" };
type ConfigurationPresentation = "enabled" | "disabled" | "conditional";

function displayName(name: string): string { return name.replace(/^cordis:/u, ""); }
function configurationPresentation(entry: PluginEntryView, savedPreference: PluginPreference | undefined, canEnable: boolean): ConfigurationPresentation {
  if (savedPreference === "disabled") return "disabled";
  if (entry.enabled === true) return "enabled";
  return canEnable ? "disabled" : "conditional";
}
function conditionTitle(entry: PluginEntryView, t: (zh: string, en: string) => string): string {
  if (entry.enabled === null) return t("当前部署条件无法判断", "Deployment condition could not be determined");
  if (entry.gate === "disabled") return t("部署配置当前停用此插件", "Deployment currently disables this plugin");
  if (entry.gate === "conditional") return t("当前部署条件未满足", "Deployment condition is not met");
  return t("父级插件或当前运行条件未满足", "Parent plugin or runtime condition is not met");
}
function impactCause(cause: PluginImpactCause, t: (zh: string, en: string) => string): string {
  if (cause.kind === "target") return t("目标自身", "Target itself");
  if (cause.kind === "parent") return t(`随父 Fiber ${cause.fiberId} 一起退出`, `Stops with parent Fiber ${cause.fiberId}`);
  return t(`依赖服务 ${cause.service}（来自 Fiber ${cause.fiberId}）`, `Depends on service ${cause.service} from Fiber ${cause.fiberId}`);
}

export function PluginPage({ model, connection }: { model: PluginManagementModel; connection: ReadableSnapshot<ConnectionSnapshot> }) {
  const t = useText();
  const state = useSnapshot(model), status = useSnapshot(connection);
  const [query, setQuery] = useState(""), [selected, select] = useState<string | null>(null);
  const [preview, setPreview] = useState<PluginLifecycleCollection | null>(null), [checking, setChecking] = useState(false), [error, setError] = useState<string | null>(null);
  const data = state.data;
  const inspection = useRef<HTMLElement>(null);
  const [expected, setExpected] = useState<{ revision: string; instanceId: string } | null>(null);
  useEffect(() => { if (selected) inspection.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const entries = data?.inspection.entries.filter(entry => `${entry.id} ${entry.name}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const chosen = entries.find(entry => entry.id === selected);
  const stale = expected && (expected.revision !== data?.revision || expected.instanceId !== data?.inspection.instanceId);

  async function inspect(entry: PluginEntryView) {
    select(entry.id); setPreview(null); setError(null); setChecking(true);
    setExpected(data ? { revision: data.revision, instanceId: data.inspection.instanceId } : null);
    try { setPreview(await model.preview([entry.id])); }
    catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("预览失败", "Inspection failed"))); }
    finally { setChecking(false); }
  }
  async function change(entry: PluginEntryView, preference: PluginPreference) {
    if (!data) return;
    setError(null);
    try {
      await model.change([entry.id], preference, { revision: data.revision, instanceId: data.inspection.instanceId });
      if (selected === entry.id) { select(null); setPreview(null); setExpected(null); }
    } catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("操作失败", "Action failed"))); }
  }

  return <section className="settings-page">
    <header className="page-heading"><div><h1>{t("插件管理", "Plugins")}</h1><p>{t("绿色和红色状态可点击切换；灰色表示部署或运行条件不允许启用。检查只提供运行信息。", "Click a green or red status to change it. Gray means deployment or runtime conditions prevent enabling. Inspect only shows runtime information.")}</p></div></header>
    <ErrorNotice text={error ?? (state.error ? readableError(state.error) : null)} />
    {data && !data.writable ? <p className="notice warning">{t("当前配置不在可写管理范围内，或部署配置已在外部改变。仍可检查状态；请关闭 Wish、核对部署配置后重启。", "This configuration is read-only or deployment settings changed externally. You can still inspect status. Stop Wish, check the deployment configuration, then restart.")}</p> : null}
    {data?.status === "recovery-required" ? <section className="notice warning"><h2>{t("有一项操作需要恢复核对", "An action needs recovery review")}</h2><p>{t("没有自动重放启停操作。若本次进程发生了部分退出，请先关闭并重启 Wish；重启后的相关入口保持停用。", "Plugin actions were not replayed automatically. If this process partially stopped, restart Wish first; affected entries remain disabled after restart.")}</p><p><code>{data.pending?.selection.entryIds.join(", ")}</code></p><button disabled={state.pending || !status.online} onClick={() => { void model.recover().catch(cause => setError(readableError(cause.message))); }}>{t("确认保持停用并结束核对", "Keep disabled and finish review")}</button></section> : null}
    <label className="search-field">{t("筛选插件", "Filter plugins")}<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("按名称或 Entry ID 筛选", "Filter by name or Entry ID")} /></label>
    <div className="plugin-list" role="table" aria-label={t("Host 插件列表", "Host plugin list")}>
      <div className="plugin-row list-header" role="row"><span role="columnheader">{t("插件", "Plugin")}</span><span role="columnheader">{t("配置状态", "Configuration")}</span><span role="columnheader">{t("运行状态", "Runtime")}</span><span role="columnheader">{t("操作", "Action")}</span></div>
      {entries.map(entry => {
        const configuration = configurationPresentation(entry, data?.preferences[entry.id]?.preference, data?.controls[entry.id]?.canEnable === true);
        const toggleDisabled = checking || state.pending || entry.kind === "group" || !status.online || !data?.writable || data?.status !== "ready" || configuration === "conditional";
        const action = configuration === "enabled" ? t(`停用 ${entry.id}`, `Disable ${entry.id}`) : configuration === "disabled" ? t(`启用 ${entry.id}`, `Enable ${entry.id}`) : t(`条件未满足 ${entry.id}`, `Conditions not met for ${entry.id}`);
        const title = entry.kind === "group" ? t("组合容器不能在此修改", "Group containers cannot be changed here") : configuration === "conditional" ? conditionTitle(entry, t) : !data?.writable ? t("当前配置只读", "Configuration is read-only") : configuration === "enabled" ? t("点击停用", "Click to disable") : t("点击启用", "Click to enable");
        const expanded = chosen?.id === entry.id;
        return <Fragment key={entry.id}><div className={expanded ? "plugin-row inspecting" : "plugin-row"} role="row" data-entry-id={entry.id}>
            <div role="cell"><strong>{displayName(entry.name)}</strong><code>{entry.id}</code>{entry.kind === "group" ? <small>{t("组合容器", "Group container")}</small> : null}</div>
            <div role="cell" className="configuration-cell"><button className={`configuration-toggle configuration-${configuration}`} disabled={toggleDisabled} aria-label={action} aria-pressed={configuration === "enabled"} title={title} onClick={() => { void change(entry, configuration === "enabled" ? "disabled" : "enabled"); }}>{configuration === "enabled" ? t("已启用", "Enabled") : configuration === "disabled" ? t("已停用", "Disabled") : t("条件未满足", "Conditions not met")}</button></div>
            <span role="cell" className={`phase phase-${entry.phase}`}>{t(phases[entry.phase] ?? entry.phase, phasesEn[entry.phase] ?? entry.phase)}{entry.enabled === false ? t(" / gate 关闭", " / gate off") : ""}</span>
            <div role="cell"><button disabled={checking || state.pending || entry.kind === "group" || !status.online} onClick={() => { void inspect(entry); }} aria-label={t(`检查 ${entry.id}`, `Inspect ${entry.id}`)}>{t("检查", "Inspect")}</button></div>
          </div>{expanded ? <PluginInspection inspection={inspection} entry={entry} preview={preview} checking={checking} stale={!!stale} pending={state.pending}
            onClose={() => { select(null); setPreview(null); setExpected(null); }} /> : null}</Fragment>;
      })}
      {!entries.length ? <p className="list-empty">{state.loading ? t("正在读取插件状态…", "Loading plugin status…") : t("没有匹配的插件。", "No matching plugins.")}</p> : null}
    </div>
  </section>;
}

function PluginInspection({ inspection, entry, preview, checking, stale, pending, onClose }: {
  inspection: { current: HTMLElement | null };
  entry: PluginEntryView;
  preview: PluginLifecycleCollection | null;
  checking: boolean;
  stale: boolean;
  pending: boolean;
  onClose: () => void;
}) {
  const t = useText();
  return <div className="plugin-inspection-row" role="row"><section ref={inspection} role="cell" className="plugin-inspection" aria-label={t("选中插件的检查信息", "Selected plugin inspection")}>
    <header className="section-heading"><h2>{displayName(entry.name)}</h2><button onClick={onClose} disabled={pending}>{t("关闭检查", "Close inspection")}</button></header>
    <p><code>{entry.id}</code></p><p>{t("部署条件：", "Deployment condition: ")}{t(gates[entry.gate], gatesEn[entry.gate])}{t("。启用不能越过部署条件、权限或沙箱约束。", ". Enabling cannot bypass deployment conditions, permissions, or sandbox restrictions.")}</p>
    {checking ? <p role="status">{t("正在向实际资源所有者查询…", "Querying resource owners…")}</p> : preview ? <>
      <section className="inspection-section" aria-labelledby="plugin-impact-heading">
        <header className="inspection-subheading"><h3 id="plugin-impact-heading">{t("停用影响", "Disable impact")}</h3><span>{t(`${preview.impact.gatedEntryIds.length} 个配置 Entry · ${preview.impact.affected.length} 个运行 Fiber`, `${preview.impact.gatedEntryIds.length} config entries · ${preview.impact.affected.length} running Fibers`)}</span></header>
        <p className="muted">{t("以下范围来自本次 Host 观测，不是按插件名称推测。", "This scope comes from the current Host observation, not a name-based guess.")}</p>
        <h4>{t("配置将停用", "Configuration entries to disable")}</h4>
        <ul className="impact-entry-list">{preview.impact.gatedEntryIds.map(entryId => {
          const affectedEntry = preview.observation.entries.find(item => item.id === entryId);
          return <li key={entryId}><strong>{affectedEntry ? displayName(affectedEntry.name) : entryId}</strong><code>{entryId}</code></li>;
        })}</ul>
        <h4>{t("运行中受影响", "Affected running instances")}</h4>
        {preview.impact.affected.length > 0 ? <div className="inspection-table-wrap" tabIndex={0} aria-label={t("运行中受影响表格，可横向滚动", "Affected running instances table; scroll horizontally")}><table className="inspection-table impact-table" aria-label={t("运行中受影响的 Fiber", "Affected running Fibers")}><thead><tr><th>{t("受影响实例", "Affected instance")}</th><th>{t("影响原因", "Reason")}</th></tr></thead><tbody>{preview.impact.affected.map(item => {
          const fiber = preview.observation.fibers.find(candidate => candidate.id === item.fiberId);
          const affectedEntry = fiber?.entryId ? preview.observation.entries.find(candidate => candidate.id === fiber.entryId) : undefined;
          return <tr key={item.fiberId}><td className="inspection-subject"><strong>{affectedEntry ? displayName(affectedEntry.name) : `Fiber ${item.fiberId}`}</strong><code>{fiber?.entryId ? `${fiber.entryId} · ` : ""}Fiber {item.fiberId}</code></td><td>{impactCause(item.cause, t)}</td></tr>;
        })}</tbody></table></div> : <p className="inspection-empty">{t("当前没有观测到运行中的受影响实例。", "No affected running instances were observed.")}</p>}
      </section>
      <section className="inspection-section" aria-labelledby="lifecycle-report-heading">
        <header className="inspection-subheading"><h3 id="lifecycle-report-heading">{t("生命周期报告", "Lifecycle report")}</h3><span>{t(`${preview.owners.length} 个资源所有者`, `${preview.owners.length} resource owners`)}</span></header>
        {preview.owners.length > 0 ? <div className="inspection-table-wrap" tabIndex={0} aria-label={t("生命周期报告表格，可横向滚动", "Lifecycle report table; scroll horizontally")}><table className="inspection-table owner-reports" aria-label={t("生命周期报告", "Lifecycle report")}><thead><tr><th>{t("资源所有者", "Resource owner")}</th><th>{t("处理方式", "Disposition")}</th><th>{t("报告", "Report")}</th></tr></thead><tbody>{preview.owners.map(owner => {
          const ownerEntry = owner.entryId ? preview.observation.entries.find(item => item.id === owner.entryId) : undefined;
          const counts = Object.entries(owner.status.counts ?? {});
          return <tr key={owner.registrationId}><td className="inspection-subject"><strong>{ownerEntry ? displayName(ownerEntry.name) : owner.entryId ?? `Fiber ${owner.fiberId}`}</strong><code>{owner.entryId ? `${owner.entryId} · ` : ""}Fiber {owner.fiberId}</code></td><td className="lifecycle-method"><span>{t(dispositions[owner.status.disposition], dispositionsEn[owner.status.disposition])}</span><code>{owner.status.disposition}</code></td><td className="lifecycle-report"><code>{owner.status.code}</code>{counts.length > 0 ? <span className="report-counts">{counts.map(([name, value]) => <code key={name}>{name}: {value}</code>)}</span> : null}</td></tr>;
        })}</tbody></table></div> : <p className="inspection-empty">{t("此条目没有活动资源所有者报告。未运行不等于已经确认清理完成。", "This entry has no active resource-owner report. Not running does not prove cleanup is complete.")}</p>}
      </section>
    </> : null}
    <p className="inspection-footnote">{t("检查只提供当前观测信息。Host 会在实际停用前重新核对条件；不会自动强杀工作或删除历史。", "Inspection shows the current observation only. Host rechecks conditions before stopping a plugin; it does not force-kill work or delete history.")}</p>
    {stale ? <p className="notice warning">{t("检查后 Host 或配置版本已改变。请关闭本次检查，重新检查后再查看。", "Host or configuration changed after inspection. Close this view and inspect again.")}</p> : null}
  </section></div>;
}
