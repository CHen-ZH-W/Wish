import type { Context } from "@deepseek-ai/cordis";
import { ManagedToolOwner } from "../../tools/managed.js";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import type { ToolDefinition } from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import { digest, record } from "../../agent-profiles/validation.js";
import { source } from "../validation.js";
import type { Candidates } from "../service.js";

/** Agent can author and validate candidates; trust approval is a Host-only port. */
export function createCandidateTools(candidates: Candidates): readonly ToolDefinition<string, any, any, WishToolExecutionContext>[] {
  const tool = (name: string, description: string, execute: (input: Record<string, unknown>, context: WishToolExecutionContext, signal?: AbortSignal) => Promise<unknown>): ToolDefinition<string, Record<string, unknown>, unknown, WishToolExecutionContext> => ({
    name, description, inputSchemaJson: JSON.stringify({ type: "object", properties: { request: { type: "object", additionalProperties: true } }, required: ["request"], additionalProperties: false }),
    executionMode: "sequential", recoveryPolicy: "needs-reconciliation",
    parse(input) { try { if (Object.keys(input).some(key => key !== "request")) throw new Error("Only request is accepted"); return { ok: true, input: record(input.request) }; } catch (error) { return { ok: false, message: String(error) }; } },
    resolveCapabilities(input) { return { requirements: [{ capability: "runtime.control", resources: [`${name}:${digest(input)}`] }] }; },
    async execute(input, context, grant, signal) {
      assertActiveToolAuthorizationGrant(grant, { toolName: name });
      if (!grant.capabilities.requirements.some(item => item.capability === "runtime.control" && item.resources.includes(`${name}:${digest(input)}`))) throw new ToolExecutionError("permission_denied", "Candidate operation is outside the granted request");
      signal?.throwIfAborted();
      const result = await execute(input, context, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  return [
    tool("candidate_submit", "Submit an immutable candidate Cordis plugin: schemaVersion/id/version/entry/files/tests/manifest/config/provenance. Source is data; this does not install code or grant trust. Manifest entry must be ./plugin.mjs. Imports: node:, public wish/*, Cordis, Schemastery. At least one node:test file is required.", async (input, context) => {
      const candidate = source(input);
      return candidates.submit({ ...candidate, provenance: { ...candidate.provenance, ...(context.userTurn ? { runId: context.userTurn.runId } : {}) } });
    }),
    tool("candidate_validate", "Build, typecheck, test and activate a candidate in a Linux sandbox. request: candidateDigest, baseSnapshotDigest, target:{parentId,entryId}, profile (versioned Agent Profile). Returns validation id and sandbox-only experiment snapshot. This never loads the candidate into the current Host.", (input, _context, signal) => candidates.validate(input, signal)),
    tool("candidate_evaluate", "Run baseline/candidate benchmark and regression cases with recorded metrics. request: validationId,datasetDigest,repetitions?,timeoutMs?,maxSteps?,gate?. This never grants deployment approval; a human must inspect evidence and approve the exact review digest.", (input, _context, signal) => candidates.evaluate(input, signal)),
  ];
}
export default { name: "candidate-tools", inject: ["candidates", "tools"], apply(ctx: Context) {
  const owner = new ManagedToolOwner(ctx, { code: "candidate_tools", codeReload: true });
  for (const tool of createCandidateTools(ctx.candidates)) owner.register(tool);
} };
