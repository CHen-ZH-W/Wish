import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";
export const PlanClientUi = { name: "ui-plan", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "plan", label: "Plan", labelEn: "Plan", area: "workspace", View: () => <FeaturePage model={model} featureKey="plan" title="Plan" description="规划可以持续修改；提交评审不会自动退出，批准也不会自动执行。" descriptionEn="Plans can be revised over time. Submitting a review does not exit Plan mode, and approval does not start execution." empty="本会话尚无可评审计划。你可以在对话中要求进入 Plan 并继续规划。" emptyEn="No plan is ready for review. Ask to enter Plan mode and continue planning in the conversation." /> }));
} };
