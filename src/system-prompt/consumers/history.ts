import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ContextProjection } from "../../core/context/projector.js";
import type { ContextInput } from "../../context/types.js";
import { registerManagedContextObserver } from "../../context/managed.js";
import type { SystemPromptSnapshotSection } from "../history/types.js";
import type { SystemPromptSnapshotInput } from "../history/types.js";

/** Capture exact ready-request prompt material without changing Context's redacted observer. */
export default {
  name: "system-prompt-history-consumer",
  inject: ["contextEngine", "systemPromptHistory"],
  apply(ctx: Context): void {
    registerManagedContextObserver(ctx, "system-prompt-history", async (input, projection) => {
      const snapshot = projectSystemPromptSnapshot(input, projection);
      if (snapshot !== undefined) await ctx.systemPromptHistory.record(snapshot);
    });
  },
};

export function projectSystemPromptSnapshot(
  input: ContextInput,
  projection: ContextProjection,
): SystemPromptSnapshotInput | undefined {
  if (projection.status !== "ready") return undefined;
  const sections: SystemPromptSnapshotSection[] = [
    ...projection.request.instructions.map(instruction => Object.freeze({
      channel: "instructions" as const,
      role: instruction.role,
      content: instruction.content,
    })),
    ...dynamicSystemPromptSections(projection),
  ];
  if (sections.length === 0) return undefined;
  const stateSections: readonly SystemPromptSnapshotSection[] = Object.freeze(projection.includedItems.flatMap(item =>
    item.kind === "state" && item.placement === "dynamic_tail" && (item.message.role === "system" || item.message.role === "developer")
      ? [Object.freeze({ channel: "dynamic_tail" as const, role: item.message.role, content: item.message.content })] : []));
  return Object.freeze({
    sessionId: input.sessionId,
    runId: input.runId,
    userTurnId: input.userTurnId,
    stepId: input.stepId,
    capturedAt: input.runtime.capturedAt,
    model: projection.request.model,
    dynamicTailScope: "all-instructions",
    digest: createHash("sha256").update(JSON.stringify(sections)).digest("hex"),
    sections: Object.freeze(sections),
    runtimeState: Object.freeze({
      digest: createHash("sha256").update(JSON.stringify(stateSections)).digest("hex"),
      sections: stateSections,
    }),
  });
}

function dynamicSystemPromptSections(projection: ContextProjection): readonly SystemPromptSnapshotSection[] {
  // Use the final inclusion order, which is also the order projected to the model.
  return projection.includedItems.flatMap(item => item.kind === "instruction" && item.placement === "dynamic_tail" &&
    (item.message.role === "system" || item.message.role === "developer")
    ? [Object.freeze({ channel: "dynamic_tail" as const, role: item.message.role, content: item.message.content })]
    : []);
}
