import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

/** One Web generation finishes accepted calls before its dependencies are stopped. */
export class WebOwnerLifecycle extends PluginWorkOwner {
  constructor(ctx: Context, code: string) {
    super(ctx, { code, codeReload: true });
  }
}
