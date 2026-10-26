import { createHash, randomUUID } from "node:crypto";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition } from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { Shell } from "../../shell/types.js";
import { createBashTool, type BashToolInput } from "../../shell/consumers/index.js";
import { captureWorkspaceSnapshot } from "../snapshot.js";
import { bindingSchema, keys, parseBinding, parseInput, positive, schema } from "./tool-input.js";
import { developmentToolError, requireExecution, type DevelopmentBindingInput, type DevelopmentConsumerPort } from "./port.js";

export interface DevelopmentVerificationToolInput extends BashToolInput, DevelopmentBindingInput {
  readonly expectedRevision: number;
  readonly criterionIds: readonly string[];
}
export interface DevelopmentVerificationToolOptions { readonly development: DevelopmentConsumerPort; readonly shell: Shell }

/** Uses the same capability declaration and Shell seam as Bash, with a distinct one-shot Tool grant. */
export function createDevelopmentVerificationTool(options: DevelopmentVerificationToolOptions): ToolDefinition<"wish_verify", DevelopmentVerificationToolInput, unknown, WishToolExecutionContext> {
  const bash = createBashTool({ shell: options.shell });
  const bashProperties = (JSON.parse(bash.inputSchemaJson) as { properties: Record<string, unknown> }).properties;
  return {
    name: "wish_verify",
    description: "Run one real verification command at a time for specified technical acceptance criteria using normal Shell permissions and sandboxing. Host captures output, exit code and before/after code snapshots. Use the returned projectRevision for your next call. No passed input exists. A changing workspace or stale execution binding cannot produce verification evidence.",
    inputSchemaJson: schema({ ...bashProperties, ...bindingSchema, expectedRevision: { type: "integer", minimum: 1 },
      criterionIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1 } },
    }, ["command", "criterionIds", "expectedRevision", "executionEpoch", "confirmationDigest"]),
    executionMode: "sequential", recoveryPolicy: "needs-reconciliation",
    parse: input => parseInput(() => {
      keys(input, ["command", "timeout", "permissions", "criterionIds", "expectedRevision", "executionEpoch", "confirmationDigest"]);
      parseBinding(input); positive(input.expectedRevision, "expectedRevision");
      if (!Array.isArray(input.criterionIds) || input.criterionIds.length < 1 || input.criterionIds.length > 100 ||
          input.criterionIds.some(id => typeof id !== "string" || !id.trim()) || new Set(input.criterionIds).size !== input.criterionIds.length) throw new Error("criterionIds must contain distinct technical criterion IDs");
      const parsed = bash.parse({ command: input.command, ...(input.timeout === undefined ? {} : { timeout: input.timeout }), ...(input.permissions === undefined ? {} : { permissions: input.permissions }) });
      if (!parsed.ok) throw new Error(parsed.message);
      if (parsed.input.command.length > 20000) throw new Error("Verification command exceeds 20000 characters");
      return { ...parsed.input, timeout: parsed.input.timeout ?? 120, expectedRevision: input.expectedRevision as number,
        executionEpoch: input.executionEpoch as number, confirmationDigest: input.confirmationDigest as string, criterionIds: input.criterionIds as string[] };
    }),
    resolveCapabilities(input, context) {
      const request = bash.resolveCapabilities(input, context);
      // Bash's resolver is synchronous; this wrapper also supports a future async resolver.
      return Promise.resolve(request).then(capabilities => ({ ...capabilities, requirements: [
        ...capabilities.requirements,
        { capability: "filesystem.read" as const, paths: ["."] },
        { capability: "runtime.control" as const, resources: [`wish.verify:${context.permissions.subject.sessionId}`] },
      ] }));
    },
    async execute(input, context, grant, signal) {
      signal?.throwIfAborted();
      assertActiveToolAuthorizationGrant(grant, { toolName: "wish_verify" });
      if (!grant.capabilities.requirements.some(item => item.capability === "process.exec" && item.commands?.includes(input.command)) ||
          !grant.capabilities.requirements.some(item => item.capability === "runtime.control" && item.resources.includes(`wish.verify:${context.permissions.subject.sessionId}`))) {
        throw new ToolExecutionError("permission_denied", "Verification grant does not cover this command and receipt");
      }
      try {
        const current = await requireExecution(options.development, context, input);
        if (current.project.revision !== input.expectedRevision) throw new ToolExecutionError("conflict", "Wish project revision changed before verification");
        const criteria = current.change.specs.at(-1)!.criteria;
        if (input.criterionIds.some(id => !criteria.some(item => item.id === id && item.kind === "technical"))) throw new ToolExecutionError("invalid_input", "Only current technical acceptance criteria can be verified by a command");
        const before = await captureWorkspaceSnapshot(current.project.workspaceRoot);
        signal?.throwIfAborted();
        const spec = await options.shell.resolve({ command: input.command, cwd: context.cwd, timeoutSeconds: input.timeout ?? 120, context, grant,
          ...(signal === undefined ? {} : { signal }) });
        // Resolve may wait on IO. Recheck the product fence immediately before dispatch too.
        await requireExecution(options.development, context, input);
        const startedAt = new Date().toISOString();
        let tail = Buffer.alloc(0), truncated = false;
        const result = await options.shell.run({ spec, onData: chunk => {
          const joined = Buffer.concat([tail, Buffer.from(chunk)]);
          if (joined.length > 65536) { truncated = true; tail = joined.subarray(joined.length - 65536); } else tail = joined;
        }, ...(signal === undefined ? {} : { signal }) });
        signal?.throwIfAborted();
        if (result.termination === "aborted") throw new ToolExecutionError("aborted", "Verification command was aborted; no success evidence was recorded");
        if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) throw new ToolExecutionError("execution_failed", "Shell returned an invalid verification exit code");
        const endedAt = new Date().toISOString();
        const utf8 = Buffer.from(tail.toString("utf8"), "utf8");
        let offset = Math.max(0, utf8.length - 16000);
        while (offset < utf8.length && (utf8[offset]! & 0xc0) === 0x80) offset += 1;
        const output = (truncated || offset > 0 ? "[Output truncated; retained tail]\n" : "") + utf8.subarray(offset).toString("utf8");
        const after = await captureWorkspaceSnapshot(current.project.workspaceRoot);
        if (before.digest !== after.digest) throw new ToolExecutionError("conflict", "Workspace changed during verification. Inspect the change and rerun against a stable code snapshot; no success evidence was recorded.", false,
          { command: input.command, exitCode: result.exitCode, output, beforeSnapshotDigest: before.digest, afterSnapshotDigest: after.digest });
        await requireExecution(options.development, context, input);
        const receipt = { id: `verify-${randomUUID()}`, runId: context.permissions.subject.runId, toolCallId: grant.subject.id, criterionIds: input.criterionIds, command: input.command,
          exitCode: result.exitCode, timedOut: result.termination === "timeout", output,
          outputDigest: createHash("sha256").update(output).digest("hex"), code: after, startedAt, endedAt };
        const project = await options.development.recordVerification({ projectId: current.project.id, changeId: current.change.id,
          sessionId: context.permissions.subject.sessionId, expectedRevision: input.expectedRevision, receipt });
        return { content: [{ type: "text", text: JSON.stringify({ receipt: { ...receipt, code: { digest: after.digest, fileCount: after.files.length, excluded: after.excluded } }, projectRevision: project.revision, note: "Command evidence applies only to the linked criteria and captured snapshot; user acceptance remains separate." }, null, 2) }], receipt, project };
      } catch (error) { throw developmentToolError(error); }
    },
  };
}
