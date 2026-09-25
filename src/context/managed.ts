import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { ContextProvider } from "../core/context/projector.js";
import type { ContextInput } from "./types.js";

/** A contributed source owns its admitted reads, independently of the registry. */
export function registerManagedContextProvider(ctx: Context, provider: ContextProvider<ContextInput>): void {
  let registration: ReturnType<Context["contextEngine"]["registerProvider"]> | undefined;
  const work = new PluginWorkOwner(ctx, { code: "context_source", codeReload: true,
    close: () => { registration?.unregister(); } });
  registration = ctx.contextEngine.registerProvider({ id: provider.id,
    provide: (input, signal) => work.run(() => provider.provide(input, signal)),
  });
}
