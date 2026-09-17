import { useEffect, useId, useRef, useState } from "react";
import type { Session, SessionStatus } from "../../../../sessions/types.js";
import type { SessionClientModel } from "../model/session.js";
import type { UiSlots } from "../slots.js";
import { groupSessionsByWorkspace, type WorkspaceSessionGroup } from "../projection/sessions.js";
import type { ComposerDrafts } from "./drafts.js";
import { ErrorNotice, Icon, readableError, useSnapshot } from "./primitives.js";
import { useText } from "../i18n.js";

interface SessionViews { model: SessionClientModel; slots: UiSlots; drafts: ComposerDrafts; panelId?: string }

export function SessionNavigation({ model, slots, drafts, panelId, status = "active" }: SessionViews & { status?: SessionStatus }) {
  const t = useText();
  const state = useSnapshot(model), [error, setError] = useState<string | null>(null);
  const groups = groupSessionsByWorkspace(state.sessions, status), archived = status === "archived";
  return <div className="session-navigation">
    <header className="section-heading"><h2>{archived ? t("归档会话", "Archived sessions") : t("会话", "Sessions")}</h2>{!archived ? <button className="icon-button" aria-label={t("新建会话", "New session")} title={t("新建会话", "New session")} disabled={!state.available || state.working} onClick={() => {
      setError(null); slots.openPanel("new-session");
    }}><Icon name="plus" /></button> : null}</header>
    <ErrorNotice text={error} />
    <nav aria-label={archived ? t("归档会话列表", "Archived session list") : t("会话列表", "Session list")}><SessionGroups groups={groups} model={model} slots={slots} drafts={drafts} {...(panelId ? { panelId } : {})} selectedId={state.selectedId} disabled={!state.available || state.working} /></nav>
    {!groups.length ? <p className="muted session-empty">{state.loading && state.available ? t("正在读取会话…", "Loading sessions…") : archived ? t("还没有归档会话。", "No archived sessions yet.") : t("选择工作区，开始新会话。", "Choose a workspace to start a session.")}</p> : null}
  </div>;
}

function SessionGroups({ groups, selectedId, disabled, model, slots, drafts, panelId }: SessionViews & { groups: readonly WorkspaceSessionGroup[]; selectedId: string | null; disabled: boolean }) {
  const t = useText();
  return groups.map(group => <details key={group.scope} className="workspace-session-group" data-workspace={group.scope} open>
    <summary title={group.scope} aria-label={t(`工作区 ${group.scope}，${group.sessions.length} 个会话`, `Workspace ${group.scope}, ${group.sessions.length} sessions`)}><Icon name="chevron" /><span>{group.label}</span><small>{group.sessions.length}</small></summary>
    <div className="workspace-session-items">{group.sessions.map(session => <SessionRow key={session.sessionId} session={session} model={model} slots={slots} drafts={drafts} selected={selectedId === session.sessionId} disabled={disabled} {...(panelId ? { panelId } : {})} />)}</div>
  </details>);
}

function SessionRow({ session, model, slots, drafts, selected, disabled, panelId = "conversation" }: SessionViews & { session: Session; selected: boolean; disabled: boolean }) {
  const t = useText();
  const title = session.title || t("新会话", "New session"), menuId = useId();
  const [editing, setEditing] = useState(false), [name, setName] = useState(title), [error, setError] = useState<string | null>(null), [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), link = useRef<HTMLButtonElement>(null);
  const saving = useRef(false), cancelled = useRef(false), wasEditing = useRef(false);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (wasEditing.current && document.activeElement === document.body) link.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => { if (disabled) menu.current?.hidePopover(); }, [disabled]);
  function closeMenu() { menu.current?.hidePopover(); trigger.current?.focus(); }
  function rename() {
    if (disabled) return;
    closeMenu(); cancelled.current = false; setName(title); setError(null); setEditing(true);
  }
  async function saveName() {
    if (saving.current || cancelled.current) return;
    if (name.trim() === title) { setEditing(false); return; }
    saving.current = true; setError(null);
    try { await model.rename(session.sessionId, name); setEditing(false); }
    catch (cause) { setError(actionError(cause)); }
    finally { saving.current = false; }
  }
  async function act(action: "archive" | "restore" | "delete") {
    closeMenu();
    if (action === "delete" && !window.confirm(t(`删除“${title}”及其聊天记录？\n此操作不可撤销，项目文件不受影响。`, `Delete “${title}” and its conversation history?\nThis cannot be undone. Project files are unaffected.`))) return;
    setError(null);
    try {
      await model[action](session.sessionId);
      if (action === "delete") drafts.remove(session.sessionId);
    } catch (cause) { setError(actionError(cause)); }
  }
  return <div className={`session-row${selected ? " selected" : ""}`} onClick={event => event.stopPropagation()} onKeyDown={event => {
    // The native toggle event moves focus asynchronously. Escape may still be
    // dispatched to the trigger before that event; dismiss this menu, not its sidebar.
    if (event.key === "Escape" && menu.current?.matches(":popover-open")) { event.preventDefault(); event.stopPropagation(); closeMenu(); }
  }}>
    {editing ? <input ref={input} className="session-rename" aria-label={t("会话名称", "Session name")} maxLength={256} value={name} disabled={disabled} onChange={event => setName(event.target.value)} onBlur={() => { void saveName(); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Enter") { event.preventDefault(); void saveName(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setEditing(false); setError(null); queueMicrotask(() => link.current?.focus()); }
    }} /> : <button ref={link} className="session-link" title={t(`${title}（双击重命名）`, `${title} (double-click to rename)`)} aria-current={selected ? "page" : undefined} onClick={() => { model.select(session.sessionId); slots.openPanel(panelId); }} onDoubleClick={rename} onKeyDown={event => { if (event.key === "F2") { event.preventDefault(); rename(); } }}><span>{title}</span></button>}
    <button ref={trigger} className="session-more" aria-label={t(`更多操作：${title}`, `More actions: ${title}`)} title={t("更多操作", "More actions")} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} popoverTarget={menuId} disabled={disabled || editing} onClick={event => {
      // Native top-layer popover escapes the scrolling sidebar. CSSOM positioning
      // keeps it inside the viewport without an inline stylesheet or portal store.
      const box = event.currentTarget.getBoundingClientRect(), node = menu.current;
      if (node) { node.style.left = `${Math.max(8, Math.min(box.right - 152, window.innerWidth - 160))}px`; node.style.top = `${Math.max(8, Math.min(box.bottom + 4, window.innerHeight - 136))}px`; }
    }}><Icon name="more" /></button>
    <div ref={menu} id={menuId} popover="auto" role="menu" aria-label={t(`会话操作：${title}`, `Session actions: ${title}`)} className="session-menu" onToggle={event => {
      const shown = event.currentTarget.matches(":popover-open"); setOpen(shown);
      if (shown) event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
    }} onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
      if (event.key === "Tab") closeMenu();
    }}>
      <button role="menuitem" onClick={rename}>{t("重命名", "Rename")}<span className="menu-shortcut">F2</span></button>
      <button role="menuitem" onClick={() => { void act(session.status === "archived" ? "restore" : "archive"); }}>{session.status === "archived" ? t("取消归档", "Restore") : t("归档会话", "Archive session")}</button>
      <button role="menuitem" className="session-delete" onClick={() => { void act("delete"); }}>{t("删除会话", "Delete session")}</button>
    </div>
    {error ? <p className="session-action-error" role="alert">{error}</p> : null}
  </div>;
}

function actionError(cause: unknown): string { return readableError(cause instanceof Error ? cause.message : "操作失败，请刷新后核对"); }
