import { useEffect, useState } from "react";
import { ErrorNotice, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import type { CredentialStatus } from "../../../credentials/types.js";
import {
  contextWindowOverrides,
  formatCapacity,
  parseCapacity,
  tokenOverrides,
  type ModelChoice,
  type ModelsSettingsClientModel,
} from "./model.js";

const statusEnglish: Record<string, string> = {
  "正在切换…": "Switching…",
  "已应用于新运行": "Applied to new runs",
  "正在应用…": "Applying…",
  "下一次请求使用新窗口": "New window applies to the next request",
  "下一次请求使用新上限": "New limit applies to the next request",
  "正在安全写入…": "Saving securely…",
  "API 密钥已更新": "API key updated",
  "正在清除…": "Clearing…",
  "API 密钥已清除": "API key removed",
};

export function ModelsSettingsPage({ model }: { model: ModelsSettingsClientModel }) {
  const t = useText();
  const state = useSnapshot(model);
  const choice = state.choices.find(item => item.value === state.selectedModel);
  const overrides = contextWindowOverrides(state.section?.value["context-window-overrides"]);
  const outputOverrides = tokenOverrides(state.section?.value["max-output-token-overrides"]);
  return <section className="settings-page models-settings-page"><header className="page-heading"><div><h1>{t("模型配置", "Models")}</h1><p>{t("选择模型并调整它的运行参数；改动在对应边界自动应用。", "Choose a model and adjust its runtime settings. Changes apply at the appropriate boundary.")}</p></div></header>
    <ErrorNotice text={state.error ? readableError(state.error) : null} />
    {state.section === null || choice === undefined ? <p className="list-empty">{t("模型配置尚未就绪。", "Model settings are not ready yet.")}</p>
      : <ModelEditor model={model} choice={choice} selectedModel={state.selectedModel!} choices={state.choices}
        override={overrides[choice.value]} outputOverride={outputOverrides[choice.value]}
        credential={choice.apiKeyEnv === undefined ? undefined : state.credentials[choice.apiKeyEnv]}
        disabled={!state.writable || !state.online || state.pending} />}
    <p className="setting-commit-status" role="status" aria-live="polite">{state.status ? t(state.status, statusEnglish[state.status] ?? state.status) : ""}</p>
  </section>;
}

function ModelEditor({ model, choice, selectedModel, choices, override, outputOverride, credential, disabled }: {
  model: ModelsSettingsClientModel;
  choice: ModelChoice;
  selectedModel: string;
  choices: readonly ModelChoice[];
  override: number | undefined;
  outputOverride: number | undefined;
  credential: CredentialStatus | undefined;
  disabled: boolean;
}) {
  const t = useText();
  const [capacity, setCapacity] = useState(() => formatCapacity(override));
  const [outputLimit, setOutputLimit] = useState(() => formatCapacity(outputOverride));
  const [key, setKey] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  useEffect(() => { setCapacity(formatCapacity(override)); setFieldError(null); }, [choice.value, override]);
  useEffect(() => { setOutputLimit(formatCapacity(outputOverride)); setFieldError(null); }, [choice.value, outputOverride]);

  const commitCapacity = () => {
    const parsed = parseCapacity(capacity);
    if (Number.isNaN(parsed)) { setFieldError(t("请输入整数 token 数，或使用 128K、1M 这样的写法。", "Enter an integer token count, or use a value such as 128K or 1M.")); return; }
    setFieldError(null);
    if (parsed !== override) void model.setContextWindow(choice.value, parsed).catch(() => {});
  };
  const commitOutputLimit = () => {
    const parsed = parseCapacity(outputLimit);
    if (Number.isNaN(parsed) || parsed !== undefined && (parsed < 1 || parsed > 10_000_000 ||
      choice.maxOutputTokens !== undefined && parsed > choice.maxOutputTokens)) {
      setFieldError(t("请输入不超过模型支持上限的正整数 token 数。", "Enter a positive token count within this model's limit."));
      return;
    }
    setFieldError(null);
    if (parsed !== outputOverride) void model.setMaxOutputTokens(choice.value, parsed).catch(() => {});
  };
  const commitKey = () => {
    if (!key.trim()) return;
    const value = key;
    setKey("");
    setFieldError(null);
    void model.setCredential(choice.apiKeyEnv!, value).catch(error => {
      setFieldError(readableError(error instanceof Error ? error.message : t("API 密钥写入失败", "Could not save the API key")));
    });
  };

  return <section className="settings-section model-settings-section"><header className="section-heading"><h2>{t("默认模型", "Default model")}</h2><span className="muted">{t("新运行使用", "Used for new runs")}</span></header>
    <div className="setting-row"><div><label htmlFor="models-default-model">{t("模型", "Model")}</label><p className="muted">{t("当前运行和已经排队的消息不会改变。", "Current runs and queued messages are unchanged.")}</p></div><div className="setting-input"><select id="models-default-model" value={selectedModel} disabled={disabled} onChange={event => { void model.selectModel(event.target.value).catch(() => {}); }}>
      {choices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></div></div>
    <div className="setting-row"><div><label htmlFor="models-context-window">{t("上下文窗口", "Context window")}</label><p className="muted">{t("留空时使用模型目录值", "Leave empty to use the model catalog value")}{choice.contextWindowTokens === undefined ? "" : ` ${formatCapacity(choice.contextWindowTokens)}`}{t("；支持 K / M。", "; K and M are supported.")}</p></div><div className="setting-input model-setting-with-unit"><input id="models-context-window" inputMode="decimal" value={capacity} disabled={disabled} placeholder={choice.contextWindowTokens === undefined ? t("例如 128K", "e.g. 128K") : formatCapacity(choice.contextWindowTokens)}
      onChange={event => setCapacity(event.target.value)} onBlur={commitCapacity} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>tokens</span></div></div>
    <div className="setting-row"><div><label htmlFor="models-max-output">{t("单次请求最大输出", "Maximum output per request")}</label><p className="muted">{t("留空：", "Leave empty: ")}{choice.defaultMaxOutputTokens === undefined ? t("模型默认行为", "model default") : `${t("模型默认", "model default")} ${formatCapacity(choice.defaultMaxOutputTokens)}`}{choice.maxOutputTokens === undefined ? "" : ` · ${t("目录上限", "catalog limit")} ${formatCapacity(choice.maxOutputTokens)}`}{t("。", ".")}</p></div><div className="setting-input model-setting-with-unit"><input id="models-max-output" inputMode="decimal" value={outputLimit} disabled={disabled} placeholder={choice.defaultMaxOutputTokens === undefined ? t("模型默认", "Model default") : formatCapacity(choice.defaultMaxOutputTokens)}
      onChange={event => setOutputLimit(event.target.value)} onBlur={commitOutputLimit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>tokens</span></div></div>
    <CredentialRow choice={choice} credential={credential} keyValue={key} disabled={disabled} onKeyChange={setKey} onCommit={commitKey}
      onDelete={() => { setFieldError(null); void model.deleteCredential(choice.apiKeyEnv!).catch(() => {}); }} />
    <ErrorNotice text={fieldError} />
  </section>;
}

function CredentialRow({ choice, credential, keyValue, disabled, onKeyChange, onCommit, onDelete }: {
  choice: ModelChoice;
  credential: CredentialStatus | undefined;
  keyValue: string;
  disabled: boolean;
  onKeyChange(value: string): void;
  onCommit(): void;
  onDelete(): void;
}) {
  const t = useText();
  if (choice.apiKeyEnv === undefined) return <div className="setting-row"><div><span className="setting-label">{t("API 密钥", "API key")}</span><p className="muted">{t("此模型不需要 API 密钥。", "This model does not require an API key.")}</p></div><span className="credential-state">{t("无需配置", "Not required")}</span></div>;
  const environment = credential?.source === "environment";
  const stored = credential?.source === "stored";
  return <div className="setting-row"><div><label htmlFor="models-api-key">{t("API 密钥", "API key")}</label><p className="muted">{environment ? t(`由启动环境 ${choice.apiKeyEnv} 提供，网页不可覆盖。`, `Provided by the startup environment as ${choice.apiKeyEnv}; it cannot be overridden here.`) : t(`安全存放在 ${choice.apiKeyEnv} 引用下；页面不会读回原值。`, `Stored securely under the ${choice.apiKeyEnv} reference. The page cannot read back its value.`)}</p></div><div className="setting-input credential-input">
    <input id="models-api-key" type="password" autoComplete="new-password" spellCheck={false} value={keyValue} disabled={disabled || credential === undefined || environment} placeholder={stored ? t("已配置；输入新值可替换", "Configured; enter a new value to replace") : credential === undefined ? t("正在核对…", "Checking…") : t("输入 API 密钥", "Enter API key")}
      onChange={event => onKeyChange(event.target.value)} onBlur={onCommit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    {stored ? <button type="button" className="quiet-action" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onDelete}>{t("清除", "Clear")}</button> : null}
  </div></div>;
}
