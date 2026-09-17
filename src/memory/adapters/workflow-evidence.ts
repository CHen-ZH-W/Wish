import type { Workflow } from "../../workflow/types.js";
import { hash } from "../validation.js";
import type { CurationEvidence, CurationEvidenceSource } from "../curation/types.js";
import { clipEvidenceText, snapshotEvidence } from "../curation/validation.js";

/** Optional adapter: Memory core and Runtime evidence do not depend on Workflow. */
export class WorkflowAttemptEvidenceSource implements CurationEvidenceSource {
  readonly id = "workflow-attempts";
  constructor(private readonly workflow: Pick<Workflow, "list">) {}
  async scan(signal?: AbortSignal): Promise<readonly CurationEvidence[]> {
    const result: CurationEvidence[] = [];
    for (const workflow of await this.workflow.list()) {
      signal?.throwIfAborted();
      for (const step of workflow.steps) for (const attempt of step.attempts) {
        if (!["completed", "failed", "cancelled", "interrupted"].includes(attempt.status)) continue;
        const facts = { workflowId: workflow.id, taskId: step.task.id, attempt }, digest = hash(facts);
        result.push(snapshotEvidence({ id: `workflow-${digest}`, sourceId: this.id, sessionId: workflow.owner.parentSessionId,
          runId: workflow.owner.parentRunId, outcome: attempt.status === "interrupted" ? "unknown" : attempt.status as "completed" | "failed" | "cancelled",
          appliesTo: `Workspace ${workflow.owner.workspaceRoot}; task ${step.task.id}. Attempt completion does not establish validation.`,
          text: clipEvidenceText(JSON.stringify({ untrustedAttemptFacts: facts })),
          references: [{ kind: "workflow", id: `${workflow.id}:${step.task.id}:${attempt.id}`, revision: digest, digest }] }));
      }
    }
    return Object.freeze(result);
  }
}
