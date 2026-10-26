import type { ModelRef, ModelUsage } from "../core/model/model.js";
import type { SessionStore } from "../sessions/types.js";

export interface TitleGenerationInput {
  readonly text: string;
  readonly model?: ModelRef;
  readonly signal: AbortSignal;
}

export interface TitleGenerationResult {
  readonly title: string;
  readonly model?: ModelRef;
  readonly usage?: ModelUsage;
}

/** A title-only Provider; successful results must represent a completed response. */
export interface TitleGenerator {
  generate(input: TitleGenerationInput): Promise<TitleGenerationResult>;
}

export class TitleGenerationError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message = code) {
    super(message);
    this.name = "TitleGenerationError";
  }
}

export type TitleJobState = "pending" | "running" | "retry" | "succeeded" | "failed" | "cancelled";

/** One durable first-input job. seed is deliberately bounded, never a transcript. */
export interface TitleJob {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly jobId: string;
  readonly version: number;
  readonly state: TitleJobState;
  readonly seed: string;
  readonly inputId?: string;
  readonly model?: ModelRef;
  readonly usage?: ModelUsage;
  readonly expectedTitleRevision: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Stable, safe error code only; Provider messages and user content are excluded. */
  readonly lastError?: string;
}

/** Undefined expectedVersion means create-if-absent; all mutations use CAS. */
export interface TitleJobStore {
  get(sessionId: string): Promise<TitleJob | undefined>;
  put(job: TitleJob, expectedVersion?: number): Promise<void>;
  delete(sessionId: string, expectedVersion: number): Promise<void>;
}

export class TitleJobConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session title job changed: ${sessionId}`);
    this.name = "TitleJobConflictError";
  }
}

export interface TitleConfig {
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly maxTitleBytes?: number;
  readonly fallbackMaxCodePoints?: number;
  readonly fallbackMaxBytes?: number;
  readonly seedMaxCodePoints?: number;
}

export interface TitleAcceptedInput {
  readonly sessionId: string;
  readonly text: string;
  readonly inputId?: string;
  readonly model?: ModelRef;
}

export interface TitleEvent {
  readonly sessionId: string;
  readonly state: TitleJobState;
  readonly attempts: number;
  readonly errorCode?: string;
  readonly latencyMs?: number;
  readonly route?: ModelRef;
  readonly usage?: ModelUsage;
}

export interface TitleControllerOptions {
  readonly sessions: Pick<SessionStore, "get" | "list" | "updateMetadata"> & Partial<Pick<SessionStore, "readHistory">>;
  readonly store: TitleJobStore;
  readonly generator: TitleGenerator;
  /** Cheap live scheduling check. Foreground work keeps jobs pending without
   * occupying a title request slot or consuming an attempt. */
  readonly canDispatch?: () => boolean;
  readonly config?: TitleConfig;
  readonly now?: () => number;
  readonly onEvent?: (event: TitleEvent) => void;
}
