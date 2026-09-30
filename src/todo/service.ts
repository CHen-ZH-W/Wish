import { Service, type Context } from "@deepseek-ai/cordis";

import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { WishUserTurnContinuationPolicy } from "../composition/runtime-service.js";
import { TodoRuntime } from "./runtime.js";
import type {
  OpenTodoTurnRequest,
  ReplaceTodoRequest,
  Todo,
  TodoState,
} from "./types.js";

export class TodoService extends Service implements Todo {
  static readonly inject = ["runEngine"];

  private readonly backend = new TodoRuntime();
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context) {
    super(ctx, "todo");
    this.work = new PluginWorkOwner(ctx, {
      code: "todo",
      codeReload: true,
      close: () => this.backend.close(),
    });
    const policy: WishUserTurnContinuationPolicy = {
      openUserTurn: async ({ run, userTurn }) => {
        await this.work.run(() => this.backend.openTurn({
          sessionId: run.scope,
          runId: run.runId,
          userTurnId: userTurn.id,
          openedAt: userTurn.startedAt,
        }));
      },
    };
    ctx.effect(
      () => ctx.runEngine.registerContinuationPolicy(Object.freeze(policy)),
      "todo UserTurn reset policy",
    );
  }

  get(sessionId: string): Promise<TodoState | undefined> {
    return this.work.run(() => this.backend.get(sessionId));
  }

  openTurn(request: OpenTodoTurnRequest): Promise<TodoState> {
    return this.work.run(() => this.backend.openTurn(request));
  }

  replace(request: ReplaceTodoRequest): Promise<TodoState> {
    return this.work.run(() => this.backend.replace(request));
  }

  close(): Promise<void> {
    return this.work.close();
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    todo: TodoService;
  }
}

export default TodoService;
