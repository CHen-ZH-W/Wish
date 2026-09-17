import type { Context } from "@deepseek-ai/cordis";
import { WorkflowAttemptEvidenceSource } from "../adapters/workflow-evidence.js";
import "../curation/service.js";
import { registerPluginLifecycle } from "../../boot/plugin-control/lifecycle.js";
export const inject = ["memoryCuration", "workflow"];
export function apply(ctx: Context): void {
  const unregister = ctx.memoryCuration.registerSource(new WorkflowAttemptEvidenceSource(ctx.workflow.state));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= unregister();
  registerPluginLifecycle(ctx, () => ({ disposition: "direct", code: "memory_workflow_evidence_idle" }),
    () => ({ close, release() {} }));
  ctx.effect(() => close, "memory.curation.workflow.release");
}
