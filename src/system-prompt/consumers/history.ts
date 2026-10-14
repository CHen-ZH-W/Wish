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
  return Object.freeze({
    sessionId: input.sessionId,
    runId: input.runId,
    userTurnId: input.userTurnId,
    stepId: input.stepId,
    capturedAt: input.runtime.capturedAt,
    model: projection.request.model,
    digest: createHash("sha256").update(JSON.stringify(sections)).digest("hex"),
    sections: Object.freeze(sections),
  });
}

function dynamicSystemPromptSections(projection: ContextProjection): readonly SystemPromptSnapshotSection[] {
  const included = new Set(projection.includedItems.map(item => item.id));
  return projection.providerGroups.flatMap(group => group.providerId === "system-prompt"
    ? group.items.flatMap(item => item.kind === "instruction" && item.placement === "dynamic_tail" && included.has(item.id)
      ? [Object.freeze({ channel: "dynamic_tail" as const, role: item.message.role as "system" | "developer", content: item.message.content })]
      : [])
    : []);
}
