import { useState } from "react";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import type { SystemPromptSnapshot, SystemPromptSnapshotSection } from "../../history/types.js";
import type { SystemPromptBlockData, SystemPromptDisclosureState } from "./model.js";

type PromptBlockData = Omit<SystemPromptBlockData, "requests"> & { readonly requests?: readonly SystemPromptSnapshot[] };

export function SystemPromptHistoryRow({ block, disclosure }: { block: LedgerBlock; disclosure?: SystemPromptDisclosureState }) {
  const t = useText();
  const data = promptData(block.data);
  const [open, setOpen] = useState(disclosure?.open ?? false), [copied, setCopied] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(disclosure?.selectedRequest);
  if (!data) return null;
  const { snapshot, update } = data;
  const sections = coalescePromptSections(snapshot.sections);
  const requests = data.requests ?? [snapshot];
  const stateSnapshot = requests.find(request => requestIdentity(request) === selectedRequest) ?? requests.at(-1)!;
  const stateSections = coalescePromptSections(stateSnapshot.runtimeState?.sections ?? []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([...sections, ...stateSections].map(section => section.content).join("\n\n"));
      setCopied(true); window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  return <details className="system-prompt-disclosure" open={open || undefined} onToggle={event => { const open = event.currentTarget.open; setOpen(open); disclosure?.setOpen(open); }}>
    <summary><span className="system-prompt-title">{update ? t("系统提示词更新", "System prompt update") : t("系统提示词", "System prompt")}</span><span className="system-prompt-model">{snapshot.model.provider} / {snapshot.model.model}</span></summary>
    {open ? <div className="system-prompt-body">
      <div className="system-prompt-actions"><span>{t("此处保留实际采用的指令，并可查看各 Step 的运行状态。", "Read-only instructions with execution state for each Step.")}</span><button type="button" onClick={() => { void copy(); }}>{copied ? t("已复制", "Copied") : t("复制全部", "Copy all")}</button></div>
      {snapshot.dynamicTailScope === undefined ? <p className="muted">{t("此旧版快照仅记录了 System Prompt 模块的动态指令，未包含其他模块的动态指令。", "This legacy snapshot only recorded dynamic instructions from System Prompt; instructions from other modules were not captured.")}</p> : null}
      {sections.map((section, index) => <section className="system-prompt-section" key={`${section.channel}/${section.role}/${index}`}>
        <header><span>{section.channel === "instructions" ? t("指令通道", "Instruction channel") : t("动态尾部", "Dynamic tail")}</span><code>{section.role}</code></header>
        <pre>{section.content}</pre>
      </section>)}
      <div className="system-prompt-actions"><label className="system-prompt-state-picker">{t("运行状态", "Execution state")} <select aria-label={t("选择运行状态快照", "Select execution state snapshot")} value={requestIdentity(stateSnapshot)} onChange={event => { setSelectedRequest(event.target.value); disclosure?.setSelectedRequest(event.target.value); setCopied(false); }}>
        {requests.map(request => <option key={requestIdentity(request)} value={requestIdentity(request)}>{request.stepId} · {request.capturedAt}</option>)}
      </select></label></div>
      {stateSnapshot.runtimeState === undefined ? <p className="muted">{t("此旧版快照未记录运行状态。", "This legacy snapshot did not capture execution state.")}</p> : stateSections.length === 0 ? <p className="muted">{t("此 Step 未包含运行状态消息。", "This Step contained no execution state messages.")}</p> : stateSections.map((section, index) => <section className="system-prompt-section" key={`state/${index}`}>
        <header><span>{t("当前 Step 运行状态", "Execution state for selected Step")}</span><code>{section.role}</code></header>
        <pre>{section.content}</pre>
      </section>)}
    </div> : null}
  </details>;
}

function requestIdentity(snapshot: SystemPromptSnapshot): string { return `${snapshot.runId}/${snapshot.stepId}`; }

function promptData(value: unknown): PromptBlockData | undefined {
  if (!value || typeof value !== "object" || !("snapshot" in value) || !("update" in value)) return undefined;
  const data = value as Partial<PromptBlockData>;
  return data.snapshot && typeof data.update === "boolean" ? data as PromptBlockData : undefined;
}

/** Keep persisted ownership detail while presenting each adjacent channel/role group once. */
export function coalescePromptSections(
  sections: readonly SystemPromptSnapshotSection[],
): readonly SystemPromptSnapshotSection[] {
  const result: SystemPromptSnapshotSection[] = [];
  for (const section of sections) {
    const previous = result.at(-1);
    if (previous?.channel === section.channel && previous.role === section.role) {
      result[result.length - 1] = Object.freeze({
        channel: previous.channel,
        role: previous.role,
        content: `${previous.content}\n\n${section.content}`,
      });
    } else {
      result.push(section);
    }
  }
  return Object.freeze(result);
}
