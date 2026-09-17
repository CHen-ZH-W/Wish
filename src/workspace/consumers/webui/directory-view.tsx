import { useEffect, useRef } from "react";
import { ErrorNotice, Icon, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { HostDirectoryEntry } from "../../directory-picker/types.js";
import type { DirectoryBrowserModel } from "./directory-model.js";
import { useText } from "../../../apps/webui/client/i18n.js";

function FolderColumn({ entries, selected, hidden, disabled, onSelect }: {
  entries: readonly HostDirectoryEntry[]; selected?: string | null; hidden: boolean; disabled: boolean;
  onSelect(entry: HostDirectoryEntry): void;
}) {
  const t = useText();
  const visible = entries.filter(entry => hidden || !entry.hidden);
  return <div className="directory-column" role="list">
    {visible.length ? visible.map(entry => <div key={entry.path} role="listitem">
      <button type="button" className={`directory-row${selected === entry.path ? " selected" : ""}`} aria-current={selected === entry.path ? "true" : undefined} disabled={disabled} onClick={() => onSelect(entry)}>
        <Icon name="folder" /><span title={entry.name}>{entry.name}</span><Icon name="chevron" />
      </button>
    </div>) : <p className="directory-empty">{entries.length && !hidden ? t("这里没有可见文件夹。可以显示隐藏目录。", "No visible folders here. Try showing hidden folders.") : t("这个目录下没有文件夹。", "No folders in this directory.")}</p>}
  </div>;
}

/** DSH-inspired Host folder browser; owns only presentation, never filesystem authority. */
export function DirectoryBrowser({ model, onPick }: { model: DirectoryBrowserModel; onPick(path: string): void }) {
  const t = useText();
  const state = useSnapshot(model), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!state.open) return;
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, [state.open]);
  if (!state.open) return null;
  const listing = state.listing, target = model.pickedPath();
  return <dialog ref={dialog} className="directory-dialog" aria-labelledby="directory-dialog-title" onCancel={event => { event.preventDefault(); model.dismiss(); }} onClick={event => { if (event.target === dialog.current) model.dismiss(); }}>
    <div className="directory-dialog-content">
      <header className="directory-dialog-header"><h2 id="directory-dialog-title">{t("选择工作区目录", "Choose a workspace folder")}</h2><button type="button" className="directory-close" aria-label={t("关闭目录选择", "Close folder picker")} onClick={model.dismiss}><Icon name="close" /></button></header>
      <nav className="directory-breadcrumbs" aria-label={t("目录路径", "Folder path")}>
        {listing?.crumbs.map((crumb, index) => <span key={crumb.path} className="directory-crumb"><button type="button" aria-current={index === listing.crumbs.length - 1 ? "page" : undefined} disabled={state.loading} onClick={() => { void model.navigate(crumb.path); }}>{crumb.name}</button>{index < listing.crumbs.length - 1 ? <Icon name="chevron" /> : null}</span>)}
      </nav>
      <ErrorNotice text={state.error ? readableError(state.error) : null} />
      <div className={`directory-columns${state.selected ? " has-child" : ""}`} aria-busy={state.loading || state.childLoading}>
        {listing ? <FolderColumn entries={listing.entries} selected={state.selected} hidden={state.showHidden} disabled={state.loading} onSelect={entry => { void model.select(entry); }} /> : <p className="directory-empty">{state.loading ? t("正在读取文件夹…", "Loading folders…") : t("无法读取目录，请关闭后重试。", "Could not read this folder. Close the picker and try again.")}</p>}
        {state.selected ? state.child ? <FolderColumn entries={state.child.entries} hidden={state.showHidden} disabled={state.childLoading} onSelect={entry => { void model.select(entry, true); }} /> : <div className="directory-column"><p className="directory-empty">{state.childLoading ? t("正在读取下一级…", "Loading next level…") : t("无法打开这个文件夹。", "Could not open this folder.")}</p></div> : null}
      </div>
      <footer className="directory-dialog-footer">
        <div className="directory-options"><label className="directory-hidden-toggle"><input type="checkbox" checked={state.showHidden} onChange={model.toggleHidden} />{t("显示隐藏目录", "Show hidden folders")}</label>{listing?.truncated ? <small>{t("目录较多，仅显示前 ", "Showing the first ")}{listing.limit}{t(" 项", " folders")}</small> : null}</div>
        <div className="directory-dialog-actions"><button type="button" onClick={model.dismiss}>{t("取消", "Cancel")}</button><button type="button" className="primary" disabled={!target} onClick={() => { if (target) { onPick(target); model.dismiss(); } }}>{t("选择此目录", "Choose this folder")}</button></div>
      </footer>
    </div>
  </dialog>;
}
