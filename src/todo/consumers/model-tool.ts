import type { Context } from "@deepseek-ai/cordis";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import type { ToolDefinition, ToolInputParseResult } from "../../core/tools/tool.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import { ManagedToolOwner } from "../../tools/managed.js";
import { normalizeTodoItems } from "../runtime.js";
import type { Todo, TodoItem, TodoState } from "../types.js";

export interface TodoWriteInput {
  readonly todos: readonly TodoItem[];
}

export interface TodoToolOutput {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly todo: TodoState;
}

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    todos: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1, maxLength: 500 },
          status: { enum: ["pending", "in_progress", "completed"] },
        },
        required: ["id", "content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
});

export function createTodoWriteTool(
  todo: Todo,
): ToolDefinition<"todo_write", TodoWriteInput, TodoToolOutput, WishToolExecutionContext> {
  return {
    name: "todo_write",
    description:
      "Replace the current UserTurn's complete Todo list. Use it to expose multi-step progress; it resets automatically at the next UserTurn and is not a durable workflow/task graph.",
    inputSchemaJson: SCHEMA,
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse(input): ToolInputParseResult<TodoWriteInput> {
      try {
        if (Object.keys(input).some((key) => key !== "todos")) {
          throw new Error("Unknown todo_write field");
        }
        const todos = normalizeTodoItems(input.todos as readonly TodoItem[]);
        return { ok: true, input: Object.freeze({ todos }) };
      } catch (error: unknown) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    resolveCapabilities(_input, context) {
      return capability(context);
    },
    async execute(input, context, grant) {
      const identity = requireTurn(context);
      const resource = `todo.write:${context.permissions.subject.sessionId}`;
      assertActiveToolAuthorizationGrant(grant, { toolName: "todo_write" });
      if (!grant.capabilities.requirements.some((requirement) =>
        requirement.capability === "runtime.control" && requirement.resources.includes(resource)
      )) {
        throw new ToolExecutionError("permission_denied", `Tool authorization Grant does not allow ${resource}`);
      }
      try {
        const state = await todo.replace({
          sessionId: context.permissions.subject.sessionId,
          runId: identity.runId,
          userTurnId: identity.userTurnId,
          items: input.todos,
        });
        return Object.freeze({
          content: Object.freeze([Object.freeze({
            type: "text" as const,
            text: `Todo list replaced at revision ${state.revision}.`,
          })]),
          todo: state,
        });
      } catch (error: unknown) {
        throw new ToolExecutionError(
          error instanceof Error && error.message.includes("identity conflict")
            ? "conflict"
            : "execution_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function capability(context: WishToolExecutionContext) {
  return Object.freeze({ requirements: Object.freeze([Object.freeze({
    capability: "runtime.control" as const,
    resources: Object.freeze([`todo.write:${context.permissions.subject.sessionId}`]),
  })]) });
}

function requireTurn(context: WishToolExecutionContext): NonNullable<WishToolExecutionContext["userTurn"]> {
  if (context.userTurn === undefined) {
    throw new ToolExecutionError("execution_failed", "Trusted UserTurn context is unavailable");
  }
  if (
    context.userTurn.runId !== context.permissions.subject.runId ||
    context.userTurn.userTurnId !== context.permissions.subject.userTurnId
  ) {
    throw new ToolExecutionError("conflict", "UserTurn authority identity mismatch");
  }
  return context.userTurn;
}

export default {
  name: "todo-tools",
  inject: ["tools", "todo"],
  apply(ctx: Context) {
    const owner = new ManagedToolOwner(ctx, { code: "todo_tools", codeReload: true });
    owner.register(createTodoWriteTool(ctx.todo));
  },
};
