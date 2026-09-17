import { useEffect, useId, useRef, useState } from "react";
import type { SessionClientModel } from "../model/session.js";
import type { NewSessionClientModel } from "../model/new-session.js";
import { projectWorkspaceChoices } from "../projection/sessions.js";
import type { UiSlots } from "../slots.js";
import { ErrorNotice, Icon, readableError, useSnapshot } from "./primitives.js";
import type { DirectoryBrowserModel } from "../../../../workspace/consumers/webui/directory-model.js";
import { DirectoryBrowser } from "../../../../workspace/consumers/webui/directory-view.js";
import { useText } from "../i18n.js";

/** The center-of-page first-message composer; folder picking is its child flow. */
export function NewSession({ sessions, flow, slots, browser }: { sessions: SessionClientModel; flow: NewSessionClientModel; slots: UiSlots; browser: DirectoryBrowserModel }) {
  const t = useText();
  const state = useSnapshot(sessions), intent = useSnapshot(flow), contributions = useSnapshot(slots);
  const choices = projectWorkspaceChoices(state.sessions);
  const [menuOpen, setMenuOpen] = useState(false), [composing, setComposing] = useState(false);
  const menuId = useId(), workspaceButton = useRef<HTMLButtonElement>(null), workspaceControl = useRef<HTMLDivElement>(null), messageInput = useRef<HTMLTextAreaElement>(null);
  const selected = intent.workspaceRoot;
  const selectedChoice = choices.find(choice => choice.root === selected);
  const selectedLabel = selectedChoice?.label ?? selected?.split(/[\\/]/u).filter(Boolean).at(-1) ?? selected;
  const pending = intent.phase === "creating" || intent.phase === "sending";
  useEffect(() => () => browser.dismiss(), [browser]);
  useEffect(() => { if (intent.phase === "done") slots.openPanel("conversation"); }, [intent.phase, slots]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!workspaceControl.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);
  function choose(root: string) { flow.chooseWorkspace(root); setMenuOpen(false); requestAnimationFrame(() => messageInput.current?.focus()); }
  function openWorkspacePicker() {
    if (choices.length) setMenuOpen(open => !open);
    else void browser.open();
  }
  return <section className="new-session-page" aria-labelledby="new-session-heading">
    <div className="new-session-center">
      <header className="new-session-heading"><span className="new-session-mark" aria-hidden="true">W</span><h1 id="new-session-heading">{t("许个愿吧", "Make a wish")}</h1></header>
      <div ref={workspaceControl} className="new-session-workspace">
        <button ref={workspaceButton} type="button" className="new-session-workspace-trigger" aria-label={selected ? `${t("工作区：", "Workspace: ")}${selected}${t("，点击更改", "; click to change")}` : t("选择工作区", "Choose workspace")} aria-expanded={menuOpen} aria-controls={choices.length ? menuId : undefined} disabled={!state.available || pending || intent.phase === "review"} title={selected ?? t("选择工作区", "Choose workspace")} onClick={openWorkspacePicker}>
          <Icon name="folder" /><span>{selectedLabel ?? t("选择工作区", "Choose workspace")}</span><Icon name="chevron" />
        </button>
        {menuOpen ? <div id={menuId} className="new-session-workspace-menu" role="group" aria-label={t("工作区选项", "Workspace choices")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setMenuOpen(false); workspaceButton.current?.focus(); } }}>
          <div className="new-session-workspace-list">
            {choices.map(choice => <button key={choice.root} type="button" className={selected === choice.root ? "selected" : ""} title={choice.root} onClick={() => choose(choice.root)}>
              <Icon name="folder" /><span><strong>{choice.label}</strong><code>{choice.root}</code></span>
            </button>)}
          </div>
          <button type="button" className="new-session-workspace-browse" onClick={() => { setMenuOpen(false); void browser.open(); }}><Icon name="plus" />{t("选择其他目录", "Choose another folder")}</button>
        </div> : null}
      </div>
      <form className={`new-session-composer message-composer-card${selected ? "" : " unbound"}`} onSubmit={event => { event.preventDefault(); void flow.submit(); }}>
        {selected ? <><label className="sr-only" htmlFor="new-session-message">{t("新会话消息", "First message")}</label><textarea ref={messageInput} id="new-session-message" rows={2} maxLength={131072} value={intent.draft} placeholder={t("输入消息…", "Write a message…")} disabled={!state.available || intent.phase !== "ready"} onChange={event => flow.setDraft(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void flow.submit(); } }} /></>
          : <button type="button" className="new-session-workspace-call" disabled={!state.available || pending || intent.phase === "review"} onClick={openWorkspacePicker}>{t("选择工作区", "Choose workspace")}</button>}
        <footer className="new-session-composer-toolbar">
          <div className="new-session-composer-tools">{contributions.newSessionComposerItems.map(item => <item.View key={item.id} disabled={!state.available || intent.phase !== "ready"} />)}</div>
          <button type="submit" className="new-session-send" aria-label={pending ? t("正在发送", "Sending") : t("发送消息", "Send message")} title={t("发送消息", "Send message")} aria-busy={pending} disabled={!selected || !intent.draft.trim() || !state.available || intent.phase !== "ready"}><Icon name="send" /></button>
        </footer>
      </form>
      {intent.phase === "review" ? <div className="new-session-review"><ErrorNotice text={readableError(intent.error ?? t("发送结果需要核对", "Delivery needs review"))} /><button type="button" onClick={() => { if (intent.createdSessionId) sessions.select(intent.createdSessionId); slots.openPanel("conversation"); }}>{t("打开已创建的会话", "Open created session")}</button></div> : <ErrorNotice text={intent.error ? readableError(intent.error) : state.error ? readableError(state.error) : null} />}
    </div>
    <DirectoryBrowser model={browser} onPick={choose} />
  </section>;
}
