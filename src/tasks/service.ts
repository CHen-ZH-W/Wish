import { Service, type Context } from "@deepseek-ai/cordis";
import type { Tasks } from "./types.js";
export abstract class TasksService extends Service implements Tasks {
  constructor(ctx: Context) { super(ctx, "tasks"); }
  abstract get: Tasks["get"];
  abstract replace: Tasks["replace"];
  abstract freeze: Tasks["freeze"];
  abstract transition: Tasks["transition"];
  abstract close: Tasks["close"];
}
declare module "@deepseek-ai/cordis" { interface Context { tasks: TasksService } }
