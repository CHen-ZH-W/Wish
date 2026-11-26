import { memo, useEffect, useState } from "react";
import type { ConversationTurn, LedgerBlock } from "../projection/ledger.js";
import { useText } from "../i18n.js";
import { MarkdownContent } from "./markdown.js";

/** Keep model progress primary and the complete work record available on demand. */
export const ConversationProcess = memo(function ConversationProcess({ turn, connected, pauseFollow }: { turn: ConversationTurn; connected: boolean; pauseFollow?: () => void }) {
  return <>
    {turn.live ? <LiveRunView key="live" blocks={turn.process} connected={connected} waitingInput={!!turn.contributions?.some(block => block.status === "waiting-input")} /> : null}
    {turn.process.length ? <ProcessDisclosure key="process" blocks={turn.process} toolCount={turn.toolCount} failed={turn.failed} stopped={turn.stopped} live={turn.live} pauseFollow={pauseFollow} /> : null}
  </>;
});

const LiveRunView = memo(function LiveRunView({ blocks, connected, waitingInput }: { blocks: readonly LedgerBlock[]; connected: boolean; waitingInput: boolean }) {
  const t = useText();
  const latest = blocks.at(-1);
  const runningTool = [...blocks].reverse().find(block => block.kind === "tool" && toolStatus(block.status, t).tone === "pending");
  // Like the compact Codex status, accept a complete heading, never a reasoning paragraph.
  const heading = latest?.kind === "assistant" && !latest.text.trim()
    ? latest.reasoning?.slice(0, 512).match(/\*\*([^*\r\n]{1,80})\*\*/u)?.[1]?.trim()
    : undefined;
  const status = waitingInput ? t("等你回答后继续", "Waiting for your answer")
    : !connected ? t("正在核对运行状态", "Checking run status")
    : runningTool ? `${toolStatus(runningTool.status, t).label} · ${runningTool.title}`
    : latest?.kind === "assistant" && latest.text.trim() ? t("Wish 正在回复", "Wish is responding")
    : heading || t("Wish 正在工作", "Wish is working");
  return <section className="live-run" aria-busy={!waitingInput}>
    <div className="progress-feed">{blocks.map(block => block.kind === "assistant"
      ? block.text.trim() ? <ProgressMessage key={block.id} text={block.text} /> : null
      : <ActivityRow key={block.id} block={block} />)}</div>
    <header><span className="live-run-indicator" aria-hidden="true" /><strong role="status" aria-live="polite">{status}</strong></header>
  </section>;
});

const ProgressMessage = memo(function ProgressMessage({ text }: { text: string }) {
  return <div className="progress-message live-stream-text">{text}</div>;
});

const ProcessDisclosure = memo(function ProcessDisclosure({ blocks, toolCount, failed, stopped, live, pauseFollow }: { blocks: readonly LedgerBlock[]; toolCount: number; failed: boolean; stopped: boolean; live: boolean; pauseFollow: (() => void) | undefined }) {
  const t = useText(), hasReasoning = blocks.some(block => !!block.reasoning);
  const [expanded, setExpanded] = useState(failed);
  useEffect(() => { if (failed) setExpanded(true); }, [failed]);
  const summary = toolCount > 0
    ? t(`${toolCount} 个工具${hasReasoning ? " · 包含思考过程" : ""}`, `${toolCount} tool${toolCount === 1 ? "" : "s"}${hasReasoning ? " · reasoning included" : ""}`)
    : hasReasoning ? t("包含思考过程", "Reasoning included") : t(`${blocks.length} 项活动`, `${blocks.length} activit${blocks.length === 1 ? "y" : "ies"}`);
  return <details className={`process-disclosure${live ? " running" : failed ? " failed" : stopped ? " stopped" : ""}`} open={expanded} onFocusCapture={pauseFollow} onPointerDownCapture={pauseFollow} onToggle={event => {
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
  }}><summary><span className="process-state" aria-hidden="true" /><strong>{failed ? t("运行失败", "Run failed") : stopped ? t("运行已停止", "Run stopped") : t("查看过程", "View process")}</strong>{!stopped || blocks.length > 1 ? <small>{summary}</small> : null}</summary>
    {expanded ? <div className="process-list">{blocks.map(block => <ActivityRow key={block.kind === "assistant" ? block.id.replace(/\/reasoning$/u, "") : block.id} block={block} details />)}</div> : null}
  </details>;
});

const ActivityRow = memo(function ActivityRow({ block, details = false }: { block: LedgerBlock; details?: boolean }) {
  const t = useText();
  if (block.kind === "tool") {
    const status = toolStatus(block.status, t);
    return <article className={`process-activity tool-activity ${status.tone}`}><header><span className="activity-indicator" aria-hidden="true" /><strong>{block.title}</strong><span className="activity-status">{status.label}</span></header></article>;
  }
  if (block.kind === "system") return <article className={`process-activity ${block.status === "run.aborted" ? "process-stopped" : "process-error"}`}><header><span className="activity-indicator" aria-hidden="true" /><strong>{block.title}</strong></header>{block.text ? <p>{block.text}</p> : null}</article>;
  return <article className="process-activity model-activity">
    {details && block.reasoning ? <ReasoningDisclosure text={block.reasoning} /> : null}
    {block.text ? <div className="message-text message-markdown"><MarkdownContent source={block.text} /></div> : null}
  </article>;
});

const ReasoningDisclosure = memo(function ReasoningDisclosure({ text }: { text: string }) {
  const t = useText(), [expanded, setExpanded] = useState(false);
  return <details className="reasoning" open={expanded} onToggle={event => {
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
  }}><summary>{t("思考过程", "Thinking process")}</summary>{expanded ? <pre>{text}</pre> : null}</details>;
});

function toolStatus(status: string | undefined, t: ReturnType<typeof useText>): { label: string; tone: "pending" | "success" | "failed" | "neutral" } {
  switch (status) {
    case "tool.queued": return { label: t("排队中", "Queued"), tone: "pending" };
    case "tool.prepared": return { label: t("准备中", "Preparing"), tone: "pending" };
    case "tool.authorization_requested": return { label: t("等待批准", "Awaiting approval"), tone: "pending" };
    case "tool.dispatched": return { label: t("执行中", "Running"), tone: "pending" };
    case "tool.completed": return { label: t("已完成", "Completed"), tone: "success" };
    case "tool.failed": return { label: t("失败", "Failed"), tone: "failed" };
    case "tool.aborted": return { label: t("已停止", "Stopped"), tone: "failed" };
    case "tool.authorization_denied": return { label: t("未获批准", "Denied"), tone: "failed" };
    case "tool.recorded": return { label: t("已记录", "Recorded"), tone: "neutral" };
    default: return { label: status ?? t("已记录", "Recorded"), tone: "neutral" };
  }
}
