import { useState } from "react";
import { ErrorNotice, readableError } from "./primitives.js";
import { useLanguage, useText } from "../i18n.js";

/** Presentation only: modules supply the exact owned target and a read action. */
export function TerminalSnapshot({ target, attachCommand, output, observedAt, refresh, disabled }: {
  target: string; attachCommand: string; output?: string | undefined; observedAt?: string | undefined; refresh(): Promise<void>; disabled: boolean;
}) {
  const language = useLanguage(), t = useText();
  const [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  async function capture() { setWorking(true); setError(null); try { await refresh(); } catch (cause) { setError(readableError(cause instanceof Error ? cause.message : t("快照读取失败", "Could not read snapshot"))); } finally { setWorking(false); } }
  async function copy() { try { await navigator.clipboard.writeText(attachCommand); setCopied(true); } catch { setError(t("无法访问剪贴板；可在下面展开连接命令并手动复制。", "Clipboard unavailable. Expand the attach command below and copy it manually.")); } }
  return <section className="terminal-snapshot" aria-label={t(`终端快照 ${target}`, `Terminal snapshot ${target}`)}><header><code>{target}</code><span>{t("只读快照", "Read-only snapshot")}</span></header>
    <pre className="terminal-output">{output === undefined ? t("尚未读取终端输出。点击刷新快照，获取此刻的可见内容。", "No terminal output captured yet. Refresh to read the currently visible content.") : output || t("（此刻终端没有可见输出）", "(No visible output right now)")}</pre>
    <footer><span>{observedAt ? t(`采集于 ${new Date(observedAt).toLocaleString(language, { hour12: false })}`, `Captured at ${new Date(observedAt).toLocaleString(language, { hour12: false })}`) : t("未采集", "Not captured")}</span><button disabled={disabled || working} onClick={() => { void capture(); }}>{working ? t("读取中…", "Reading…") : t("刷新快照", "Refresh snapshot")}</button><button onClick={() => { void copy(); }}>{copied ? t("已复制连接命令", "Attach command copied") : t("复制 tmux 连接命令", "Copy tmux attach command")}</button></footer>
    <details className="terminal-attach"><summary>{t("在本机终端接入同一会话", "Attach to the same session in your terminal")}</summary><code>{attachCommand}</code><p>{t("复制命令不会在网页执行；这里不是交互终端。", "Copying the command does not run it here. This is not an interactive terminal.")}</p></details><ErrorNotice text={error} />
  </section>;
}
