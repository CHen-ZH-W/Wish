import type { Context } from "@deepseek-ai/cordis";
import { registerManagedContextProvider } from "../../context/managed.js";
import { TodoContextProvider } from "../context.js";

export default {
  name: "todo-context",
  inject: ["todo", "contextEngine"],
  apply(ctx: Context) {
    registerManagedContextProvider(ctx, new TodoContextProvider(ctx.todo));
  },
};
