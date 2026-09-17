import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";
export const MemoryClientUi = { name: "ui-memory", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "memory", label: "Memory", labelEn: "Memory", area: "workspace", View: () => <FeaturePage model={model} featureKey="memory" title="Memory" description="审核属于当前会话的候选记忆。模型不能代替人类采纳或拒绝。" descriptionEn="Review memory proposals for this session. The model cannot accept or reject them for you." empty="当前会话没有待审核记忆候选。此页面不是整个记忆库的编辑器。" emptyEn="No memory proposals need review in this session. This is not an editor for the entire memory store." /> }));
} };
