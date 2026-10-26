import { useMemo } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../apps/webui/client/plugins.js";
import type { UiSessionSidebarViewProps } from "../../../apps/webui/client/slots.js";
import { EvolutionClientModel } from "./model.js";
import { EvolutionView } from "./view.js";

export const EvolutionClientUi = { name: "ui-evolution", inject: ["wishConnection", "wishUiSlots"], apply(ctx: Context): void {
  const View = ({ sessionId }: UiSessionSidebarViewProps) => {
    const model = useMemo(() => new EvolutionClientModel(ctx.wishConnection), []);
    return <EvolutionView model={model} sessionId={sessionId} />;
  };
  ctx.effect(() => ctx.wishUiSlots.sessionSidebar({ id: "evolution", kind: "evolution", order: 70, label: "自进化", labelEn: "Evolution",
    description: "从任务经验提出能力改进，查看候选与验证过程", descriptionEn: "Propose capability improvements from task experience", icon: "plug", View }), "Evolution workspace presentation");
} };
