import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import { GenericToolDetails } from "../../../apps/webui/client/ui/tool.js";
import { useText } from "../../../apps/webui/client/i18n.js";
export const ShellClientUi = { name: "ui-shell-tools", inject: ["wishUiSlots"], apply(ctx: Context) {
  ctx.effect(() => ctx.wishUiSlots.tool({ toolName: "bash", View: BashDetails }));
} };
function BashDetails({ block }: { block: LedgerBlock }) {
  const t = useText();
  let command: string | undefined;
  try { const value = JSON.parse(block.input ?? "{}"); if (typeof value.command === "string") command = value.command; } catch { /* Generic input remains readable. */ }
  return <div className="shell-tool-details">{command ? <><h3>{t("前台命令", "Foreground command")}</h3><pre>{command}</pre><p className="muted">{t("Bash 同步执行；长期工作通过 tmux 管理，不创建隐藏的后台 Bash 实例。", "Bash runs synchronously. Use tmux for long-running work; Wish does not create hidden background Bash processes.")}</p></> : null}<GenericToolDetails block={block} /></div>;
}
