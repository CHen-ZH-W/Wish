import { randomUUID } from "node:crypto";
import { SessionTitleConflictError, type Session } from "../sessions/types.js";
import { clipSeed, fallbackTitle, normalizeTitleText, safeTitleErrorCode } from "./normalize.js";
import {
  TitleGenerationError, TitleJobConflictError,
  type TitleAcceptedInput, type TitleConfig, type TitleControllerOptions,
  type TitleEvent, type TitleGenerationResult, type TitleJob,
} from "./types.js";

interface ActiveTask {
  readonly controller: AbortController;
  promise: Promise<void>;
  drain?: Promise<void>;
}

const FOREGROUND_RECHECK_MS = 250;

/** Owns durable jobs and scheduling; Sessions alone owns the displayed title. */
export class TitleController {
  private readonly config: Required<TitleConfig>;
  private readonly now: () => number;
  private readonly known = new Map<string, TitleJob>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly tails = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduled = false;
  private closed = false;
  private admissionHolds = 0;
  private closeTask: Promise<void> | undefined;

  constructor(private readonly options: TitleControllerOptions) {
    const source = options.config ?? {};
    this.config = {
      maxConcurrent: positive(source.maxConcurrent, 1), timeoutMs: positive(source.timeoutMs, 20_000),
      maxAttempts: positive(source.maxAttempts, 3), retryBaseMs: positive(source.retryBaseMs, 1000),
      retryMaxMs: positive(source.retryMaxMs, 30_000), maxTitleBytes: positive(source.maxTitleBytes, 80),
      fallbackMaxCodePoints: positive(source.fallbackMaxCodePoints, 60), fallbackMaxBytes: positive(source.fallbackMaxBytes, 120),
      seedMaxCodePoints: positive(source.seedMaxCodePoints, 2000),
    };
    if (this.config.seedMaxCodePoints > 8000) throw new TypeError("Title seed limit exceeds 8000 code points");
    this.now = options.now ?? Date.now;
  }

  /** Reconcile durable state while Cordis is still waiting to admit new work. */
  suspendAdmissions(): () => void {
    this.admissionHolds += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.admissionHolds -= 1;
      this.kick();
    };
  }

  /** Persists the fallback and job; never waits for a model request. */
  async accept(input: TitleAcceptedInput): Promise<void> {
    if (this.closed) return;
    const seed = clipSeed(input.text, this.config.seedMaxCodePoints);
    const fallback = fallbackTitle(input.text, { maxCodePoints: this.config.fallbackMaxCodePoints, maxBytes: this.config.fallbackMaxBytes });
    await this.serial(input.sessionId, async () => {
      if (this.closed) return;
      let session = await this.options.sessions.get({ sessionId: input.sessionId });
      if (!canGenerate(session)) return;
      if (await this.options.store.get(input.sessionId) !== undefined) return;
      const recovering = session.titleSource === "fallback";
      const recovered = recovering ? await this.recoverSeed(session) : undefined;
      if (recovering ? recovered === undefined : !seed || !fallback) return;
      if (session.titleSource !== "fallback" || !session.title?.trim()) {
        try {
          session = await this.options.sessions.updateMetadata({
            sessionId: input.sessionId, title: recovered === undefined ? fallback : fallbackTitle(recovered.seed, {
              maxCodePoints: this.config.fallbackMaxCodePoints, maxBytes: this.config.fallbackMaxBytes,
            }), titleSource: "fallback",
            expectedTitleRevision: session.titleRevision ?? 0,
          });
        } catch (error) { if (isProtectedError(error)) return; throw error; }
      }
      if (this.closed) return;
      const timestamp = this.now();
      const job: TitleJob = {
        schemaVersion: 1, sessionId: input.sessionId, jobId: randomUUID(), version: 1,
        state: "pending", seed: recovered?.seed ?? seed, expectedTitleRevision: session.titleRevision ?? 0,
        attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
        ...(recovering
          ? recovered?.inputId === undefined ? {} : { inputId: recovered.inputId }
          : input.inputId === undefined ? {} : { inputId: input.inputId }),
        ...(recovering || input.model === undefined ? {} : { model: input.model }),
      };
      try { await this.options.store.put(job); }
      catch (error) { if (error instanceof TitleJobConflictError) return; throw error; }
      this.known.set(input.sessionId, job);
      this.emit(job);
    });
    this.kick();
  }

  /** No store enumeration is required; Session identities are the recovery index. */
  async resume(): Promise<void> {
    if (this.closed) return;
    for (const session of await this.options.sessions.list()) {
      await this.serial(session.sessionId, async () => {
        if (this.closed || this.active.has(session.sessionId)) return;
        let job = await this.options.store.get(session.sessionId);
        if (job === undefined) {
          const current = await this.options.sessions.get({ sessionId: session.sessionId });
          if (!canGenerate(current) || current.titleSource !== "fallback" || !current.title?.trim()) return;
          const recovered = await this.recoverSeed(current);
          if (recovered === undefined) return;
          const timestamp = this.now();
          job = { schemaVersion: 1, sessionId: session.sessionId, jobId: randomUUID(), version: 1, state: "pending", seed: recovered.seed,
            expectedTitleRevision: current.titleRevision ?? 0, attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
            ...(recovered.inputId === undefined ? {} : { inputId: recovered.inputId }),
          };
          await this.options.store.put(job);
        }
        if (terminal(job)) return;
        const latest = await this.options.sessions.get({ sessionId: session.sessionId });
        if (!matches(latest, job)) {
          await this.save(job, { state: latest?.titleSource === "model" ? "succeeded" : "cancelled" });
          return;
        }
        if (job.state === "running") {
          job = await this.save(job, {
            state: job.attempts >= this.config.maxAttempts ? "failed" : "retry",
            nextAttemptAt: this.now(), lastError: "interrupted",
          });
        }
        this.known.set(job.sessionId, job);
      });
    }
    this.kick();
  }

  inspect(sessionId: string): Promise<TitleJob | undefined> { return this.options.store.get(sessionId); }

  async cancel(sessionId: string): Promise<void> {
    this.active.get(sessionId)?.controller.abort();
    await this.serial(sessionId, async () => {
      const job = await this.options.store.get(sessionId);
      if (job !== undefined && !terminal(job)) await this.save(job, { state: "cancelled" });
      this.known.delete(sessionId);
    });
    this.kick();
  }

  async purge(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    await this.serial(sessionId, async () => {
      const job = await this.options.store.get(sessionId);
      if (job !== undefined) await this.options.store.delete(sessionId, job.version);
      this.known.delete(sessionId);
    });
  }

  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const task of this.active.values()) task.controller.abort();
    this.closeTask = (async () => {
      await Promise.allSettled([...this.active.values()].map(task => task.promise));
      await Promise.allSettled([...this.tails.values()]);
      this.known.clear();
    })();
    return this.closeTask;
  }

  /** Explicit drain for acceptance tests and callers that need settled title work. */
  async waitForIdle(): Promise<void> {
    while (this.active.size > 0 || (!this.closed && [...this.known.values()].some(job => !terminal(job))) || this.tails.size > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  private kick(): void {
    if (this.closed || this.admissionHolds > 0 || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed || this.admissionHolds > 0) return;
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.known.size > 0 && this.active.size < this.config.maxConcurrent && !this.canDispatch()) {
      // A waiting conversation is not a failed title attempt. Avoid using an
      // already-due job timestamp here, which would create a 1ms polling loop.
      this.timer = setTimeout(() => this.kick(), FOREGROUND_RECHECK_MS);
      this.timer.unref();
      return;
    }
    for (const job of this.known.values()) {
      if (this.active.size >= this.config.maxConcurrent) break;
      if (terminal(job) || this.active.has(job.sessionId) || job.nextAttemptAt > this.now()) continue;
      const task: ActiveTask = { controller: new AbortController(), promise: Promise.resolve() };
      this.active.set(job.sessionId, task);
      task.promise = this.run(job.sessionId, task).catch(error => {
        // Storage failures are observable but never become unhandled rejections or hot retry loops.
        this.known.delete(job.sessionId);
        this.emit({ ...job, state: "failed", lastError: error instanceof TitleJobConflictError ? "job_conflict" : "storage_failed" });
      }).finally(async () => {
        // A timed-out Provider still owns its slot until the actual call settles.
        // Provider cancellation is cooperative; close honestly drains the same call.
        await task.drain;
        if (this.active.get(job.sessionId) === task) this.active.delete(job.sessionId);
        this.kick();
      });
    }
    if (this.active.size < this.config.maxConcurrent) {
      const next = [...this.known.values()].filter(job => !terminal(job) && !this.active.has(job.sessionId))
        .reduce((earliest, job) => Math.min(earliest, job.nextAttemptAt), Infinity);
      if (Number.isFinite(next)) {
        this.timer = setTimeout(() => this.kick(), Math.max(1, next - this.now()));
        this.timer.unref();
      }
    }
  }

  private async run(sessionId: string, task: ActiveTask): Promise<void> {
    const claimed = await this.serial(sessionId, async () => {
      if (this.closed || task.controller.signal.aborted || !this.canDispatch()) return undefined;
      const current = await this.options.store.get(sessionId);
      if (current === undefined || terminal(current)) { this.known.delete(sessionId); return undefined; }
      const session = await this.options.sessions.get({ sessionId });
      if (!matches(session, current)) { await this.save(current, { state: "cancelled" }); return undefined; }
      if (current.attempts >= this.config.maxAttempts) { await this.save(current, { state: "failed", lastError: "attempts_exhausted" }); return undefined; }
      if (!this.canDispatch()) return undefined;
      return this.save(current, { state: "running", attempts: current.attempts + 1 });
    });
    if (claimed === undefined) return;
    const started = this.now();
    let result: TitleGenerationResult | undefined;
    let failure: unknown;
    try {
      result = await this.generate(claimed, task);
      if (!normalizeTitleText(result.title, this.config.maxTitleBytes)) throw new TitleGenerationError("empty", true);
    } catch (error) { failure = error; }
    await this.serial(sessionId, async () => {
      if (this.closed) return;
      const current = await this.options.store.get(sessionId);
      if (current === undefined || current.jobId !== claimed.jobId || current.version !== claimed.version || current.state !== "running") return;
      if (task.controller.signal.aborted && failure === undefined) return;
      const session = await this.options.sessions.get({ sessionId });
      if (!matches(session, current)) { await this.save(current, { state: "cancelled" }); return; }
      if (failure !== undefined) {
        const retryable = failure instanceof TitleGenerationError && failure.retryable;
        const code = failure instanceof TitleGenerationError ? safeTitleErrorCode(failure.code) : "generation_failed";
        const retry = retryable && current.attempts < this.config.maxAttempts;
        const saved = await this.save(current, {
          state: retry ? "retry" : "failed", lastError: code,
          nextAttemptAt: this.now() + (retry ? Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** Math.min(30, current.attempts - 1)) : 0),
        });
        this.emit(saved, this.now() - started);
        return;
      }
      if (result === undefined || task.controller.signal.aborted) return;
      try {
        await this.options.sessions.updateMetadata({
          sessionId, title: normalizeTitleText(result.title, this.config.maxTitleBytes), titleSource: "model",
          expectedTitleRevision: current.expectedTitleRevision, signal: task.controller.signal,
        });
      } catch (error) {
        if (isProtectedError(error) || task.controller.signal.aborted) {
          await this.save(current, { state: "cancelled" });
          return;
        }
        throw error;
      }
      const saved = await this.save(current, {
        state: "succeeded",
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      this.emit(saved, this.now() - started);
    });
  }

  private canDispatch(): boolean {
    try { return this.options.canDispatch?.() ?? true; }
    catch { return false; }
  }

  private async generate(job: TitleJob, task: ActiveTask): Promise<TitleGenerationResult> {
    const controller = task.controller;
    const signal = controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new TitleGenerationError("cancelled", false));
      signal.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        reject(new TitleGenerationError("timeout", true));
        controller.abort();
      }, this.config.timeoutMs);
      timeout.unref();
      if (signal.aborted) abort();
    });
    const actual = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return this.options.generator.generate({ text: job.seed, signal, ...(job.model === undefined ? {} : { model: job.model }) });
        });
    task.drain = actual.then(() => undefined, () => undefined);
    try {
      return await Promise.race([actual, interrupted]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
  }

  private async save(current: TitleJob, changes: Partial<TitleJob>): Promise<TitleJob> {
    let next: TitleJob = { ...current, ...changes, version: current.version + 1, updatedAt: this.now() };
    if (next.state === "succeeded") {
      const { lastError: _lastError, ...successful } = next;
      next = successful;
    }
    await this.options.store.put(next, current.version);
    if (terminal(next)) this.known.delete(next.sessionId); else this.known.set(next.sessionId, next);
    return next;
  }

  private async recoverSeed(session: Session): Promise<{ readonly seed: string; readonly inputId?: string } | undefined> {
    const history = await this.options.sessions.readHistory?.({ sessionId: session.sessionId });
    const first = history?.records.find(record => record.kind === "message" && record.origin === "user_input"
      && record.inputSource === "user" && record.message.role === "user");
    const message = first?.kind === "message" ? first.message : undefined;
    const text = message?.content.trim() || message?.contentParts?.filter(part => part.type === "text").map(part => part.text).join(" ") || session.title || "";
    const seed = clipSeed(text, this.config.seedMaxCodePoints);
    if (!seed) return undefined;
    return { seed, ...(first?.kind === "message" ? { inputId: first.userTurnId } : {}) };
  }

  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, settled);
    void settled.then(() => { if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId); });
    return result;
  }

  private emit(job: TitleJob, latencyMs?: number): void {
    const event: TitleEvent = {
      sessionId: job.sessionId, state: job.state, attempts: job.attempts,
      ...(job.lastError === undefined ? {} : { errorCode: job.lastError }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(job.model === undefined ? {} : { route: job.model }),
      ...(job.usage === undefined ? {} : { usage: job.usage }),
    };
    try { this.options.onEvent?.(event); } catch { /* Observers cannot fail a durable job. */ }
  }
}

function canGenerate(session: Session | undefined): session is Session {
  return session !== undefined && session.status === "active" && session.titleSource !== "manual" && session.titleSource !== "model"
    && (session.titleSource === "fallback" || !session.title?.trim());
}
function matches(session: Session | undefined, job: TitleJob): boolean {
  return canGenerate(session) && (session.titleRevision ?? 0) === job.expectedTitleRevision;
}
function terminal(job: TitleJob): boolean { return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled"; }
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError("Title limits must be positive safe integers");
  return result;
}
function isProtectedError(error: unknown): boolean {
  return error instanceof SessionTitleConflictError || (error !== null && typeof error === "object"
    && "code" in error && (error.code === "session_archived" || error.code === "session_not_found"));
}
