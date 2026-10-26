import type { GetSessionInput, Session } from "../../sessions/types.js";
import { SessionNotFoundError } from "../../sessions/types.js";
import type { MemoryCurationScheduler } from "./scheduler.js";
import type { CurationJob } from "./types.js";

export interface BackgroundCurationOptions {
  readonly scheduler: MemoryCurationScheduler;
  readonly getSession: (input: GetSessionInput) => Promise<Session>;
  readonly minIdleMs?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** Normal user activity wakes durable work; no independent polling or foreground wait. */
export class BackgroundMemoryCuration {
  private readonly excluded = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private paused = true;
  private closed = false;
  private requested = false;
  private readonly cancellation = new AbortController();
  readonly minIdleMs: number;
  readonly maxAgeMs: number;

  constructor(private readonly options: BackgroundCurationOptions) {
    this.minIdleMs = duration(options.minIdleMs ?? 6 * 3_600_000, 0);
    this.maxAgeMs = duration(options.maxAgeMs ?? 10 * 86_400_000, 1);
    if (this.minIdleMs > this.maxAgeMs) throw new Error("Curation idle window exceeds maximum age");
  }

  wake(sessionId: string): void {
    if (this.closed || this.paused) return;
    this.excluded.add(sessionId);
    this.requested = true;
    this.schedule();
  }
  resume(): void { if (!this.closed) { this.paused = false; this.schedule(); } }
  suspend(): void { this.paused = true; clearTimeout(this.timer); this.timer = undefined; }
  stop(): void { this.closed = true; this.suspend(); this.cancellation.abort(new Error("Background curation closed")); }
  async drain(): Promise<void> { await this.running; }
  get active(): boolean { return this.running !== undefined; }

  private schedule(): void {
    if (this.closed || this.paused || this.running || this.timer || !this.requested) return;
    // A later macrotask keeps scanning, storage and model work off Run admission.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.paused) return;
      this.requested = false;
      this.running = this.pass().catch(error => {
        if (!this.closed) { try { this.options.onError?.(error); } catch { /* Diagnostics are isolated. */ } }
      }).finally(() => {
        this.running = undefined;
        if (!this.requested) this.excluded.clear();
        this.schedule();
      });
    }, 0);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    const signal = this.cancellation.signal;
    const now = this.options.now?.() ?? Date.now();
    const oldestAt = now - this.maxAgeMs;
    const acceptsSession = async (sessionId: string): Promise<boolean> => {
      signal.throwIfAborted();
      if (this.excluded.has(sessionId)) return false;
      try {
        const session = await this.options.getSession({ sessionId, signal });
        signal.throwIfAborted();
        const activity = Date.parse(session.updatedAt);
        return !this.excluded.has(sessionId) && session.status === "active" &&
          activity >= oldestAt && activity <= now - this.minIdleMs;
      } catch (error) { if (error instanceof SessionNotFoundError) return false; throw error; }
    };
    const state = await this.options.scheduler.state(signal);
    try {
      await this.options.scheduler.scan(signal, {
        oldestAt,
        knownEvidenceIds: new Set([...(state.retiredEvidenceIds ?? []), ...state.jobs.filter(job => job.evidence.occurredAt !== undefined ||
          ["completed", "failed", "cancelled"].includes(job.status)).map(job => job.evidence.id)]), acceptsSession,
      });
    } catch (error) {
      signal.throwIfAborted();
      // A failed source must not strand already durable work.
      try { this.options.onError?.(error); } catch { /* Diagnostics are isolated. */ }
    }
    if (this.paused || this.closed) return;
    const accepts = async (job: CurationJob): Promise<boolean> => {
      if (this.paused || this.closed) return false;
      const { sessionId, occurredAt } = job.evidence;
      if (!sessionId || !occurredAt || Date.parse(occurredAt) < oldestAt) return false;
      return acceptsSession(sessionId);
    };
    await this.options.scheduler.tick(accepts);
  }
}

function duration(value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error("Invalid background curation duration");
  return value;
}
