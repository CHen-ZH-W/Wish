import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";

export const GoalClientUi = {
  name: "ui-goal",
  inject: ["wishFeatures", "wishUiSlots"],
  apply(ctx: Context) {
    const model = ctx.wishFeatures;
    ctx.effect(() => ctx.wishUiSlots.panel({
      id: "goal",
      label: "Goal",
      labelEn: "Goal",
      area: "workspace",
      View: () => <FeaturePage
        model={model}
        featureKey="goal"
        title="Goal"
        description="查看持久目标、轮次预算与运行状态；人工操作使用目标 ID 和修订号进行 CAS 校验。"
        descriptionEn="Review the durable goal, round budget, and runtime state. Human actions use goal identity and revision CAS."
        empty="本会话尚无 Goal。"
        emptyEn="This session has no Goal."
      />,
    }));
  },
};
