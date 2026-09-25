import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRegistration } from "../core/tools/scheduler.js";
import type { WishToolExecutionContext } from "../composition/tool-context.js";
import { PluginWorkOwner, type PluginWorkOwnerOptions } from "../boot/plugin-control/work-owner.js";
import type { ToolResultRendererContribution } from "./service.js";
import type { WishPluginManifestView } from "../boot/plugin-control/manifest.js";

/** One Consumer fiber may contribute several Tools, all sharing its admission fence. */
export class ManagedToolOwner {
  private readonly work: PluginWorkOwner;
  private readonly registrations: ToolRegistration[] = [];
  private readonly manifest: WishPluginManifestView | null;
  constructor(private readonly ctx: Context, options: PluginWorkOwnerOptions) {
    const entryId = ctx.fiber.entry?.id;
    this.manifest = entryId === undefined ? null : ctx.root.get("pluginInspection")?.inspect().entries
      .find(entry => entry.id === entryId)?.manifest ?? null;
    this.work = new PluginWorkOwner(ctx, { ...options, close: async () => {
      for (const registration of this.registrations) registration.unregister();
      await options.close?.();
    } });
  }

  register<Name extends string, Input, Output>(
    definition: ToolDefinition<Name, Input, Output, WishToolExecutionContext>,
    renderer?: ToolResultRendererContribution,
  ): ToolRegistration {
    // Registration is part of activation; execution remains fenced until the
    // reload receipt commits. Cordis owns registration validity and disposal.
    const registration = this.ctx.tools.register({ ...definition,
      parse: input => { this.work.assertOpen(); return definition.parse(input); },
      resolveCapabilities: (...args) => this.work.run(async () => {
        const request = await definition.resolveCapabilities(...args);
        if (this.manifest && Array.isArray(request?.requirements)) {
          const declared = new Set(this.manifest.capabilities);
          for (const requirement of request.requirements) if (!declared.has(requirement.capability)) {
            throw new Error("plugin_manifest_capability_undeclared");
          }
        }
        return request;
      }),
      execute: (...args) => this.work.run(() => definition.execute(...args)),
    }, renderer ? { render: input => this.work.run(() => renderer.render(input)) } : undefined);
    this.registrations.push(registration);
    return registration;
  }
}
