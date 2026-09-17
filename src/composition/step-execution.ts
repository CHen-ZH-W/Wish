import type { StepPipelineLease, StepPipelineSource } from "../core/runtime/runtime.js";

export class StepExecutionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "StepExecutionError"; }
}

/** Per-composition barrier, not a Run registry or a code reload engine. */
export class StepExecutionCoordinator {
  private phase: "ready" | "draining" | "replacing" | "failed" | "closed" = "ready";
  private active = 0;
  private readonly changes = new Set<() => void>();

  snapshot() { return Object.freeze({ phase: this.phase, activeSteps: this.active }); }

  source<C, P, M, R>(open: () => StepPipelineLease<C, P, M, R>): StepPipelineSource<C, P, M, R> {
    return Object.freeze({ acquire: async ({ signal }: { readonly signal: AbortSignal }) => {
      while (this.phase === "draining" || this.phase === "replacing") await this.changed(signal);
      signal.throwIfAborted();
      if (this.phase !== "ready") throw new StepExecutionError(`step_execution_${this.phase}`);
      this.active++;
      let resource: StepPipelineLease<C, P, M, R>;
      try { resource = open(); }
      catch (error) { this.active--; this.notify(); throw error; }
      let released = false;
      return Object.freeze({ pipeline: resource.pipeline, release: () => {
        if (released) return;
        released = true;
        try { resource.release(); }
        catch (error) { if (this.phase !== "closed") this.phase = "failed"; throw error; }
        finally { this.active--; this.notify(); }
      } });
    } });
  }

  /** Host-only. A Tool must not await an update that needs its own Step to finish. */
  async replace(update: () => Promise<void>, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.phase !== "ready") throw new StepExecutionError(`step_execution_${this.phase}`);
    options.signal?.throwIfAborted();
    this.phase = "draining";
    let started = false;
    try {
      while (this.active > 0 && this.phase === "draining") await this.changed(options.signal);
      options.signal?.throwIfAborted();
      if (this.phase !== "draining") throw new StepExecutionError(`step_execution_${this.phase}`);
      this.phase = "replacing"; started = true;
      await update();
      if (this.snapshot().phase !== "replacing") throw new StepExecutionError(`step_execution_${this.phase}`);
      this.phase = "ready";
    } catch (error) {
      // Before mutation, cancellation can reopen the old implementation. After
      // mutation, unknown cleanup/activation results require explicit recovery.
      const phase = this.snapshot().phase;
      if (phase !== "closed") this.phase = started || phase === "failed" ? "failed" : "ready";
      throw error;
    } finally { this.notify(); }
  }

  close(): void { this.phase = "closed"; this.notify(); }
  private notify(): void { for (const notify of [...this.changes]) notify(); }
  private changed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.changes.delete(changed); signal?.removeEventListener("abort", abort); };
      const changed = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal!.reason); };
      this.changes.add(changed);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
