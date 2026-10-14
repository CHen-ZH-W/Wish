import { useText } from "../../../apps/webui/client/i18n.js";
import { readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { PermissionProfile } from "../../types.js";
import type { NewSessionPermissionProfileClientModel } from "./new-session-profile-model.js";
import type { PermissionProfileClientModel } from "./profile-model.js";

const labels: Record<PermissionProfile, readonly [string, string]> = {
  "read-only": ["只读", "Read only"],
  "approval-required": ["需要审批", "Ask first"],
  "workspace-write": ["工作区可写", "Workspace write"],
  "full-access": ["完全访问（无隔离）", "Full access (no isolation)"],
};

export function PermissionProfileComposerItem({ model, sessionId, busy }: {
  readonly model: PermissionProfileClientModel;
  readonly sessionId: string;
  readonly busy: boolean;
}) {
  const t = useText();
  const state = useSnapshot(model);
  if (state.sessionId !== sessionId) return null;
  const view = state.view;
  const unconfined = view?.selected === "full-access";
  const title = unconfined
    ? t("完全访问不使用工作区隔离，并允许访问宿主文件、网络和环境变量", "Full access disables workspace isolation and permits Host files, network, and environment variables")
    : busy
    ? t("下次新运行生效；当前运行、引导和已排队消息保持原权限", "Applies to the next new run; this run, steering, and queued messages keep their current permission")
    : t("下次新运行生效", "Applies to the next new run");
  return <div className="composer-reasoning composer-permission" title={title}>
    <span className="composer-model-name">{t("权限", "Access")}</span>
    <label className="sr-only" htmlFor="wish-permission-profile">{t("下次运行的权限", "Permission for the next run")}</label>
    <select id="wish-permission-profile" aria-label={t("下次运行的权限", "Permission for the next run")}
      value={view?.selected ?? ""} disabled={!view || state.pending || state.loading}
      onChange={(event) => { void model.select(event.target.value as PermissionProfile).catch(() => {}); }}>
      {!view ? <option value="" disabled>{t("读取中", "Loading")}</option> : null}
      {view?.availableProfiles.map((profile) => <option key={profile} value={profile}>{t(...labels[profile])}</option>)}
    </select>
    {state.pending ? <span className="composer-reasoning-status" role="status">{t("设置中", "Applying")}</span>
      : state.error ? <span className="composer-reasoning-error" role="alert" title={permissionError(state.error, t)}>{permissionError(state.error, t)}</span>
      : unconfined ? <span className="composer-permission-warning" role="status">{t("无隔离", "Unconfined")}</span>
      : state.status ? <span className="sr-only" role="status">{t(state.status, "Applies to the next new run")}</span> : null}
  </div>;
}

export function NewSessionPermissionProfileComposerItem({ model, disabled }: {
  readonly model: NewSessionPermissionProfileClientModel;
  readonly disabled: boolean;
}) {
  const t = useText();
  const state = useSnapshot(model);
  const unconfined = state.selected === "full-access";
  const title = unconfined
    ? t("完全访问不使用工作区隔离，并允许访问宿主文件、网络和环境变量", "Full access disables workspace isolation and permits Host files, network, and environment variables")
    : t("从首个运行开始生效", "Applies from the first run");
  return <div className="composer-reasoning composer-permission new-session-permission" title={title}>
    <span className="composer-model-name">{t("权限", "Access")}</span>
    <label className="sr-only" htmlFor="wish-new-session-permission-profile">{t("新会话权限", "New session permission")}</label>
    <select id="wish-new-session-permission-profile" aria-label={t("新会话权限", "New session permission")}
      value={state.selected ?? ""} disabled={disabled || !state.view || state.loading}
      onChange={(event) => model.select(event.target.value as PermissionProfile)}>
      {!state.view ? <option value="" disabled>{state.error ? t("不可用", "Unavailable") : t("读取中", "Loading")}</option> : null}
      {state.view?.availableProfiles.map((profile) => <option key={profile} value={profile}>{t(...labels[profile])}</option>)}
    </select>
    {state.error ? <span className="composer-reasoning-error" role="alert" title={permissionError(state.error, t)}>{permissionError(state.error, t)}</span>
      : unconfined ? <span className="composer-permission-warning" role="status">{t("无隔离", "Unconfined")}</span> : null}
  </div>;
}

function permissionError(code: string, t: (zh: string, en: string) => string): string {
  if (code === "permission_profile_conflict") return t("设置已被修改，请重试", "The setting changed; try again");
  if (code === "permission_profile_unavailable") return t("当前 Shell 不支持该权限", "The active Shell does not support that permission");
  const messages: Record<string, string> = {
    "权限设置读取失败": "Could not load permission settings",
    "当前会话不能使用该权限": "That permission is unavailable for this session",
    "权限设置失败": "Could not change the permission",
    "权限选项读取失败": "Could not load permission choices",
    "当前 Shell 不能使用该权限": "The active Shell cannot use that permission",
    "权限选项暂不可用，请稍后重试": "Permission choices are temporarily unavailable. Try again later",
  };
  if (messages[code]) return t(code, messages[code]);
  return readableError(code);
}
