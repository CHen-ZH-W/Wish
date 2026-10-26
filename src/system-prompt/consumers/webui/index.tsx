import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { SystemPromptHistoryClientModel, SYSTEM_PROMPT_LEDGER_VIEW } from "./model.js";
import { SystemPromptHistoryRow } from "./view.js";
import type { LedgerBlock } from "../../../apps/webui/client/projection/ledger.js";

export const SystemPromptHistoryClientUi = {
  name: "ui-system-prompt-history",
  inject: ["wishConnection", "wishSession", "wishUiSlots"],
  apply(ctx: Context): void {
    const model = new SystemPromptHistoryClientModel(ctx.wishConnection, ctx.wishSession);
    const HistoryRow = ({ block }: { block: LedgerBlock }) => {
      const disclosure = model.disclosure(block.id);
      return <SystemPromptHistoryRow key={disclosure.identity} block={block} disclosure={disclosure} />;
    };
    ctx.effect(() => () => model.close(), "System Prompt history client model");
    ctx.effect(() => ctx.wishUiSlots.ledger({ id: SYSTEM_PROMPT_LEDGER_VIEW, source: model, View: HistoryRow }), "System Prompt ledger contribution");
  },
};
