import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { FiberState, type Context } from "@deepseek-ai/cordis";
import type { ManagedPluginControl } from "./managed-control.js";

/** Root-owned, config-only native HMR. No code watcher or business-state ownership. */
export async function startManagedConfigurationWatch(root: Context, control: ManagedPluginControl, filename: string): Promise<void> {
  const [{ default: Timer }, { default: Hmr }] = await Promise.all([
    import("@deepseek-ai/cordis-plugin-timer"),
    import("@deepseek-ai/cordis-plugin-hmr"),
  ]);
  // Business profiles cannot dispose the watcher while it is applying that profile.
  // HMR has a separate service scope. Timer's ctx mixins are Root-wide, so
  // reuse an existing Timer instead of declaring its accessors a second time.
  const scope = root.isolate("hmr").extend({ baseUrl: pathToFileURL(filename).href });
  await scope.plugin({
    name: "managed-configuration-watch",
    async apply(ctx: Context) {
      if (!ctx.get("timer")) await ctx.plugin(Timer);
      await ctx.plugin(Hmr, { root: [], base: dirname(filename), ignored: [], debounce: 100 });
      await ctx.plugin({
        name: "managed-configuration-subscription",
        inject: ["hmr", "timer"],
        async apply(owner: Context) {
          await owner.hmr.registerConfig(filename, async () => {
            try {
              // Coalesce editor write bursts before reading a complete revision.
              // Native HMR owns exact-path observation and serial refresh delivery.
              await owner.timeout(100);
              await control.reloadConfiguration();
            } catch (error) {
              if (owner.fiber.state === FiberState.ACTIVE || owner.fiber.state === FiberState.LOADING) throw error;
            }
          });
          owner.effect(() => {
            control.setConfigurationWatching(true);
            return () => control.setConfigurationWatching(false);
          }, "managed configuration watch status");
        },
      });
    },
  });
}
