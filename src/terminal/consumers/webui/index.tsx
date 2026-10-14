import type { Context } from "@deepseek-ai/cordis";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import type { UiSessionSidebarGuideProps, UiSessionSidebarTab, UiSessionSidebarViewProps } from "../../../apps/webui/client/slots.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import { ErrorNotice, Icon, readableError, useSnapshot } from "../../../apps/webui/client/ui/primitives.js";
import type { UserTerminalShellChoice, UserTerminalView } from "../../types.js";
import { UserTerminalClientModel } from "./model.js";

const TerminalScreen = lazy(async () => ({ default: (await import("./terminal-screen.js")).TerminalScreen }));

class UserTerminalClientPool {
  private readonly models = new Map<string, UserTerminalClientModel>();
  private readonly creating = new Map<string, Promise<UserTerminalView>>();
  constructor(private readonly connection: ClientConnection) {}
  get(sessionId: string, tabId: string): UserTerminalClientModel { const key = `${sessionId}:${tabId}`; let model = this.models.get(key); if (!model) { model = new UserTerminalClientModel(this.connection); this.models.set(key, model); } return model; }
  create(sessionId: string, tabId: string, shellPath?: string): Promise<UserTerminalView> {
    const key = `${sessionId}:${tabId}`;
    const current = this.creating.get(key);
    if (current) return current;
    const model = this.get(sessionId, tabId);
    const creating = model.create(sessionId, shellPath).finally(() => { if (this.creating.get(key) === creating) this.creating.delete(key); });
    this.creating.set(key, creating);
    return creating;
  }
  listShells(sessionId: string): Promise<readonly UserTerminalShellChoice[]> { return new UserTerminalClientModel(this.connection).listShells(sessionId); }
  closeTab(sessionId: string, tab: UiSessionSidebarTab): void {
    const key = `${sessionId}:${tab.id}`;
    const owner = this.models.get(key) ?? new UserTerminalClientModel(this.connection);
    const terminalId = typeof tab.params?.terminalId === "string" ? tab.params.terminalId : owner.getSnapshot().observedTerminalId;
    const creating = this.creating.get(key);
    void (async () => {
      const created = terminalId ? undefined : await creating?.catch(() => undefined);
      const id = terminalId ?? created?.id ?? owner.getSnapshot().terminals.at(-1)?.id;
      if (id) await owner.closeTerminal(sessionId, id).catch(() => undefined);
    })().finally(() => { owner.close(); this.models.delete(key); this.creating.delete(key); });
  }
  dispose(): void { for (const model of this.models.values()) model.close(); this.models.clear(); this.creating.clear(); }
}

const SHELL_PREFERENCE_KEY = "wish.terminal.shell";

function UserTerminalGuide({ pool, sessionId, open }: { readonly pool: UserTerminalClientPool } & UiSessionSidebarGuideProps) {
  const t = useText();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shells, setShells] = useState<readonly UserTerminalShellChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => preferredShell());
  useEffect(() => {
    if (!menuOpen) return;
    let active = true;
    setShells(null); setError(null);
    void pool.listShells(sessionId).then(value => { if (active) setShells(value); }, cause => { if (active) setError(readableError(cause instanceof Error ? cause.message : String(cause))); });
    return () => { active = false; };
  }, [menuOpen, pool, sessionId]);
  const launch = (shellPath = selected) => open(shellPath ? { params: { shellPath } } : undefined);
  return <div className="session-sidebar-guide-entry user-terminal-guide" data-session-sidebar-guide-entry="terminal">
    <button className="user-terminal-guide-main" aria-label={t("打开 终端", "Open Terminal")} onClick={() => launch()}>
      <span className="session-sidebar-guide-entry-icon" aria-hidden="true"><Icon name="terminal" /></span>
      <span className="session-sidebar-guide-entry-text"><span className="session-sidebar-guide-entry-title">{t("终端", "Terminal")}</span><span className="session-sidebar-guide-entry-description">{t("使用当前系统用户权限启动宿主 Shell", "Start a host Shell with the current system user")}</span></span>
    </button>
    <button className="user-terminal-shell-trigger" aria-label={t("选择终端 Shell", "Choose terminal Shell")} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><Icon name="chevron" /></button>
    {menuOpen ? <div className="user-terminal-shell-menu" role="menu" aria-label={t("可用 Shell", "Available Shells")}>
      {shells ? shells.map(shell => <button key={shell.path} role="menuitemradio" aria-checked={selected === shell.path} onClick={() => { rememberShell(shell.path); setSelected(shell.path); setMenuOpen(false); launch(shell.path); }}><span>{shell.name}</span><small>{shell.path}</small></button>) : error ? <p className="notice warning">{error}</p> : <p role="status">{t("正在查找可用 Shell…", "Finding available Shells…")}</p>}
    </div> : null}
  </div>;
}

function preferredShell(): string | undefined { try { return localStorage.getItem(SHELL_PREFERENCE_KEY) ?? undefined; } catch { return undefined; } }
function rememberShell(path: string): void { try { localStorage.setItem(SHELL_PREFERENCE_KEY, path); } catch { /* Browser storage is optional. */ } }

function UserTerminalSidebar({ pool, sessionId, tab, actions }: { pool: UserTerminalClientPool } & UiSessionSidebarViewProps) {
  const t = useText();
  const model = pool.get(sessionId, tab.id);
  const state = useSnapshot(model);
  const requestedId = typeof tab.params?.terminalId === "string" ? tab.params.terminalId : undefined;
  const requestedShellPath = typeof tab.params?.shellPath === "string" ? tab.params.shellPath : undefined;
  const selected = state.terminals.find(item => item.id === requestedId) ?? (state.observedTerminalId ? state.terminals.find(item => item.id === state.observedTerminalId) : undefined);
  const actionsRef = useRef(actions); actionsRef.current = actions;

  useEffect(() => {
    if (!tab.visible) { model.suspend(); return; }
    let active = true;
    const start = async (): Promise<void> => {
      await model.refresh(sessionId, true);
      if (!active) return;
      const existing = requestedId === undefined ? undefined : model.getSnapshot().terminals.find(item => item.id === requestedId);
      if (existing) { model.observe(sessionId, existing.id); return; }
      if (requestedId !== undefined) return;
      await pool.create(sessionId, tab.id, requestedShellPath).then(terminal => {
        if (!active) return;
        actionsRef.current.update({ terminalId: terminal.id }, terminal.label);
        model.observe(sessionId, terminal.id);
      });
    };
    void start();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void model.refresh(sessionId); }, 3_000);
    return () => { active = false; window.clearInterval(timer); model.suspend(); };
  }, [model, pool, requestedId, requestedShellPath, sessionId, tab.id, tab.visible]);

  return <section className="user-terminal-view">
    <ErrorNotice text={state.error ? readableError(state.error) : null} />
    {selected ? <div className="user-terminal-console" data-active={selected.active || undefined}>
      <Suspense fallback={<div className="user-terminal-screen-loading" role="status">{t("正在加载终端…", "Loading terminal…")}</div>}>
        <TerminalScreen
          key={selected.id}
          terminalId={selected.id}
          render={state.observedTerminalId === selected.id ? state.render : undefined}
          active={selected.active}
          writable={state.observedTerminalId === selected.id && state.writable}
          label={t(`${selected.shell} 终端输入`, `${selected.shell} terminal input`)}
          onData={data => model.writeRaw(sessionId, selected.id, data)}
          onResize={(columns, rows) => { model.resize(sessionId, selected.id, columns, rows); }}
          onRendered={revision => model.acknowledge(revision)}
        />
        {state.observedTerminalId === selected.id && state.streamPhase !== "connected" ? <div className="user-terminal-status">{state.streamPhase === "connecting" ? t("正在连接终端…", "Connecting terminal…") : t("终端连接已断开", "Terminal disconnected")}</div> : null}
        {state.observedTerminalId === selected.id && state.streamPhase === "connected" && !state.writable ? <div className="user-terminal-status">{t("此终端正由另一个页面控制", "This terminal is controlled by another view")}</div> : null}
      </Suspense>
      {!selected.active ? <div className="user-terminal-status">{selected.exitCode === undefined ? t("终端已退出", "Terminal exited") : t(`终端已退出，状态码 ${selected.exitCode}`, `Terminal exited with code ${selected.exitCode}`)}</div> : null}
    </div> : state.pending || requestedId === undefined ? <div className="user-terminal-screen-loading" role="status"><span className="user-terminal-empty-icon"><Icon name="terminal" /></span>{t("正在启动 Bash…", "Starting Bash…")}</div> : <div className="user-terminal-empty">
      <span className="user-terminal-empty-icon"><Icon name="terminal" /></span>
      <p>{t("这个终端已不可用", "This terminal is no longer available")}</p>
      <small>{t("宿主终端 · 当前系统用户权限", "Host terminal · current system user")}</small>
      <button className="primary" onClick={() => actions.openTab("terminal", { replace: true })}><Icon name="plus" />{t("新建终端", "New terminal")}</button>
    </div>}
  </section>;
}

export const UserTerminalClientUi = {
  name: "ui-user-terminal",
  inject: ["wishConnection", "wishUiSlots"],
  apply(ctx: Context): void {
    const pool = new UserTerminalClientPool(ctx.wishConnection);
    ctx.effect(() => () => pool.dispose());
    ctx.effect(() => ctx.wishUiSlots.sessionSidebar({ id: "terminal", kind: "terminal", order: 10, multiple: true, label: "终端", labelEn: "Terminal", description: "使用当前系统用户权限启动宿主 Shell", descriptionEn: "Start a host Shell with the current system user", icon: "terminal", Guide: props => <UserTerminalGuide pool={pool} {...props} />, View: props => <UserTerminalSidebar pool={pool} {...props} />, onClose: (sessionId, tab) => pool.closeTab(sessionId, tab) }));
  },
};
