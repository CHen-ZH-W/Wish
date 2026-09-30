import type { Context } from "@deepseek-ai/cordis";
import { registerManagedContextProvider } from "../../context/managed.js";
import { GoalContextProvider } from "../context.js";
export default { name: "goal-context", inject: ["goal", "contextEngine"], apply(ctx: Context) { registerManagedContextProvider(ctx, new GoalContextProvider(ctx.goal)); } };
