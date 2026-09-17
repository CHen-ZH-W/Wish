import { createHash, randomUUID } from "node:crypto";

import {
  PlanClosedError,
  PlanConflictError,
  PlanInactiveError,
  PlanInvalidInputError,
  PlanNotFoundError,
} from "./errors.js";
import type {
  ApprovePlanRequest,
  EnterPlanRequest,
  Plan,
  PlanSessionRequest,
  PlanState,
  PlanStateStore,
  UpdatePlanRequest,
  DecidePlanReviewRequest,
  PlanFeedbackRequest,
} from "./types.js";

export interface PlanRuntimeOptions {
  readonly store: PlanStateStore;
  readonly now?: () => Date;
}

/** Provider-neutral Plan state machine. Approval freezes a Plan; it starts no work. */
export class PlanRuntime implements Plan {
  private readonly store: PlanStateStore;
  private readonly now: () => Date;
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: PlanRuntimeOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async get(request: PlanSessionRequest): Promise<PlanState | undefined> {
    this.assertOpen();
    const sessionId = identifier(request.sessionId, "Plan Session id");
    request.signal?.throwIfAborted();
    await (this.tails.get(sessionId) ?? Promise.resolve());
    return this.store.get(sessionId, request.signal);
  }

  enter(request: EnterPlanRequest): Promise<PlanState> {
    const sessionId = identifier(request.sessionId, "Plan Session id");
    const goal = request.goal === undefined
      ? undefined
      : nonBlank(request.goal, "Plan goal");
    return this.serial(sessionId, async () => {
      request.signal?.throwIfAborted();
      const current = await this.store.get(sessionId, request.signal);
      if (current?.active === true) {
        throw new PlanConflictError(`Plan mode is already active for Session ${sessionId}`);
      }
      const next: PlanState = Object.freeze({
        schemaVersion: 1 as const,
        sessionId,
        version: (current?.version ?? 0) + 1,
        active: true,
        ...(goal === undefined ? {} : { goal }),
        enteredAt: this.timestamp(),
      });
      await this.store.put(next, current?.version, request.signal);
      return next;
    });
  }

  update(request: UpdatePlanRequest): Promise<PlanState> {
    const sessionId = identifier(request.sessionId, "Plan Session id");
    const markdown = nonBlank(request.markdown, "Plan markdown");
    return this.serial(sessionId, async () => {
      request.signal?.throwIfAborted();
      const current = await this.store.get(sessionId, request.signal);
      if (current === undefined) throw new PlanNotFoundError(sessionId);
      if (!current.active) throw new PlanInactiveError(sessionId);
      const timestamp = this.timestamp();
      if (request.expectedPlanVersion !== undefined && request.expectedPlanVersion !== (current.document?.version ?? 0)) throw new PlanConflictError("Plan changed during artifact update");
      const next: PlanState = Object.freeze({
        ...current,
        version: current.version + 1,
        ...(current.review === undefined ? {} : { review: Object.freeze({
          ...current.review, status: "superseded" as const, resolvedAt: timestamp,
        }) }),
        document: Object.freeze({
          version: (current.document?.version ?? 0) + 1,
          markdown,
          digest: digest(markdown),
          updatedAt: timestamp,
          ...((request.artifacts ?? current.document?.artifacts) === undefined ? {} : {
            artifacts: Object.freeze((request.artifacts ?? current.document!.artifacts!).map((ref) => Object.freeze({ ...ref }))),
          }),
        }),
      });
      await this.store.put(next, current.version, request.signal);
      return next;
    });
  }

  approve(request: ApprovePlanRequest): Promise<PlanState> {
    const sessionId = identifier(request.sessionId, "Plan Session id");
    const markdown = nonBlank(request.markdown, "Plan markdown");
    const expectedPlanVersion = positiveInteger(
      request.expectedPlanVersion,
      "Expected Plan document version",
    );
    const summary = request.summary === undefined
      ? undefined
      : nonBlank(request.summary, "Plan approval summary");
    return this.serial(sessionId, async () => {
      request.signal?.throwIfAborted();
      const current = await this.store.get(sessionId, request.signal);
      if (current === undefined) throw new PlanNotFoundError(sessionId);
      if (!current.active) throw new PlanInactiveError(sessionId);
      if (current.document === undefined) {
        throw new PlanConflictError("Plan must be saved with update_plan before approval");
      }
      if (current.review) throw new PlanConflictError("Use the explicit human review decision for a submitted Plan");
      if (
        current.document.version !== expectedPlanVersion ||
        current.document.markdown !== markdown ||
        current.document.digest !== digest(markdown)
      ) {
        throw new PlanConflictError(
          "Plan approval does not match the latest saved document",
        );
      }
      const timestamp = this.timestamp();
      const next: PlanState = Object.freeze({
        ...current,
        version: current.version + 1,
        active: false,
        exitedAt: timestamp,
        document: Object.freeze({
          ...current.document,
          approvedAt: timestamp,
          ...(summary === undefined ? {} : { approvalSummary: summary }),
        }),
      });
      await this.store.put(next, current.version, request.signal);
      return next;
    });
  }

  review(request: ApprovePlanRequest): Promise<PlanState> {
    const sessionId = identifier(request.sessionId, "Plan Session id");
    return this.serial(sessionId, async () => {
      const current = await this.store.get(sessionId, request.signal);
      if (current?.active !== true || current.document === undefined) {
        throw new PlanConflictError("Save an active Plan before requesting review");
      }
      if (current.document.version !== request.expectedPlanVersion ||
          current.document.markdown !== request.markdown) {
        throw new PlanConflictError("Review must match the latest saved Plan");
      }
      if (current.review?.status === "pending") return current;
      if (current.review?.planVersion === current.document.version) {
        throw new PlanConflictError("Revise the Plan before submitting it for review again");
      }
      const next: PlanState = Object.freeze({
        ...current, version: current.version + 1,
        review: Object.freeze({
          id: randomUUID(), status: "pending" as const,
          planVersion: current.document.version, digest: current.document.digest,
          submittedAt: this.timestamp(),
        }),
      });
      await this.store.put(next, current.version, request.signal);
      return next;
    });
  }

  decide(request: DecidePlanReviewRequest): Promise<PlanState> {
    const actor = nonBlank(request.actor, "Review actor");
    if (!["approve", "keep-planning", "cancel"].includes(request.decision)) {
      throw new PlanInvalidInputError("Unknown review decision");
    }
    const feedback = request.feedback === undefined ? undefined : nonBlank(request.feedback, "Review feedback");
    if (request.decision === "keep-planning" && feedback === undefined) {
      throw new PlanInvalidInputError("Continuing planning requires feedback");
    }
    return this.serial(identifier(request.sessionId, "Plan Session id"), async () => {
      const current = await this.store.get(request.sessionId, request.signal);
      const review = current?.review;
      const document = current?.document;
      if (current === undefined || review === undefined || document === undefined ||
          review.id !== request.reviewId || document.version !== request.expectedPlanVersion ||
          document.digest !== request.digest || review.digest !== request.digest) {
        throw new PlanConflictError("Review does not match the current Plan");
      }
      const status = request.decision === "approve" ? "approved" as const
        : request.decision === "keep-planning" ? "changes-requested" as const : "cancelled" as const;
      if (review.status === status && review.actor === actor && review.feedback === feedback) return current;
      if (!current.active || review.status !== "pending") throw new PlanConflictError("Review is no longer pending");
      const timestamp = this.timestamp();
      const next: PlanState = Object.freeze({
        ...current, version: current.version + 1,
        ...(status === "approved" ? {
          active: false, exitedAt: timestamp,
          document: Object.freeze({ ...document, approvedAt: timestamp }),
        } : {}),
        review: Object.freeze({ ...review, status, actor, resolvedAt: timestamp,
          ...(feedback === undefined ? {} : { feedback }),
        }),
      });
      await this.store.put(next, current.version, request.signal);
      return next;
    });
  }

  feedback(request: PlanFeedbackRequest): Promise<PlanState | undefined> {
    const text = nonBlank(request.text, "Plan feedback");
    const actor = nonBlank(request.actor, "Feedback actor");
    return this.serial(identifier(request.sessionId, "Plan Session id"), async () => {
      const current = await this.store.get(request.sessionId, request.signal);
      if (current?.active !== true || current.review?.status !== "pending") return current;
      const next: PlanState = Object.freeze({
        ...current, version: current.version + 1,
        review: Object.freeze({ ...current.review, status: "changes-requested" as const,
          actor, feedback: text, resolvedAt: this.timestamp(),
        }),
      });
      await this.store.put(next, current.version, request.signal);
      return next;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.tails.values()].map((tail) => tail.catch(() => undefined)));
    await this.store.close();
  }

  private serial<Value>(
    sessionId: string,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    this.assertOpen();
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      this.assertOpen();
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, settled);
    void settled.then(() => {
      if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId);
    });
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new PlanClosedError();
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new PlanInvalidInputError("Plan clock returned an invalid Date");
    }
    return value.toISOString();
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new PlanInvalidInputError(`${label} must be non-empty trimmed text`);
  }
  return value;
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlanInvalidInputError(`${label} must not be empty`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlanInvalidInputError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function digest(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}
