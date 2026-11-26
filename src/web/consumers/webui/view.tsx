import { useState } from "react";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import { SectionEditor } from "../../../settings/consumers/webui/view.js";
import type { WebSearchSettingsModel } from "./model.js";

const fieldLabels: Readonly<Record<string, string>> = {
  "max-results": "Maximum results", "timeout-seconds": "Request timeout (seconds)",
  "max-response-bytes": "Maximum response size (bytes)",
};

export function WebSearchSettingsPage({ model }: { model: WebSearchSettingsModel }) {
  const t = useText();
  const state = useSnapshot(model), settings = useSnapshot(model.settings), management = useSnapshot(model.management), connection = useSnapshot(model.connection);
  const entries = management.data?.inspection.entries ?? [];
  const active = entries.some(entry => entry.id === "include:web-search" && entry.phase === "active");
  const [key, setKey] = useState("");
  const section = settings.sections.find(view => view.namespace === "web-search-deepseek");
  const pending = state.pending || settings.pending || management.pending;
  const disabled = pending || !connection.online || !settings.writable;
  const tool = entries.find(entry => entry.id === "include:tool-web-search");
  const enabled = active && tool?.phase === "active";
  const configured = state.credential?.configured === true;
  const running = enabled && configured;
  const target = "include:web-search";
  const canEnable = management.data?.writable && management.data.status === "ready" && [target, "include:tool-web-search"].every(id =>
    entries.some(entry => entry.id === id && entry.enabled === true) || management.data?.controls[id]?.canEnable);
  const canDisable = management.data?.writable && management.data.status === "ready" && entries.some(entry =>
    [target, "include:tool-web-search"].includes(entry.id) && management.data?.controls[entry.id]?.canDisable);
  const commitKey = () => {
    if (!key.trim()) return;
    const value = key; setKey("");
    void model.credential(value).catch(() => {});
  };
  return <section className="settings-page">
    <header className="page-heading"><div><h1>{t("网页搜索", "Web search")}</h1><p>{t("配置搜索服务；保存的参数用于下一次搜索。", "Configure a search service. Saved parameters apply to the next search.")}</p></div></header>
    <ErrorNotice text={state.error || settings.error || management.error ? readableError(state.error ?? settings.error ?? management.error!) : null} />
    <section className="settings-section">
      <header className="section-heading"><h2>{t("搜索服务", "Search service")}</h2><span role="status">{enabled ? `DeepSeek · ${running ? t("运行中", "Running") : t("待配置", "Needs configuration")}` : t("未运行", "Not running")}</span></header>
      {enabled && !configured ? <p className="notice warning">{t("请填写 DeepSeek 搜索 API 密钥。保存后即可搜索，无需重启。", "Enter the DeepSeek Search API key. Saving enables search without a restart.")}</p> : null}
      <div className="setting-row"><span>{t("服务提供方", "Provider")}</span><div className="setting-input">DeepSeek Search API</div></div>
      <div className="setting-row"><div><label htmlFor="search-api-key">{t("DeepSeek 搜索 API 密钥", "DeepSeek Search API key")}</label><p className="muted">{state.credential?.source === "environment" ? t("由启动环境提供，页面只读。", "Provided by the startup environment; read-only here.") : t("单独保存搜索密钥，不影响模型密钥。原值不会回显。", "Stored separately from model credentials. Saved values are never displayed.")}</p></div><div className="setting-input credential-input">
        <input id="search-api-key" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} onBlur={commitKey}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} disabled={disabled || !state.credential?.writable}
          placeholder={state.credential?.configured ? t("已配置；输入新值可替换", "Configured; enter a replacement") : t("输入 API 密钥", "Enter API key")} />
        {state.credential?.source === "stored" ? <button className="quiet-action" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => { setKey(""); void model.credential(null).catch(() => {}); }}>{t("清除", "Clear")}</button> : null}
      </div></div>
      <div className="setting-row"><p className="muted">{pending ? t("正在应用…", "Applying…") : t("配置可以在服务停用时编辑。启用和停用会应用到当前实例。", "Settings remain editable while stopped. Start and stop apply to this instance.")}</p><div className="setting-input">
        <button disabled={disabled || !canEnable || running} onClick={() => { void model.enable().catch(() => {}); }}>{t("启用搜索", "Enable search")}</button>
        <button disabled={disabled || !canDisable} onClick={() => { void model.disable().catch(() => {}); }}>{t("停用搜索", "Disable search")}</button>
      </div></div>
    </section>
    {section ? <SectionEditor key={section.namespace} view={{ ...section, fields: section.fields.map(field => ({ ...field, label: t(field.label, fieldLabels[field.key] ?? field.label) })) }} writable={!disabled} pending={pending} save={model.settings.save} /> : <p>{t("正在读取搜索配置…", "Loading search configuration…")}</p>}
  </section>;
}
