import type { UiModuleLoader } from "../module-loader.js";
import { useSnapshot } from "./primitives.js";
import { useText } from "../i18n.js";

export function ModuleUpdateNotice({ model }: { model: UiModuleLoader }) {
  const t = useText();
  const status = useSnapshot(model);
  if (!status.refreshRequired && !status.errors.length) return null;
  return <div className="connection-notice" role="status">
    {status.refreshRequired ? <span>{t("界面基础代码已更新。当前页面继续使用原版本，请先保存草稿，再刷新页面。", "Core UI code was updated. This page still uses the old version; save your draft, then refresh.")}</span> : null}
    {status.errors.map(error => <span key={error}>{error} </span>)}
    <button type="button" onClick={() => { void model.retry(); }}>{t("重新检查", "Check again")}</button>
  </div>;
}
