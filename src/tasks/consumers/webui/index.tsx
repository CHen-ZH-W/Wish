import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import { FeaturePage } from "../../../apps/webui/client/ui/feature.js";
export const TasksClientUi = { name: "ui-tasks", inject: ["wishFeatures", "wishUiSlots"], apply(ctx: Context) {
  const model = ctx.wishFeatures;
  ctx.effect(() => ctx.wishUiSlots.panel({ id: "tasks", label: "任务图", labelEn: "Tasks", area: "workspace", View: () => <FeaturePage model={model} featureKey="tasks" title="任务图" titleEn="Tasks" description="查看 Plan 绑定的版本与依赖关系；运行状态仍由 Tasks 和 Workflow 管理。" descriptionEn="Inspect the Plan version and dependencies. Tasks and Workflow still own execution state." empty="当前会话还没有任务图。" emptyEn="No task graph exists for this session." /> }));
} };
