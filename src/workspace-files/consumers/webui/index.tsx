import type { Context } from "@deepseek-ai/cordis";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import { ClientApiError, type ClientConnection } from "../../../apps/webui/client/connection.js";
import { ErrorNotice, Icon, readableError } from "../../../apps/webui/client/ui/primitives.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import type { UiSessionSidebarViewProps } from "../../../apps/webui/client/slots.js";
import type { WorkspaceBinaryFileView, WorkspaceDirectoryView, WorkspaceFileEntry, WorkspaceTextFileView } from "../../types.js";

export class WorkspaceFilesClient {
  constructor(private readonly connection: ClientConnection) {}
  private query<T>(sessionId: string, body: unknown): Promise<T> {
    return this.connection.request<{ value: T }>(`/api/sessions/${encodeURIComponent(sessionId)}/queries/workspace-files`, body).then(response => response.value);
  }
  list(sessionId: string, path: string): Promise<WorkspaceDirectoryView> { return this.query(sessionId, { operation: "list", path }); }
  read(sessionId: string, path: string): Promise<WorkspaceTextFileView> { return this.query(sessionId, { operation: "read", path }); }
  readBytes(sessionId: string, path: string): Promise<WorkspaceBinaryFileView> { return this.query(sessionId, { operation: "read-bytes", path }); }
}

type DirectoryLevel = { readonly phase: "loading" } | { readonly phase: "ready"; readonly value: WorkspaceDirectoryView } | { readonly phase: "failed"; readonly error: string };

function WorkspaceFilesSidebar({ client, sessionId, actions }: { client: WorkspaceFilesClient } & UiSessionSidebarViewProps) {
  const t = useText();
  const [levels, setLevels] = useState<Readonly<Record<string, DirectoryLevel>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["."]));
  const lifetime = useRef<AbortController | null>(null);
  const levelsRef = useRef(levels); levelsRef.current = levels;
  const expandedRef = useRef(expanded); expandedRef.current = expanded;
  const scope = useRef({ client, sessionId });

  const load = useCallback(async (path: string, signal: AbortSignal, preserve = true) => {
    setLevels(current => ({ ...current, [path]: preserve && current[path]?.phase === "ready" ? current[path] : { phase: "loading" } }));
    try {
      const value = await client.list(sessionId, path);
      if (!signal.aborted) setLevels(current => ({ ...current, [path]: { phase: "ready", value } }));
    } catch (cause) {
      if (signal.aborted) return;
      const error = readableError(cause instanceof ClientApiError ? cause.code : cause instanceof Error ? cause.message : "workspace_files_unavailable");
      setLevels(current => ({ ...current, [path]: { phase: "failed", error } }));
    }
  }, [client, sessionId]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const changed = scope.current.client !== client || scope.current.sessionId !== sessionId;
    scope.current = { client, sessionId };
    if (changed) { setLevels({}); setExpanded(new Set(["."])); }
    const paths = changed ? ["."] : new Set([".", ...expandedRef.current]);
    for (const path of paths) void load(path, controller.signal, !changed);
    return () => { controller.abort(); if (lifetime.current === controller) lifetime.current = null; };
  }, [client, sessionId, load]);

  const toggle = useCallback((path: string) => {
    const controller = lifetime.current; if (!controller) return;
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!levelsRef.current[path]) void load(path, controller.signal, false); }
      return next;
    });
  }, [load]);

  const refresh = useCallback(() => {
    const controller = lifetime.current; if (!controller) return;
    for (const path of expanded) void load(path, controller.signal);
  }, [expanded, load]);

  const openFile = useCallback((entry: WorkspaceFileEntry) => {
    actions.openResource({ kind: "file", contentId: `file:${sessionId}:${encodeURIComponent(entry.path)}`, title: entry.name, params: { path: entry.path } });
  }, [actions, sessionId]);

  const root = Object.values(levels).find(level => level.phase === "ready")?.value.root;
  return <section className="workspace-files-view" data-files-state="tree">
    <header className="workspace-files-toolbar">
      <code title={root}>{root ?? t("工作区", "Workspace")}</code>
      <button className="workspace-files-refresh" disabled={!root} aria-label={t("刷新文件树", "Refresh file tree")} title={t("刷新", "Refresh")} onClick={refresh}><RefreshIcon /></button>
    </header>
    <div className="workspace-files-tree" role="tree" aria-label={t("工作区文件", "Workspace files")}><DirectoryLevelView path="." levels={levels} expanded={expanded} toggle={toggle} openFile={openFile} t={t} /></div>
  </section>;
}

function DirectoryLevelView({ path, levels, expanded, toggle, openFile, t }: { path: string; levels: Readonly<Record<string, DirectoryLevel>>; expanded: ReadonlySet<string>; toggle(path: string): void; openFile(entry: WorkspaceFileEntry): void; t: ReturnType<typeof useText> }): ReactNode {
  const level = levels[path];
  if (!level || level.phase === "loading") return <li className="workspace-files-note" role="status">{t("正在读取…", "Loading…")}</li>;
  if (level.phase === "failed") return <li className="workspace-files-note danger">{level.error}</li>;
  if (!level.value.entries.length) return <li className="workspace-files-note">{t("空文件夹", "Empty folder")}</li>;
  return <ul className="workspace-files-level" role="group">{level.value.entries.map(entry => {
    const open = entry.kind === "directory" && expanded.has(entry.path);
    return <li key={entry.path} className="workspace-files-item" role="treeitem" aria-expanded={entry.kind === "directory" ? open : undefined}>
      <button className="workspace-file-row" data-kind={entry.kind} title={entry.path} onClick={() => { if (entry.kind === "directory") toggle(entry.path); else openFile(entry); }}>
        <Icon name={entry.kind === "directory" ? "folder" : fileIcon(entry.name)} />
        <span>{entry.name}</span>
      </button>
      {open ? <DirectoryLevelView path={entry.path} levels={levels} expanded={expanded} toggle={toggle} openFile={openFile} t={t} /> : null}
    </li>;
  })}{level.value.truncated ? <li className="workspace-files-note">{t("列表已达到显示上限。", "The listing reached its display limit.")}</li> : null}</ul>;
}

function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15" /></svg>; }
function fileIcon(name: string): "book" | "model" | "trace" { const extension = name.split(".").at(-1)?.toLowerCase(); return extension === "md" || extension === "markdown" ? "book" : ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(extension ?? "") ? "model" : "trace"; }

export const WorkspaceFilesClientUi = {
  name: "ui-workspace-files",
  inject: ["wishConnection", "wishUiSlots"],
  apply(ctx: Context): void {
    const client = new WorkspaceFilesClient(ctx.wishConnection);
    ctx.effect(() => ctx.wishUiSlots.sessionSidebar({ id: "files", kind: "files", order: 20, label: "文件", labelEn: "Files", description: "浏览当前会话工作区", descriptionEn: "Browse this Session workspace", icon: "folder", View: props => <WorkspaceFilesSidebar client={client} {...props} /> }));
  },
};
