import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";
import { GenericToolDetails } from "../../../apps/webui/client/ui/tool.js";
function fileView({ block }: { block: LedgerBlock }) {
  let path: string | undefined;
  try { const input = JSON.parse(block.input ?? "{}"); if (typeof input.path === "string") path = input.path; } catch { /* Keep the original body. */ }
  return <div className="file-tool-details">{path ? <p className="file-path"><code>{path}</code></p> : null}<GenericToolDetails block={block} /></div>;
}
function filePlugin(toolName: string) { return { name: `ui-filesystem-${toolName}`, inject: ["wishUiSlots"], apply(ctx: Context) { ctx.effect(() => ctx.wishUiSlots.tool({ toolName, View: fileView })); } }; }
export const ReadClientUi = filePlugin("read"), WriteClientUi = filePlugin("write"), EditClientUi = filePlugin("edit"), SearchClientUi = filePlugin("grep");
