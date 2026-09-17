export interface PlanDocument {
  readonly version: number;
  readonly markdown: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly approvedAt?: string;
  readonly approvalSummary?: string;
  readonly artifacts?: readonly PlanArtifactRef[];
}

/** Immutable references supplied by independent planning capabilities. */
export interface PlanArtifactRef { readonly kind: string; readonly id: string; readonly version: number; readonly digest: string }
export interface PlanModeControl { readonly toolName: string; readonly resourcePrefix: string }

/** Durable, Session-scoped Plan state. It is not a Session transcript message. */
export interface PlanState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly version: number;
  readonly active: boolean;
  readonly goal?: string;
  readonly enteredAt: string;
  readonly exitedAt?: string;
  readonly document?: PlanDocument;
  readonly review?: PlanReview;
}

export interface PlanReview {
  readonly id: string;
  readonly status: "pending" | "approved" | "changes-requested" | "cancelled" | "superseded";
  readonly planVersion: number;
  readonly digest: string;
  readonly submittedAt: string;
  readonly resolvedAt?: string;
  readonly actor?: string;
  readonly feedback?: string;
}

/** Human-only decision port. It is deliberately absent from the model Tools. */
export interface DecidePlanReviewRequest extends PlanSessionRequest {
  readonly reviewId: string;
  readonly expectedPlanVersion: number;
  readonly digest: string;
  readonly decision: "approve" | "keep-planning" | "cancel";
  readonly actor: string;
  readonly feedback?: string;
}

export interface PlanFeedbackRequest extends PlanSessionRequest {
  readonly text: string;
  readonly actor: string;
}

export interface PlanSessionRequest {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface EnterPlanRequest extends PlanSessionRequest {
  readonly goal?: string;
}

export interface UpdatePlanRequest extends PlanSessionRequest {
  readonly expectedPlanVersion?: number;
  readonly markdown: string;
  readonly artifacts?: readonly PlanArtifactRef[];
}

export interface ApprovePlanRequest extends PlanSessionRequest {
  /** Repeated deliberately so the approval surface displays the exact Plan. */
  readonly markdown: string;
  readonly expectedPlanVersion: number;
  readonly summary?: string;
}

export interface Plan {
  get(request: PlanSessionRequest): Promise<PlanState | undefined>;
  enter(request: EnterPlanRequest): Promise<PlanState>;
  update(request: UpdatePlanRequest): Promise<PlanState>;
  approve(request: ApprovePlanRequest): Promise<PlanState>;
  review(request: ApprovePlanRequest): Promise<PlanState>;
  decide(request: DecidePlanReviewRequest): Promise<PlanState>;
  feedback(request: PlanFeedbackRequest): Promise<PlanState | undefined>;
  close(): Promise<void>;
}

export interface PlanStateStore {
  get(sessionId: string, signal?: AbortSignal): Promise<PlanState | undefined>;
  /** expectedVersion undefined means the Session must not exist yet. */
  put(
    state: PlanState,
    expectedVersion?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}
