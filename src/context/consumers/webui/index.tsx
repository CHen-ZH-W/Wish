import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";
export const ContextClientUi = { name: "ui-context", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "context", label: "Context", labelEn: "Context", area: "workspace", View: () => <FeaturePage model={model} featureKey="context" title="Context" description="观察实际组装后的消息顺序、来源和预算；不重新计算或伪造模型请求。" descriptionEn="Inspect the assembled message order, sources, and budget without reconstructing a model request." empty="当前没有 Context 观察入口。" emptyEn="No Context inspection is available." /> }));
} };
