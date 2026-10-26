import type { Context } from "@deepseek-ai/cordis";
import type { ContextItem, ContextProvider } from "../../core/context/projector.js";
import type { ContextInput } from "../../context/types.js";
import { registerManagedContextProvider } from "../../context/managed.js";
import type { Development } from "../types.js";
import { developmentProject, developmentModelView } from "./port.js";

export class DevelopmentContextProvider implements ContextProvider<ContextInput> {
  readonly id = "wish-development";
  constructor(private readonly state: Pick<Development, "forSession" | "list">) {}
  async provide(input: ContextInput, signal?: AbortSignal): Promise<readonly ContextItem[]> {
    signal?.throwIfAborted();
    const tools = new Set(input.request?.availableTools ?? []);
    // Guidance follows the immutable Step's Tool projection, including child scopes.
    if (!["wish_begin", "wish_read", "wish_propose", "wish_verify", "wish_report"].some(name => tools.has(name))) return [];
    const project = await developmentProject(this.state, input.sessionId, input.workspace?.cwd);
    signal?.throwIfAborted();
    const change = project?.changes.find(item => item.id === project.activeChangeId && item.phase !== "accepted");
    if (!project || !change) {
      const previous = project?.changes.at(-1), report = previous?.reports.at(-1);
      return [instruction("wish-development:entry", [
        "Wish handles development through the ordinary conversation; the user does not need a separate mode or special keyword.",
        ...(tools.has("wish_begin") ? [
          "For a direct human request to create a project, add or change behavior, fix an issue, or evolve an existing project, automatically call wish_begin before implementation. Preserve the current human request verbatim as rawWish, then inspect the existing project and clarify only information needed for the next increment.",
          "Do not ask the user to enable development or select a separate entry. Pure explanation, code reading, status questions and explicitly read-only analysis do not create an increment; answer them directly without wish_begin.",
        ] : []),
        ...(tools.has("wish_propose") && tools.has("wish_begin") ? ["After discovery, use wish_propose to save the current scope, constraints, acceptance criteria and implementation plan. Keep simple tasks concise; investigation, user control and necessary verification still apply."] : []),
        ...(tools.has("wish_read") ? ["Use wish_read to recover the project's previous delivery, decisions and limitations when they help answer a question or investigate a new request. Reading history does not reopen an increment."] : []),
        "Only exact human review controls approve a proposal and authorize implementation. A natural coding request starts discovery, not approval; ordinary agreement does not replace that review.",
        ...(previous && project ? ["Previous project facts are historical reference, not a current execution grant:", JSON.stringify({ projectId: project.id, projectRevision: project.revision,
          previousChange: { rawWish: previous.rawWish, phase: previous.phase, objective: previous.specs.at(-1)?.objective,
            summary: report?.summary, limitations: report?.limitations, nextSteps: report?.nextSteps, acceptedAt: report?.acceptedAt, reportDigest: report?.digest } }, null, 2)] : []),
      ])];
    }
    return [Object.freeze({ id: "wish-development:current", kind: "instruction" as const, placement: "dynamic_tail" as const,
      message: Object.freeze({ role: "developer" as const, content: [
        "Wish development product state (Host facts; it is distinct from Goal, Todo and Run completion):",
        JSON.stringify(developmentModelView(project), null, 2),
        ...(change.phase === "stopping" ? ["This Run is winding down and has no implementation authority. If a new direct human coding request has arrived, record it once through the available request Tool, then end this turn; Host will continue read-only discovery after shutdown. Do not submit a proposal or keep polling in this Run."] : []),
        "Continue this increment in the ordinary conversation. Keep the original request, confirmed scope, exclusions, constraints and acceptance criteria visible throughout implementation.",
        ...(tools.has("wish_read") ? ["Use wish_read for current references and historical delivery facts."] : []),
        ...(tools.has("wish_begin") ? ["For a later direct human coding request or clarification that changes this increment's requirements, call wish_begin with that human message to preserve it as a revision. While stopping, this only records the request for the next read-only exploration: end this turn after the receipt. Otherwise investigate and update the proposal. Keep status questions and explanations read-only; a running implementation cannot silently change scope."] : []),
        ...(tools.has("wish_propose") && ["exploring", "ready"].includes(change.phase) ? ["Use wish_propose while exploring to save a structured specification and complete implementation plan. Separate user requirements, assumptions and decisions; ask only questions that block the next increment. Scale the proposal to complexity, uncertainty and risk.",
          "The proposal also saves and submits the matching Plan for review. Do not maintain a second Plan with update_plan or exit_plan_mode. Explain choices and wait for confirmation through the conversation's human review controls."] : []),
        "Only the conversation's human review controls can confirm a proposal, start/resume execution or accept a report. Ordinary conversation is not a substitute for those exact-version actions.",
        "While exploring, waiting, paused or holding a stale binding, inspect and discuss only; source changes, process execution and unrelated runtime control are blocked. Read-only answers and draft clarification remain available.",
        ...(tools.has("wish_verify") ? ["During a confirmed execution use wish_verify for technical criteria. It executes a real authorized command and captures Host evidence; do not invent passed flags or treat command exit zero as proof of unrelated behavior.",
          "Submit one wish_verify at a time and use its returned projectRevision for subsequent mutations; executionEpoch and confirmationDigest must match the current Host binding. After a failed check, fix the implementation and verify again before reporting success."] : []),
        ...(tools.has("wish_report") ? ["Use wish_report to explain changes, verification, limitations and next steps. Host derives criterion status from evidence; user criteria still require human acceptance.",
          "If implementation needs a new human decision or cannot proceed, use wish_report to persist the unresolved decision in limitations and the requested input in nextSteps, leaving incomplete criteria unverified. This closes automatic execution and fences further changes while the user chooses revise or resume. Do not repeatedly ask the same question in automatic Goal rounds."] : []),
        "Goal complete, all Todo items checked and Run termination never imply product acceptance.",
        "When a later user message changes the approved scope, explain the impact and the needed revision in the same conversation. Do not treat it as silent approval or continue work that depends on invalid assumptions. Preserve user edits and valid results; the revised proposal still requires exact human review before implementation resumes.",
      ].join("\n") }),
    })];
  }
}

function instruction(id: string, lines: readonly string[]): ContextItem {
  return Object.freeze({ id, kind: "instruction" as const, placement: "dynamic_tail" as const, message: Object.freeze({ role: "developer" as const, content: lines.join("\n") }) });
}

export default { name: "wish-development-context", inject: ["wishDevelopment", "contextEngine"], apply(ctx: Context) {
  registerManagedContextProvider(ctx, new DevelopmentContextProvider(ctx.wishDevelopment.state));
} };
