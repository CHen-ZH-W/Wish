import type { Context } from "@deepseek-ai/cordis";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition } from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import { ManagedToolOwner } from "../../tools/managed.js";
import type { DevelopmentProject, DevelopmentSpecInput } from "../types.js";
import { validateSpec } from "../validation.js";
import { currentDevelopment, developmentProject, directHumanRequest, developmentModelView, developmentToolError, requireExecution, type DevelopmentBindingInput, type DevelopmentConsumerPort } from "./port.js";
import { createDevelopmentVerificationTool } from "./verification-tool.js";
import { bindingSchema, parseBinding, keys, positive, text, strings, parseInput, schema } from "./tool-input.js";

interface ProposeInput { readonly expectedRevision: number; readonly spec: DevelopmentSpecInput }
interface ReportInput extends DevelopmentBindingInput { readonly expectedRevision: number; readonly summary: string; readonly limitations: readonly string[]; readonly nextSteps: readonly string[] }
export interface DevelopmentToolOutput { readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly project?: unknown }
const textArray = { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 4000 } };
const level = { enum: ["low", "medium", "high"] };
export const DEVELOPMENT_SPEC_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { objective: { type: "string", minLength: 1, maxLength: 4000 }, scope: textArray, outOfScope: textArray, constraints: textArray,
    criteria: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
      properties: { id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1, maxLength: 4000 }, kind: { enum: ["technical", "user"] } }, required: ["id", "text", "kind"] } },
    questions: textArray, assumptions: textArray, decisions: textArray, planMarkdown: { type: "string", minLength: 1, maxLength: 100000 },
    assessment: { type: "object", additionalProperties: false, properties: { complexity: level, uncertainty: level, risk: level,
      recommendedLevel: { enum: ["light", "standard", "careful"] }, reason: { type: "string", minLength: 1, maxLength: 4000 } },
      required: ["complexity", "uncertainty", "risk", "recommendedLevel", "reason"] },
    artifacts: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, properties: {
      kind: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 }, version: { type: "integer", minimum: 1 }, digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, required: ["kind", "id", "version", "digest"] } },
  }, required: ["objective", "scope", "outOfScope", "constraints", "criteria", "questions", "assumptions", "decisions", "planMarkdown", "assessment"],
};

export function createDevelopmentTools(port: DevelopmentConsumerPort): readonly ToolDefinition<string, any, DevelopmentToolOutput, WishToolExecutionContext>[] {
  return [
    {
      name: "wish_begin", description: "Begin or revise read-only discovery for a direct human request to create or change a project in this ordinary conversation. No separate mode or special keyword is needed. Preserve their original request; explanation, code reading and status questions do not require this Tool. Existing implementation must stop before changing its request. Never confirms or starts implementation.",
      inputSchemaJson: schema({ rawWish: { type: "string", minLength: 1, maxLength: 16000 }, title: { type: "string", minLength: 1, maxLength: 1000 } }, ["rawWish"]),
      executionMode: "sequential", recoveryPolicy: "needs-reconciliation",
      parse: input => parseInput(() => { keys(input, ["rawWish", "title"]); text(input.rawWish, "rawWish", 16000); if (input.title !== undefined) text(input.title, "title", 1000); return input as unknown as { rawWish: string; title?: string }; }),
      resolveCapabilities: (_input, context) => controlCapability("runtime.control", "begin", context),
      async execute(input: { rawWish: string; title?: string }, context, grant, signal) {
        assertControl(grant, "wish_begin", "runtime.control", "begin", context);
        try {
          const human = await directHumanRequest(port, context, input.rawWish, signal);
          signal?.throwIfAborted();
          const current = await currentDevelopment(port.state, context.permissions.subject.sessionId, context.workspace.root);
          if (current && current.change.sessionId !== context.permissions.subject.sessionId) throw new ToolExecutionError("conflict", "This workspace's active increment belongs to another conversation. Read its current scope and continue in that owning conversation before changing requirements.");
          const unsettled = current?.change.starts.filter(start => ["dispatching", "running"].includes(start.status)) ?? [];
          const deferred = current?.change.phase === "stopping" && unsettled.length > 0 && unsettled.every(start => start.runId === context.userTurn!.runId);
          if (unsettled.length && !deferred) throw new ToolExecutionError("conflict", "Implementation is still active. Report or stop that execution and wait for it to finish before revising the request; ordinary conversation never silently approves a new scope.");
          if (deferred && !human.conversationInput) throw new ToolExecutionError("permission_denied", "No newly accepted human message is available for the deferred revision; do not replace it with the old request");
          const project = await port.begin({ sessionId: context.permissions.subject.sessionId, workspaceRoot: context.workspace.root,
            rawWish: human.rawWish, requestId: human.requestId, runId: context.userTurn!.runId, ...(input.title === undefined ? {} : { title: input.title }) });
          return output(project, deferred ? "The new human request has been recorded. This Run is winding down; after it settles, Wish will continue read-only discovery in the same conversation. End this turn now; do not continue implementation or submit another proposal in this Run." : undefined);
        } catch (error) { throw developmentToolError(error); }
      },
    },
    {
      name: "wish_read", description: "Read this Session's Wish project, active increment, exact versions, confirmed scope and Host verification evidence.",
      inputSchemaJson: schema({}, []), executionMode: "parallel", recoveryPolicy: "retry-safe",
      parse: input => parseInput(() => { keys(input, []); return {}; }),
      resolveCapabilities: (_input, context) => controlCapability("runtime.read", "read", context),
      async execute(_input, context, grant) {
        assertControl(grant, "wish_read", "runtime.read", "read", context);
        return output(await developmentProject(port.state, context.permissions.subject.sessionId, context.workspace.root));
      },
    },
    {
      name: "wish_propose", description: "Save a complete structured Wish specification and implementation plan for human confirmation. Never approves or starts execution. Pause and revise an active increment through the human product surface before replacing it.",
      inputSchemaJson: schema({ expectedRevision: { type: "integer", minimum: 1 }, spec: DEVELOPMENT_SPEC_SCHEMA }, ["expectedRevision", "spec"]),
      executionMode: "sequential", recoveryPolicy: "needs-reconciliation",
      parse: input => parseInput(() => { keys(input, ["expectedRevision", "spec"]); positive(input.expectedRevision, "expectedRevision");
        const spec = validateSpec(input.spec as DevelopmentSpecInput);
        keys(input.spec as Record<string, unknown>, ["objective", "scope", "outOfScope", "constraints", "criteria", "questions", "assumptions", "decisions", "planMarkdown", "assessment", "artifacts"]);
        for (const criterion of spec.criteria) keys(criterion as unknown as Record<string, unknown>, ["id", "text", "kind"]);
        keys(spec.assessment as unknown as Record<string, unknown>, ["complexity", "uncertainty", "risk", "recommendedLevel", "reason"]);
        for (const artifact of spec.artifacts ?? []) keys(artifact as unknown as Record<string, unknown>, ["kind", "id", "version", "digest"]);
        return { expectedRevision: input.expectedRevision as number, spec }; }),
      resolveCapabilities: (_input, context) => controlCapability("runtime.control", "propose", context),
      async execute(input: ProposeInput, context, grant) {
        assertControl(grant, "wish_propose", "runtime.control", "propose", context);
        try {
          const current = await currentDevelopment(port.state, context.permissions.subject.sessionId, context.workspace.root);
          if (!current) throw new ToolExecutionError("not_found", "For a new human coding request, call wish_begin in this conversation before saving its proposal");
          if (current.change.sessionId !== context.permissions.subject.sessionId || !["exploring", "ready"].includes(current.change.phase)) {
            throw new ToolExecutionError("conflict", "Pause and revise the current increment before proposing a replacement");
          }
          return output(await port.propose({ projectId: current.project.id, changeId: current.change.id, sessionId: context.permissions.subject.sessionId,
            expectedRevision: input.expectedRevision, spec: input.spec }));
        } catch (error) { throw developmentToolError(error); }
      },
    },
    {
      name: "wish_report", description: "Save a user-readable delivery explanation, limitations and next steps. Host derives criterion status from actual wish_verify receipts. This cannot assert passed, accept the project, or replace human acceptance.",
      inputSchemaJson: schema({ ...bindingSchema, expectedRevision: { type: "integer", minimum: 1 }, summary: { type: "string", minLength: 1, maxLength: 16000 }, limitations: textArray, nextSteps: textArray }, ["expectedRevision", "executionEpoch", "confirmationDigest", "summary", "limitations", "nextSteps"]),
      executionMode: "sequential", recoveryPolicy: "needs-reconciliation",
      parse: input => parseInput(() => { keys(input, ["expectedRevision", "executionEpoch", "confirmationDigest", "summary", "limitations", "nextSteps"]);
        positive(input.expectedRevision, "expectedRevision"); parseBinding(input); text(input.summary, "summary", 16000); strings(input.limitations, "limitations"); strings(input.nextSteps, "nextSteps"); return input as unknown as ReportInput; }),
      resolveCapabilities: (_input, context) => controlCapability("runtime.control", "report", context),
      async execute(input: ReportInput, context, grant) {
        assertControl(grant, "wish_report", "runtime.control", "report", context);
        try {
          const current = await requireExecution(port, context, input);
          return output(await port.report({ projectId: current.project.id, changeId: current.change.id, sessionId: context.permissions.subject.sessionId,
            expectedRevision: input.expectedRevision, runId: context.permissions.subject.runId, summary: input.summary, limitations: input.limitations, nextSteps: input.nextSteps }));
        } catch (error) { throw developmentToolError(error); }
      },
    },
  ];
}

function controlCapability(capability: "runtime.read" | "runtime.control", action: string, context: WishToolExecutionContext) { return { requirements: [{ capability, resources: [`wish.${action}:${context.permissions.subject.sessionId}`] }] }; }
function assertControl(grant: Parameters<typeof assertActiveToolAuthorizationGrant>[0], toolName: string, kind: "runtime.read" | "runtime.control", action: string, context: WishToolExecutionContext): void {
  assertActiveToolAuthorizationGrant(grant, { toolName });
  if (!grant.capabilities.requirements.some(item => item.capability === kind && item.resources.includes(`wish.${action}:${context.permissions.subject.sessionId}`))) throw new ToolExecutionError("permission_denied", "Wish Tool grant does not cover this operation");
}
function output(project?: DevelopmentProject, note?: string): DevelopmentToolOutput { return { content: [{ type: "text", text: JSON.stringify({ project: project ? developmentModelView(project) : null, ...(note ? { note } : {}) }, null, 2) }], ...(project === undefined ? {} : { project }) }; }

export default { name: "wish-development-tools", inject: ["wishDevelopment", "tools", "shell"], apply(ctx: Context) {
  const releases = ["wish_begin", "wish_read", "wish_propose"].flatMap(toolName => {
    const plan = ctx.get("plan");
    return plan ? [plan.registerModeControl({ toolName, resourcePrefix: "wish." })] : [];
  });
  const owner = new ManagedToolOwner(ctx, { code: "wish_development_tools", codeReload: true,
    blocked: () => ctx.wishDevelopment.activeRunCount ? "wish_development_running" : undefined,
    close: () => { for (const release of releases) release(); } });
  for (const tool of createDevelopmentTools(ctx.wishDevelopment)) owner.register(tool);
  owner.register(createDevelopmentVerificationTool({ development: ctx.wishDevelopment, shell: ctx.shell }));
} };
