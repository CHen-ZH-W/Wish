import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";

/** Skills owns reads and contributions; Cordis owns dependency propagation. */
export class SkillOwnerLifecycle extends PluginWorkOwner {
  private readonly cleanup: (() => void)[];
  constructor(ctx: Context) {
    const cleanup: (() => void)[] = [];
    super(ctx, { code: "skills_owner", codeReload: true, close: () => {
      for (const release of cleanup) release();
    } });
    this.cleanup = cleanup;
  }
  own(cleanup: () => void): void { this.cleanup.push(cleanup); }
}
