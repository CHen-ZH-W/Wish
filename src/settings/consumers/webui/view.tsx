import { useEffect, useState } from "react";
import {
  settingOptionLabel,
  settingOptionValue,
  type SettingValue,
  type SettingsSection,
  type SettingsView,
} from "../../types.js";
import type { SettingsClientModel } from "./model.js";
import type { ConnectionSnapshot } from "../../../apps/webui/client/connection.js";
import { ErrorNotice, readableError, useSnapshot, type ReadableSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { useLanguage, useText } from "../../../apps/webui/client/i18n.js";

const appearanceEnglish: Record<string, { label: string; description?: string; options?: Record<string, string> }> = {
  theme: { label: "Theme", description: "Choose a light or dark appearance for Wish.", options: { light: "Light", dark: "Dark" } },
  language: { label: "Language", description: "Change interface text without translating conversations or workspace files.", options: { "zh-CN": "Chinese", "en-US": "English" } },
  "font-size": { label: "Text size", description: "Adjust text throughout the WebUI.", options: { standard: "Standard · 14 px", large: "Large · 16 px", "extra-large": "Extra large · 18 px" } },
};
const composerEnglish: Record<string, { label: string; description?: string; options?: Record<string, string> }> = {
  "busy-delivery": { label: "Enter while running", description: "Queue adds another turn; Steer is delivered at the next Step without interrupting the current tool. Both actions remain available in the conversation.", options: { queue: "Queue", steer: "Steer" } },
};

export function SettingsPage({ model, connection, title = "通用设置", description = "选择后立即应用。", namespaces }: {
  model: SettingsClientModel;
  connection: ReadableSnapshot<ConnectionSnapshot>;
  title?: string;
  description?: string;
  namespaces?: readonly string[];
}) {
  const t = useText();
  const state = useSnapshot(model), online = useSnapshot(connection).online;
  const sections = namespaces === undefined ? state.sections : namespaces.flatMap(namespace => state.sections.filter(view => view.namespace === namespace));
  return <section className="settings-page"><header className="page-heading"><div><h1>{title === "通用设置" ? t(title, "General settings") : title}</h1><p>{description === "选择后立即应用。" ? t(description, "Changes apply when selected.") : description}</p></div></header>
    <ErrorNotice text={state.error ? readableError(state.error) : null} />
    {!sections.length ? <p className="list-empty">{t("当前没有模块注册可编辑设置。", "No editable settings are registered.")}</p> : sections.map(view => <SectionEditor key={view.namespace} view={view} writable={state.writable && online && !state.pending} pending={state.pending} save={model.save} />)}
  </section>;
}

function SectionEditor({ view, writable, pending, save }: {
  view: SettingsView;
  writable: boolean;
  pending: boolean;
  save: (view: SettingsView, user: SettingsSection) => Promise<SettingsView>;
}) {
  const t = useText(), language = useLanguage();
  const [draft, setDraft] = useState<Record<string, SettingValue>>({ ...view.user });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"applying" | "applied" | "restart" | null>(null);

  useEffect(() => { setDraft({ ...view.user }); }, [view.revision]);

  async function commit(next: Record<string, SettingValue>) {
    setDraft(next);
    setError(null);
    setStatus("applying");
    try {
      const committed = await save(view, next);
      setDraft({ ...committed.user });
      setStatus(view.applies === "restart" ? "restart" : "applied");
    } catch (cause) {
      setDraft({ ...view.user });
      setStatus(null);
      setError(readableError(cause instanceof Error ? cause.message : t("设置修改失败", "Could not change the setting")));
    }
  }

  const fields = view.fields.filter(field => field.hidden !== true);
  const hasUnavailableChoice = fields.some(field => field.type === "enum" &&
    !field.options.some(option => settingOptionValue(option) === String(draft[field.key] ?? view.value[field.key])));

  const sectionTitle = language === "en-US" ? view.namespace === "webui-appearance" ? "Appearance" : view.namespace === "webui-composer" ? "Message input" : view.title : view.title;
  return <section className="settings-section"><header className="section-heading"><h2>{sectionTitle}</h2><span className="muted">{view.applies === "restart" ? t("重启后生效", "After restart") : view.applies === "next-request" ? t("下一次请求生效", "Next request") : t("立即生效", "Applies immediately")}</span></header>
    <ErrorNotice text={error} />
    {fields.map(field => {
      const value = draft[field.key] ?? view.value[field.key] ?? field.default;
      const unavailableChoice = field.type === "enum" && !field.options.some(option => settingOptionValue(option) === String(value));
      const id = `${view.namespace}-${field.key}`;
      const english = language === "en-US" ? view.namespace === "webui-appearance" ? appearanceEnglish[field.key] : view.namespace === "webui-composer" ? composerEnglish[field.key] : undefined : undefined;
      const update = (next: SettingValue) => { setDraft(current => ({ ...current, [field.key]: next })); setStatus(null); };
      const apply = (next: SettingValue) => { void commit({ ...draft, [field.key]: next }); };
      return <div className="setting-row" key={field.key}><div><label htmlFor={id}>{english?.label ?? field.label}</label>{field.description ? <p className="muted">{english?.description ?? field.description}</p> : null}</div><div className="setting-input">
        {field.type === "boolean" ? <input id={id} type="checkbox" checked={value === true} disabled={!writable} onChange={event => apply(event.target.checked)} />
          : field.type === "enum" ? <select id={id} value={String(value)} title={String(value)} disabled={!writable} onChange={event => apply(event.target.value)}>
            {unavailableChoice ? <option value={String(value)} disabled>{t("当前不可用：", "Unavailable: ")}{String(value)}</option> : null}
            {field.options.map(option => { const optionValue = settingOptionValue(option); return <option key={optionValue} value={optionValue}>{english?.options?.[optionValue] ?? settingOptionLabel(option)}</option>; })}
          </select>
            : field.type === "number" ? <input id={id} type="number" min={field.min} max={field.max} step={field.integer ? 1 : "any"} value={String(value)} disabled={!writable}
              onChange={event => update(event.target.value === "" ? "" : Number(event.target.value))}
              onBlur={() => typeof draft[field.key] === "number" && void commit(draft)}
              onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              : <input id={id} maxLength={field.maxLength} value={String(value)} disabled={!writable}
                onChange={event => update(event.target.value)} onBlur={() => { if (draft[field.key] !== undefined) void commit(draft); }}
                onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />}
      </div></div>;
    })}
    {hasUnavailableChoice ? <p className="setting-warning" role="status">{t("此前选择已不在当前配置中，请重新选择一个可用项。", "The previous choice is no longer available. Select another option.")}</p> : null}
    <p className="setting-commit-status" role="status" aria-live="polite">{pending || status === "applying" ? t("正在应用…", "Applying…") : status === "restart" ? t("已记录，重启后生效", "Saved; takes effect after restart") : status === "applied" ? t("已应用", "Applied") : ""}</p>
  </section>;
}
