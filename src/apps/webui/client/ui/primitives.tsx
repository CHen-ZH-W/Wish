import { useSyncExternalStore } from "react";
import { useLanguage } from "../i18n.js";

export interface ReadableSnapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export function useSnapshot<T>(store: ReadableSnapshot<T>): T { return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot); }
export function Icon({ name }: { name: "conversation" | "settings" | "gear" | "menu" | "plus" | "close" | "trace" | "more" | "archive" | "chevron" | "panel-open" | "panel-close" | "panel-right-open" | "panel-right-close" | "split" | "fullscreen" | "fullscreen-exit" | "plug" | "book" | "model" | "folder" | "send" | "cube" | "terminal" | "tmux" }) {
  const paths = {
    conversation: "M4 4h16v12H9l-5 4V4m4 4h8M8 12h5",
    settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
    gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    plug: "M9 3v4M15 3v4M6 7h12M7 7v4a5 5 0 0 0 10 0V7M12 16v5",
    book: "M12 6v14M3 4c4-1 6 0 9 2 3-2 5-3 9-2v14c-4-1-6 0-9 2-3-2-5-3-9-2z",
    model: "M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3M7 7h10v10H7zM10 10h4v4h-4z",
    folder: "M3 6h7l2 2h9v11H3zM3 6v13",
    send: "M12 19V5m-6 6 6-6 6 6",
    menu: "M4 6h16M4 12h16M4 18h16", plus: "M12 4v16M4 12h16", close: "m6 6 12 12M18 6 6 18",
    trace: "M8 5h12M8 12h12M8 19h12M4 5v14",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    archive: "M4 4h16v4H4zM5 8v12h14V8M9 12h6",
    chevron: "m9 5 7 7-7 7",
    "panel-open": "M3 4h18v16H3zM9 4v16m4-11 3 3-3 3",
    "panel-close": "M3 4h18v16H3zM9 4v16m7-11-3 3 3 3",
    "panel-right-open": "M3 4h18v16H3zM15 4v16M11 9l-3 3 3 3",
    "panel-right-close": "M3 4h18v16H3zM15 4v16M8 9l3 3-3 3",
    split: "M4 4h16v16H4zM12 4v16",
    fullscreen: "M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5",
    "fullscreen-exit": "M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5",
    cube: "m12 3 7 4v10l-7 4-7-4V7l7-4zM5 7l7 4 7-4M12 11v10",
    terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
    tmux: "M8 13H7V1H2C1.448 1 1 1.448 1 2V14C1 14.552 1.448 15 2 15H14C14.552 15 15 14.552 15 14V8H8V13ZM14 1H8V7H15V2C15 1.448 14.552 1 14 1Z",
  };
  const filled = name === "tmux";
  return <svg viewBox={filled ? "0 0 16 16" : "0 0 24 24"} aria-hidden="true" width="20" height="20" fill={filled ? "currentColor" : "none"} stroke={filled ? undefined : "currentColor"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
const errorNames: Record<string, readonly [string, string]> = {
  management_revision_conflict: ["配置已被其他操作修改，界面正在重新同步，请再次确认。", "Configuration changed elsewhere. The page is resyncing; review and try again."],
  management_cancelled: ["已取消等待，插件未修改。", "Waiting cancelled. The plugin was not changed."],
  management_timeout: ["等待超时，插件未修改；当前工作完成后可重试。", "Waiting timed out. The plugin was not changed; retry after current work finishes."],
  management_target_read_only: ["该条目属于 Kernel 或结构层，只能查看，不能通过插件管理启停。", "This Kernel or structural entry is read-only and cannot be toggled through plugin management."],
  management_plugin_nonconformant: ["该插件或受影响依赖尚未接入安全停用协议；Host 已拒绝修改。请先由插件作者补齐生命周期适配。", "This plugin or an affected dependent has no safe-stop protocol. Host refused the change; its author must add lifecycle support first."],
  settings_revision_conflict: ["设置版本已变化，界面已重新同步，请再次选择。", "Settings changed elsewhere. The page has resynced; choose again."],
  credentials_read_only: ["该密钥由启动环境提供，网页不能覆盖。", "This key comes from the startup environment and cannot be overwritten here."],
  credentials_invalid_value: ["密钥格式无效，请只输入密钥本身。", "Invalid key format. Enter only the key itself."],
  credentials_invalid_reference: ["模型声明的密钥引用无效。", "The model declares an invalid key reference."],
  stop_lifecycle_blocked: ["当前资源尚未满足停用条件；未取消正在进行的工作。", "Resources are not ready to stop. Active work was not cancelled."],
  stop_owner_unsupported: ["此插件或依赖者尚未提供安全退出接口，Host 已拒绝停用。", "This plugin or a dependent has no safe shutdown interface. Host refused to stop it."],
  stop_restart_required: ["此变更涉及进程或会话基础设施。请结束工作、修改启动配置，再重启 Wish。", "This change affects process or session infrastructure. Finish active work, update startup configuration, and restart Wish."],
  management_recovery_required: ["操作结果需要核对。请查看恢复说明，不要重复提交。", "The result needs review. Follow recovery guidance before trying again."],
  management_restart_required: ["本进程仍可能有未完成的收尾；请退出进程并重启，再确认保持停用。", "This process may still be cleaning up. Restart, then confirm the plugin remains disabled."],
  management_configuration_changed: ["部署配置已变化或不受此管理入口控制，请检查配置并重启。", "Deployment settings changed or are outside this management scope. Check them and restart."],
  stop_target_not_active: ["当前条目不是可在线停用的活动插件。", "This entry is not an active plugin that can be stopped online."],
  session_busy: ["会话仍有运行或待核对任务；请先处理相关工作后重试。", "The session still has running or unresolved work. Resolve it before trying again."],
  session_not_found: ["会话已不存在，请刷新列表。", "This session no longer exists. Refresh the list."],
  session_archived: ["会话已归档，请先取消归档。", "Restore this archived session first."],
  invalid_workspace: ["工作区目录不存在、不是目录，或 Host 无权读取。请检查路径后重试。", "The workspace does not exist, is not a folder, or Host cannot read it. Check the path."],
  directory_invalid_path: ["目录路径无效，请从列表中重新选择。", "Invalid folder path. Choose again from the list."],
  directory_unreadable: ["Host 无法读取这个目录。请选择其他文件夹，或检查目录权限。", "Host cannot read this folder. Choose another or check permissions."],
  directory_browser_unavailable: ["Host 当前没有提供目录浏览能力。请检查 WebUI 装配状态。", "Host folder browsing is unavailable. Check the WebUI configuration."],
  workspace_files_invalid_path: ["文件路径无效，请从工作区列表重新选择。", "Invalid file path. Choose it again from the workspace listing."],
  workspace_files_path_escape: ["文件路径超出了当前会话工作区。", "The file path escapes this Session workspace."],
  workspace_files_protected_path: ["该路径受工作区策略保护，不能在 Files 中查看。", "This path is protected by the workspace policy and is unavailable in Files."],
  workspace_files_symbolic_link: ["Files 不跟随符号链接。", "Files does not follow symbolic links."],
  workspace_files_not_directory: ["所选路径不是目录。", "The selected path is not a directory."],
  workspace_files_not_file: ["所选路径不是文件。", "The selected path is not a file."],
  workspace_files_binary_file: ["这是二进制文件，当前只支持文本预览。", "This is a binary file; only text preview is currently supported."],
  terminal_profile_requires_approval: ["“需要审批”不能创建持久终端；请改用只读或工作区可写。", "Approval-required cannot create a persistent terminal. Choose read-only or workspace-write."],
  terminal_not_found: ["这个终端已不存在，请刷新列表。", "This terminal no longer exists. Refresh the list."],
  terminal_not_active: ["这个终端已经退出。", "This terminal has already exited."],
  terminal_invalid_input: ["终端输入或尺寸无效。", "Terminal input or dimensions are invalid."],
  terminal_limit_reached: ["这个会话保留的用户终端已达到上限；请先关闭一个。", "This Session has reached its retained user-terminal limit. Close one first."],
  invalid_request: ["操作内容无效，请检查后重试。", "Invalid request. Check the details and try again."],
  "设置读取失败，连接恢复后会自动重试。": ["设置读取失败，连接恢复后会自动重试。", "Could not load settings. The page will retry when the connection returns."],
  "设置当前不可写": ["设置当前不可写", "Settings are currently read-only."],
  "设置修改失败": ["设置修改失败", "Could not change the setting."],
  "模型当前不可用": ["模型当前不可用", "This model is currently unavailable."],
  "模型设置当前不可写": ["模型设置当前不可写", "Model settings are currently read-only."],
  "模型设置修改失败": ["模型设置修改失败", "Could not change model settings."],
  "Skill 目录暂不可用。": ["Skill 目录暂不可用。", "The Skill catalog is temporarily unavailable."],
};
const englishByChinese = new Map(Object.values(errorNames).map(([zh, en]) => [zh, en]));
/** Known UI errors are localized; unknown Host details remain verbatim. */
export function ErrorNotice({ text }: { text: string | null }) {
  const language = useLanguage();
  return text ? <p className="notice danger" role="alert">{language === "en-US" ? englishByChinese.get(text) ?? errorNames[text]?.[1] ?? text : text}</p> : null;
}
export function readableError(code: string): string { return errorNames[code]?.[0] ?? code; }
