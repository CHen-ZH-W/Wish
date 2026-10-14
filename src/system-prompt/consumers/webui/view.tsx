import { useState } from "react";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import type { SystemPromptSnapshot, SystemPromptSnapshotSection } from "../../history/types.js";

interface PromptBlockData { readonly snapshot: SystemPromptSnapshot; readonly update: boolean; }

export function SystemPromptHistoryRow({ block }: { block: LedgerBlock }) {
  const t = useText();
  const data = promptData(block.data);
  const [open, setOpen] = useState(false), [copied, setCopied] = useState(false);
  if (!data) return null;
  const { snapshot, update } = data;
  const sections = coalescePromptSections(snapshot.sections);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sections.map(section => section.content).join("\n\n"));
      setCopied(true); window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  return <details className="system-prompt-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="system-prompt-title">{update ? t("系统提示词更新", "System prompt update") : t("系统提示词", "System prompt")}</span><span className="system-prompt-model">{snapshot.model.provider} / {snapshot.model.model}</span></summary>
    {open ? <div className="system-prompt-body">
      <div className="system-prompt-actions"><span>{t("此处保留该 Step 实际采用的只读快照。", "Read-only snapshot used by this Step.")}</span><button type="button" onClick={() => { void copy(); }}>{copied ? t("已复制", "Copied") : t("复制全部", "Copy all")}</button></div>
      {sections.map((section, index) => <section className="system-prompt-section" key={`${section.channel}/${section.role}/${index}`}>
        <header><span>{section.channel === "instructions" ? t("指令通道", "Instruction channel") : t("动态尾部", "Dynamic tail")}</span><code>{section.role}</code></header>
        <pre>{section.content}</pre>
      </section>)}
    </div> : null}
  </details>;
}

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
