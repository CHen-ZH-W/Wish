import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";
export const WorkflowClientUi = { name: "ui-workflow", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "workflow", label: "Workflow", labelEn: "Workflow", area: "workspace", View: () => <FeaturePage model={model} featureKey="workflow" title="Workflow" description="查看执行账本与调度状态；不确定的副作用必须先核对，不自动重放。" descriptionEn="Inspect the execution ledger and scheduler state. Uncertain side effects require reconciliation and are never replayed automatically." empty="当前会话没有 Workflow 执行记录。" emptyEn="No Workflow execution records exist for this session." /> }));
} };
