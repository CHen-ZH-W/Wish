import { FiberState, type Context } from "@deepseek-ai/cordis";
import { registerPluginLifecycle } from "../boot/plugin-control/lifecycle.js";

/** One Web Provider/Consumer generation fences new work and drains owned calls before disposal. */
export class WebOwnerLifecycle {
  private accepting = true;
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly ctx: Context, private readonly code: string) {
    registerPluginLifecycle(ctx, () => ({ disposition: this.pending.size ? "drain" : "direct",
      code: this.pending.size ? `${code}_draining` : `${code}_idle`, counts: { requests: this.pending.size } }), () => {
      this.accepting = false;
      return { close: () => this.close(), release: () => { if (!this.closed) this.accepting = true; } };
    });
    ctx.effect(() => () => this.close(), `${code}.lifecycle`);
  }
  run<T>(action: () => T | Promise<T>): Promise<T> {
    if (!this.accepting || this.closed || this.ctx.fiber.state === FiberState.UNLOADING || this.ctx.fiber.state === FiberState.DISPOSED) {
      return Promise.reject(new Error(`${this.code}_closed`));
    }
    const work = Promise.resolve().then(() => {
      if (!this.accepting || this.closed) throw new Error(`${this.code}_closed`);
      return action();
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    return this.closing = Promise.allSettled([...this.pending]).then(() => { this.closed = true; });
  }
}
