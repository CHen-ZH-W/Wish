import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "../../core/tools/tool.js";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { Plan } from "../../plan/types.js";
import { normalizeTasks, readyTasks } from "../graph.js";
import type { Tasks, TaskSpec } from "../types.js";

export function createTaskTools(tasks: Tasks, plan: Plan): readonly ToolDefinition<string, any, unknown, WishToolExecutionContext>[] {
  return ["tasks_read", "tasks_update"].map((name) => ({
    name, description: name === "tasks_read" ? "Read the versioned task graph and runtime-owned execution states."
      : "In Plan mode, replace the task graph and attach its exact version to the saved Plan. Requires a saved Plan first. Each task declares dependencies and execution role/readOnly/timeoutMs. Does not execute tasks.",
    inputSchemaJson: JSON.stringify(name === "tasks_read" ? { type: "object", properties: {}, additionalProperties: false } : {
      type: "object", properties: { expectedVersion: { type: "integer", minimum: 0 }, tasks: { type: "array", maxItems: 100, items: {
        type: "object", properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } }, execution: { type: "object", properties: {
            role: { type: "string" }, readOnly: { type: "boolean" }, timeoutMs: { type: "integer", minimum: 1, maximum: 86400000 },
          }, required: ["role", "readOnly", "timeoutMs"], additionalProperties: false } }, required: ["id", "title", "dependencies", "execution"], additionalProperties: false,
      } } }, required: ["expectedVersion", "tasks"], additionalProperties: false,
    }), executionMode: "sequential" as const, recoveryPolicy: name === "tasks_read" ? "retry-safe" as const : "needs-reconciliation" as const,
    parse(input) {
      try {
        const keys = name === "tasks_read" ? [] : ["tasks", "expectedVersion"];
        if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("Unknown task input");
        if (name === "tasks_update") {
          normalizeTasks(input.tasks as TaskSpec[]);
          if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 0) throw new Error("Invalid expected graph version");
        }
        return { ok: true as const, input };
      } catch (error) { return { ok: false as const, message: String(error) }; }
    },
    resolveCapabilities(_input, context) { return { requirements: [{ capability: name === "tasks_read" ? "runtime.read" : "runtime.control", resources: [`tasks.${name}:${context.permissions.subject.sessionId}`] }] }; },
    async execute(input, context, grant) {
      assertActiveToolAuthorizationGrant(grant!);
      const sessionId = context.permissions.subject.sessionId;
      if (name === "tasks_update") {
        const current = await plan.get({ sessionId });
        if (!current?.active || !current.document) throw new Error("Save a Plan before editing tasks");
        await plan.feedback({ sessionId, text: "Task graph is being revised", actor: "tasks-consumer" });
        const graph = await tasks.replace(sessionId, input.tasks, input.expectedVersion);
        await plan.update({ sessionId, expectedPlanVersion: current.document.version, markdown: current.document.markdown, artifacts: [
          ...(current.document.artifacts ?? []).filter((ref) => ref.kind !== "tasks"),
          { kind: "tasks", id: sessionId, version: graph.version, digest: graph.digest },
        ] });
      }
      const graph = await tasks.get(sessionId);
      return { content: [{ type: "text", text: JSON.stringify({ graph, ready: graph ? readyTasks(graph).map((task) => task.id) : [] }) }] };
    },
  }));
}

export default { name: "task-tools", inject: ["tools", "tasks", "plan"], apply(ctx: Context) {
  for (const tool of createTaskTools(ctx.tasks, ctx.plan)) {
    ctx.plan.registerModeControl({ toolName: tool.name, resourcePrefix: "tasks." });
    ctx.tools.register(tool);
  }
} };
