import { FiberState, type Context } from "@deepseek-ai/cordis";
import type {} from "./code-reload.js";
import { registerPluginOwner } from "./owner-registry.js";

export interface PluginWorkOwnerOptions {
  /** Stable diagnostic prefix; no paths, user content or resource handles. */
  readonly code: string;
  /** Only declare this after the owner's state and dependencies support replacement. */
  readonly codeReload?: boolean;
  /** Generation owners hand accepted resources to native teardown instead of
   * waiting for long-lived handles before the successor can be activated. */
  readonly replacement?: "drain" | "generation";
  /** Some domain owners cannot be stopped merely by finishing their current calls. */
  readonly busy?: "drain" | "blocked";
  /** Domain-owned long lived work can veto replacement without exposing its state. */
  readonly blocked?: () => string | undefined;
  /** Signal cancellable waits owned by this module before awaiting its work. */
  readonly beforeDrain?: () => void;
  /** Releases resources after all accepted work settles. Failures remain observable. */
  readonly close?: () => void | Promise<void>;
}

/** Tracks one plugin's accepted calls, never its domain state or dependency graph. */
export class PluginWorkOwner {
  private readonly pending = new Set<Promise<unknown>>();
  private fenced = false;
  private ready = true;
  private closing: Promise<void> | undefined;

  constructor(private readonly ctx: Context, private readonly options: PluginWorkOwnerOptions) {
    const status = () => {
      const blocked = options.blocked?.();
      return {
        disposition: this.closing || blocked ? "blocked" : this.pending.size ? options.busy ?? "drain" : "direct",
        code: blocked ?? `${options.code}_${this.closing ? "closed" : this.pending.size ? "busy" : "idle"}`,
        counts: { active_requests: this.pending.size },
      } as const;
    };
    const prepareStop = () => {
      const release = this.fence();
      return { close: () => this.close(), release };
    };
    if (options.codeReload) {
      registerPluginOwner(ctx, {
        status,
        replacement: options.replacement ?? "drain",
        prepare: change => {
          const release = this.fence();
          return {
            // The existing disable adapter starts owned cancellation in close().
            // Replacement already had a distinct pre-apply drain contract.
            drained: change.kind === "disable" || options.replacement === "generation"
              ? Promise.resolve()
              : this.drain(),
            deactivate: () => this.close(),
            release,
          };
        },
      });
    } else ctx.root.get("pluginOwners")?.registerLifecycle(ctx, status, prepareStop);
    ctx.effect(() => () => this.close(), `${options.code}.work-owner`);
    const reload = options.codeReload ? ctx.root.get("codeReload") : undefined;
    if (reload) {
      this.ready = false;
      reload.startWhenReady(ctx, () => { if (!this.closing) this.ready = true; });
    }
  }

  /** Check synchronous entrypoints, including references retained before replacement. */
  assertOpen(): void {
    this.assertAttached();
    if (!this.ready) throw new Error(`${this.options.code}_closed`);
  }

  /** Synchronous composition may run during activation, before the reload receipt.
   * This permits registering contributions/acquiring handles, never starting I/O.
   */
  assertAttached(): void {
    if (this.fenced || this.closing ||
      this.ctx.fiber.state === FiberState.UNLOADING || this.ctx.fiber.state === FiberState.DISPOSED) {
      throw new Error(`${this.options.code}_closed`);
    }
  }

  /** Admission precedes scheduling; a later fence must still finish admitted work. */
  async run<T>(action: () => T | PromiseLike<T>): Promise<T> {
    this.assertOpen();
    return this.accept(action);
  }

  /** Activation-only composition when the caller cannot be passed through a
   * public service port. Ordinary business dispatch must continue to use run(). */
  async runAttached<T>(action: () => T | PromiseLike<T>): Promise<T> {
    this.assertAttached();
    return this.accept(action);
  }

  /** Explicit reconciliation reads may initialize a dependent LOADING Fiber.
   * This never bypasses an old generation's fence or permits ordinary callers
   * to use an uncommitted successor. Do not use for new business dispatch.
   */
  async runDuringActivation<T>(caller: Context, action: () => T | PromiseLike<T>): Promise<T> {
    if (!this.ready && caller.root === this.ctx.root && caller.fiber.state === FiberState.LOADING) this.assertAttached();
    else this.assertOpen();
    return this.accept(action);
  }

  private async accept<T>(action: () => T | PromiseLike<T>): Promise<T> {
    const work = Promise.resolve().then(action);
    this.pending.add(work);
    try { return await work; }
    finally { this.pending.delete(work); }
  }

  /** A streaming call is owned until completion, failure, or iterator.return(). */
  async *stream<T>(create: () => AsyncIterable<T>): AsyncGenerator<T, void, unknown> {
    const release = this.hold();
    try { yield* create(); }
    finally { release(); }
  }

  /** Explicit handles (for example a Step pipeline) own work until released. */
  hold(): () => void {
    this.assertOpen();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    this.pending.add(pending);
    return () => { this.pending.delete(pending); finish(); };
  }

  private fence(): () => void {
    this.assertOpen();
    const blocked = this.options.blocked?.();
    if (blocked) throw new Error(blocked);
    this.fenced = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.closing) this.fenced = false;
    };
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Memoized cleanup: an error cannot turn a second close into false success. */
  close(): Promise<void> {
    this.fenced = true;
    return this.closing ??= Promise.resolve().then(() => this.options.beforeDrain?.())
      .then(() => this.drain()).then(() => this.options.close?.());
  }
}
