import type { Context } from "@deepseek-ai/cordis";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition } from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import { ManagedToolOwner } from "../../tools/managed.js";
import type { Interactions } from "../service.js";
import type { InteractionInput } from "../types.js";
import { input } from "../validation.js";

const option = { type: "object", additionalProperties: false, properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" } }, required: ["id", "label"] };
export const ASK_USER_SCHEMA = JSON.stringify({ type: "object", additionalProperties: false, properties: {
  title: { type: "string" }, description: { type: "string" }, questions: { type: "array", minItems: 1, items: {
    type: "object", additionalProperties: false, properties: { id: { type: "string" }, question: { type: "string" }, why: { type: "string" }, multiple: { type: "boolean" }, options: { type: "array", items: option } }, required: ["id", "question"] } },
}, required: ["title", "questions"] });

export function createAskUserTool(interactions: Pick<Interactions, "open" | "wait" | "interrupt">, ownerSignal?: AbortSignal): ToolDefinition<"ask_user", InteractionInput, unknown, WishToolExecutionContext> {
  return {
    name: "ask_user",
    description: "Ask for a meaningful product decision or clarification directly in the conversation. Supply clear questions and optional comparable choices with tradeoffs. Free-text answers are always supported; recommended choices are not automatically selected. Use only when user input is needed, not as a mandatory step for clear requests. This Tool waits for the actual user's answer without polling the model or imposing a response timeout. Do independent work before asking; do not send duplicate questions. The user may instead continue in the normal composer. It never grants implementation permissions or approves a Plan.",
    inputSchemaJson: ASK_USER_SCHEMA, executionMode: "sequential", recoveryPolicy: "needs-reconciliation",
    parse(raw) { try { return { ok: true, input: input(raw) }; } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; } },
    resolveCapabilities(_input, context) { return { requirements: [{ capability: "runtime.control", resources: [`interaction.ask:${context.permissions.subject.sessionId}`] }] }; },
    async execute(spec, context, grant, signal) {
      assertActiveToolAuthorizationGrant(grant, { toolName: "ask_user" });
      const turn = context.userTurn, subject = context.permissions.subject;
      if (!turn || turn.runId !== subject.runId || turn.userTurnId !== subject.userTurnId || !grant.capabilities.requirements.some(r => r.capability === "runtime.control" && r.resources.includes(`interaction.ask:${subject.sessionId}`))) throw new ToolExecutionError("permission_denied", "Interaction identity or authorization changed");
      const merged = ownerSignal && signal ? AbortSignal.any([ownerSignal, signal]) : ownerSignal ?? signal;
      merged?.throwIfAborted();
      const request = await interactions.open({ ...spec, sessionId: subject.sessionId, runId: turn.runId, userTurnId: turn.userTurnId, stepId: subject.stepId, toolCallId: grant.subject.id });
      try {
        const resolved = await interactions.wait(request, merged);
        const value = { requestId: resolved.id, status: resolved.status, questions: resolved.questions, answers: resolved.answers ?? [], reason: resolved.reason,
          note: resolved.status === "answered" ? "These choices and text were submitted by the user. Continue using this feedback; this is not a permission grant." : "No choice was confirmed. The user may have continued in the normal conversation. Read the current input; do not invent an answer." };
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        await interactions.interrupt(subject.sessionId, "run-stopped", turn.runId).catch(() => {});
        throw error;
      }
    },
  };
}
export default {
  name: "interaction-tools", inject: ["tools", "interactions"],
  apply(ctx: Context) {
    const abort = new AbortController();
    let pending = 0;
    const owner = new ManagedToolOwner(ctx, { code: "interaction_tools", codeReload: true, blocked: () => pending ? "interaction_tool_waiting_for_user" : undefined, beforeDrain: () => abort.abort(new DOMException("Interaction tool unloaded", "AbortError")) });
    const tool = createAskUserTool(ctx.interactions, abort.signal);
    owner.register({ ...tool, async execute(...args) { pending++; try { return await tool.execute(...args); } finally { pending--; } } });
  },
};
