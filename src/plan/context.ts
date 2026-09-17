import type {
  ContextItem,
  ContextProvider,
} from "../core/context/projector.js";
import type { ContextInput } from "../context/types.js";
import type { Plan } from "./types.js";

export const PLAN_CONTEXT_PROVIDER_ID = "plan-mode";

export class PlanContextProvider implements ContextProvider<ContextInput> {
  readonly id = PLAN_CONTEXT_PROVIDER_ID;

  constructor(private readonly plan: Plan) {}

  async provide(
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<readonly ContextItem[]> {
    signal?.throwIfAborted();
    const state = await this.plan.get({
      sessionId: input.sessionId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (state?.active !== true) return Object.freeze([]);
    const document = state.document;
    const facts = Object.freeze({
      sessionId: state.sessionId,
      stateVersion: state.version,
      ...(state.review === undefined ? {} : { review: state.review }),
      ...(state.goal === undefined ? {} : { goal: state.goal }),
      ...(document === undefined
        ? {}
        : { planVersion: document.version, planDigest: document.digest }),
    });
    return Object.freeze([Object.freeze({
      id: `${PLAN_CONTEXT_PROVIDER_ID}:active`,
      kind: "instruction" as const,
      placement: "dynamic_tail" as const,
      message: Object.freeze({
        role: "developer" as const,
        content: [
          "Plan mode is active for this Session.",
          "Inspect and reason only: source mutation, shell execution, and unrelated runtime control are forbidden by host policy.",
          "Use update_plan to save the complete current plan, read_plan to recover it, and exit_plan_mode to submit that exact saved version for human review.",
          "A pending review keeps Plan mode active. End your response and await the user; do not poll or repeatedly submit. New user feedback supersedes the pending review. Revise the plan before submitting again.",
          "After cancellation or changes requested, continue planning with the user. Only a human review decision approves the document.",
          "Approving a Plan only freezes it. Execution capabilities become available on the next Agent Step; approval does not start a Workflow.",
          "Current Plan facts:",
          JSON.stringify(facts, null, 2),
        ].join("\n"),
      }),
    })]);
  }
}
