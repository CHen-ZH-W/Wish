import type { Context } from "@deepseek-ai/cordis";
import { WorkflowAttemptEvidenceSource } from "../adapters/workflow-evidence.js";
import "../curation/service.js";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
export const inject = ["memoryCuration", "workflow"];
export function apply(ctx: Context): void {
  let unregister: (() => Promise<void>) | undefined;
  const work = new PluginWorkOwner(ctx, { code: "memory_workflow_evidence", codeReload: true,
    close: async () => { await unregister?.(); } });
  const source = new WorkflowAttemptEvidenceSource(ctx.workflow.state);
  unregister = ctx.memoryCuration.registerSource({ id: source.id, scan: signal => work.run(() => source.scan(signal)) });
}
