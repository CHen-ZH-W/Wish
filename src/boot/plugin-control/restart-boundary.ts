import type { Context } from "@deepseek-ai/cordis";
import type {} from "./owner-registry.js";
const declared = new WeakMap<Context["fiber"], string>();

/** For process/session authorities whose replacement requires a fresh Host.
 * Ordinary feature plugins should implement owned cleanup instead.
 */
export function registerRestartBoundary(ctx: Context, code: string): void {
  // Some process surfaces re-apply configuration on the same Fiber. This static
  // declaration owns no per-generation resources, so it is idempotent there.
  if (declared.get(ctx.fiber) === code && ctx.fiber.uid !== null &&
    ctx.root.get("pluginOwners")?.coverage(ctx.fiber.uid).codeReload === "restart") return;
  ctx.root.get("pluginOwners")?.registerRestartOwner(ctx, () => ({ disposition: "restart", code }));
  declared.set(ctx.fiber, code);
}
