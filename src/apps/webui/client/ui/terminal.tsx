import { useEffect, useRef, useState } from "react";
import { ErrorNotice, readableError } from "./primitives.js";
import { useLanguage, useText } from "../i18n.js";

/** Presentation only: modules supply the exact owned target and a read action. */
export function TerminalSnapshot({ target, attachCommand, output, observedAt, refresh, disabled, active }: {
  target: string; attachCommand: string; output?: string | undefined; observedAt?: string | undefined; refresh(): Promise<void>; disabled: boolean; active?: boolean | undefined;
}) {
  const language = useLanguage(), t = useText();
  const [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const outputElement = useRef<HTMLPreElement>(null), followOutput = useRef(true);
  useEffect(() => { if (followOutput.current && outputElement.current) outputElement.current.scrollTop = outputElement.current.scrollHeight; }, [output]);
  async function capture() { setWorking(true); setError(null); try { await refresh(); } catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("快照读取失败", "Could not read snapshot"))); } finally { setWorking(false); } }
  async function copy() { try { await navigator.clipboard.writeText(attachCommand); setCopied(true); } catch { setError(t("无法访问剪贴板；可在下面展开连接命令并手动复制。", "Clipboard unavailable. Expand the attach command below and copy it manually.")); } }
  const terminalState = active === undefined ? t("只读快照", "Read-only snapshot") : active ? t("运行中 · 自动同步", "Running · live sync") : t("已退出 · 画面已保留", "Exited · view retained");
  const emptyOutput = active === undefined ? t("尚未读取终端输出。点击刷新快照，获取此刻的可见内容。", "No terminal output captured yet. Refresh to read the currently visible content.") : active ? t("正在同步终端画面…", "Syncing terminal view…") : t("正在读取已保留的终端画面…", "Loading the retained terminal view…");
  return <section className="terminal-snapshot" aria-label={t(`终端快照 ${target}`, `Terminal snapshot ${target}`)} data-active={active === undefined ? undefined : active}><header><code title={target}>{target}</code><span>{terminalState}</span></header>
    <pre ref={outputElement} className="terminal-output" aria-live="off" onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>{output === undefined ? emptyOutput : output || t("（此刻终端没有可见输出）", "(No visible output right now)")}</pre>
    <footer><span className="terminal-snapshot-time">{observedAt ? t(`${active ? "同步" : "采集"}于 ${new Date(observedAt).toLocaleString(language, { hour12: false })}`, `${active ? "Synced" : "Captured"} at ${new Date(observedAt).toLocaleString(language, { hour12: false })}`) : t("等待首次同步", "Waiting for first sync")}</span><button type="button" className="terminal-snapshot-sync" disabled={disabled || working} onClick={() => { void capture(); }}>{working ? t("同步中…", "Syncing…") : t("立即同步", "Sync now")}</button><button type="button" className="terminal-snapshot-copy" onClick={() => { void copy(); }}>{copied ? t("已复制连接命令", "Attach command copied") : t("复制连接命令", "Copy attach command")}</button></footer>
    <details className="terminal-attach"><summary>{t("在本机终端接入同一会话", "Attach to the same session in your terminal")}</summary><code>{attachCommand}</code><p>{t("复制命令不会在网页执行；这里不是交互终端。", "Copying the command does not run it here. This is not an interactive terminal.")}</p></details><ErrorNotice text={error} />
  </section>;
}
