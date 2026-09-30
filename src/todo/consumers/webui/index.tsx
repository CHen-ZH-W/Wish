import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";

export const TodoClientUi = {
  name: "ui-todo",
  inject: ["wishFeatures", "wishUiSlots"],
  apply(ctx: Context) {
    const model = ctx.wishFeatures;
    ctx.effect(() => ctx.wishUiSlots.panel({
      id: "todo",
      label: "Todo",
      labelEn: "Todo",
      area: "workspace",
      View: () => <FeaturePage
        model={model}
        featureKey="todo"
        title="Todo"
        description="显示当前 UserTurn 由模型维护的任务清单；新一轮输入会重置清单。"
        descriptionEn="Shows the model-maintained task list for the current UserTurn. A new input resets the list."
        empty="当前 UserTurn 尚无 Todo。"
        emptyEn="The current UserTurn has no Todo items."
      />,
    }));
  },
};
