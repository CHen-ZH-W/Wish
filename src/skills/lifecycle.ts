import { FiberState, type Context } from "@deepseek-ai/cordis";
import { registerPluginLifecycle } from "../boot/plugin-control/lifecycle.js";

/** One Skills owner tracks its own reads and contribution cleanup, not other modules. */
export class SkillOwnerLifecycle {
  private fenced = false;
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly cleanup: (() => void)[] = [];
  constructor(private readonly ctx: Context) {
    registerPluginLifecycle(ctx, () => ({
      disposition: this.closed || this.pending.size ? "blocked" : "direct",
      code: this.closed ? "skills_owner_closed" : this.pending.size ? "skills_requests_active" : "skills_owner_idle",
      counts: { requests: this.pending.size },
    }), () => {
      this.fenced = true;
      return { close: () => this.close(), release: () => { if (!this.closed) this.fenced = false; } };
    });
    ctx.effect(() => () => this.close(), "Skills owner lifecycle");
  }
  own(cleanup: () => void): void { this.cleanup.push(cleanup); }
  async run<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.fenced || this.closed || this.ctx.fiber.state === FiberState.UNLOADING || this.ctx.fiber.state === FiberState.DISPOSED) throw new Error("skills_owner_closed");
    const work = Promise.resolve().then(() => {
      if (this.closed) throw new Error("skills_owner_closed");
      return action();
    });
    this.pending.add(work);
    try { const result = await work; if (this.closed) throw new Error("skills_owner_closed"); return result; }
    finally { this.pending.delete(work); }
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = Promise.allSettled([...this.pending]).then(() => { for (const cleanup of this.cleanup) cleanup(); });
  }
}
