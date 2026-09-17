import { readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { ModelReasoningEffort } from "../../types.js";
import type { ReasoningClientModel } from "./reasoning-model.js";
import type { NewSessionReasoningClientModel } from "./new-session-reasoning-model.js";
import { useText } from "../../../apps/webui/client/i18n.js";

const labels: Record<ModelReasoningEffort, string> = {
  none: "关闭",
  low: "低",
  high: "高",
  max: "极高",
};

/** Optional Models contribution in the conversation composer. */
export function ReasoningComposerItem({ model, sessionId, busy }: { model: ReasoningClientModel; sessionId: string; busy: boolean }) {
  const t = useText();
  const state = useSnapshot(model);
  if (state.sessionId !== sessionId) return null;
  const view = state.view;
  if (view === null && !state.loading) return state.error
    ? <span className="composer-reasoning-error" role="alert">{reasoningError(state.error, t)}</span>
    : null;
  if (view !== null && view.control === undefined) return null;
  const title = busy
    ? t("下次新运行生效；当前运行、引导和已排队消息保持原强度", "Applies to the next new run; this run, steering, and queued messages keep their current level")
    : t("下次新运行生效", "Applies to the next new run");
  return <div className="composer-reasoning" title={title}>
    <span className="composer-model-name" title={view ? `${view.model.provider}/${view.model.model}` : t("正在读取模型", "Loading model")}>{view?.model.model ?? t("模型", "Model")}</span>
    <label className="sr-only" htmlFor="wish-reasoning-effort">{t("思考强度", "Reasoning effort")}</label>
    <select id="wish-reasoning-effort" aria-label={t("下次运行的思考强度", "Reasoning effort for the next run")} value={view?.selected ?? view?.control?.defaultEffort ?? ""}
      disabled={!view || state.pending || state.loading}
      onChange={event => { void model.select(event.target.value as ModelReasoningEffort).catch(() => {}); }}>
      {!view?.control ? <option value="" disabled>{t("读取中", "Loading")}</option> : null}
      {view?.control?.efforts.map(effort => <option key={effort} value={effort}>{t(labels[effort], ({ none: "Off", low: "Low", high: "High", max: "Max" } as const)[effort])}</option>)}
    </select>
    {state.pending ? <span className="composer-reasoning-status" role="status">{t("设置中", "Applying")}</span> : state.error ? <span className="composer-reasoning-error" role="alert">{reasoningError(state.error, t)}</span> : state.status ? <span className="sr-only" role="status">{t(state.status, "Applies to the next new run")}</span> : null}
  </div>;
}

/** Same Models-owned control in the first-message composer, before a Host Session exists. */
export function NewSessionReasoningComposerItem({ model, disabled }: { model: NewSessionReasoningClientModel; disabled: boolean }) {
  const t = useText();
  const state = useSnapshot(model), view = state.view;
  if (view !== null && view.control === undefined) return null;
  return <div className="composer-reasoning new-session-reasoning" title={t("所选强度从首个运行开始生效", "The selected effort applies from the first run")}>
    <span className="composer-model-name" title={view ? `${view.model.provider}/${view.model.model}` : t("正在读取模型", "Loading model")}>{view?.model.model ?? t("模型", "Model")}</span>
    <label className="sr-only" htmlFor="wish-new-session-reasoning-effort">{t("思考强度", "Reasoning effort")}</label>
    <select id="wish-new-session-reasoning-effort" aria-label={t("首个运行的思考强度", "Reasoning effort for the first run")} value={state.selected ?? view?.control?.defaultEffort ?? ""}
      disabled={disabled || !view?.control || state.loading}
      onChange={event => model.select(event.target.value as ModelReasoningEffort)}>
      {!view?.control ? <option value="" disabled>{state.error ? t("不可用", "Unavailable") : t("读取中", "Loading")}</option> : null}
      {view?.control?.efforts.map(effort => <option key={effort} value={effort}>{t(labels[effort], ({ none: "Off", low: "Low", high: "High", max: "Max" } as const)[effort])}</option>)}
    </select>
    {state.error ? <span className="composer-reasoning-error" role="alert" title={reasoningError(state.error, t)}>{reasoningError(state.error, t)}</span> : null}
  </div>;
}

function reasoningError(code: string, t: (zh: string, en: string) => string): string {
  if (code === "model_selection_changed") return t("默认模型已变化，请重新选择", "Default model changed; choose again");
  if (code === "model_selection_conflict") return t("设置已被修改，请重试", "Setting changed; try again");
  if (code === "model_reasoning_unsupported") return t("当前模型不支持该强度", "This model does not support that effort");
  if (code === "model_reasoning_unavailable") return t("思考设置暂不可用", "Reasoning settings are unavailable");
  const messages: Record<string, string> = {
    "思考设置读取失败": "Could not load reasoning settings",
    "当前会话不能修改思考强度": "Reasoning effort cannot be changed for this session",
    "思考强度设置失败": "Could not change reasoning effort",
    "思考选项读取失败": "Could not load reasoning options",
    "当前模型不能选择该思考强度": "This model does not support that reasoning effort",
    "思考选项暂不可用，请稍后重试": "Reasoning options are temporarily unavailable. Try again later",
  };
  if (messages[code]) return t(code, messages[code]);
  return readableError(code);
}
