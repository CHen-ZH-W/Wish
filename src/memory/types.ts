/** Persistent knowledge, not conversation history or task execution state. */
export type MemoryStatus = "accepted" | "stale" | "superseded" | "deleted";
export interface MemoryEvidence {
  readonly kind: "session" | "workflow" | "operator";
  readonly id: string;
  readonly revision: string;
  readonly digest: string;
  /** Last committed Session sequence covered by this evidence digest. */
  readonly throughSequence?: number;
}
export interface MemoryActor {
  readonly kind: "human" | "agent" | "curation" | "child";
  readonly id: string;
  readonly sessionId?: string;
  readonly runId?: string;
}
export interface MemoryContent {
  readonly title: string;
  readonly content: string;
  /** Routing guidance, never a substitute for access authorization. */
  readonly appliesTo: string;
  readonly keywords: readonly string[];
  readonly evidence: readonly MemoryEvidence[];
}
export interface MemoryDocument extends MemoryContent {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly status: MemoryStatus;
  readonly updatedAt: string;
  readonly supersededBy?: string;
}
export interface MemoryCandidate extends MemoryContent {
  readonly id: string;
  readonly version: number;
  readonly status: "pending" | "accepted" | "rejected";
  readonly targetId: string;
  readonly expectedDocumentVersion: number;
  readonly actor: MemoryActor;
  /** Host-owned human review routing; source actor remains unchanged. */
  readonly reviewSessionId?: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
}
export interface MemoryAudit {
  readonly revision: number;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly action: "propose" | "accept" | "reject" | "status";
  readonly targetId: string;
  readonly actor: MemoryActor;
  readonly reason: string;
  readonly at: string;
}
export interface MemoryState {
  readonly schemaVersion: 1;
  readonly libraryId: string;
  readonly revision: number;
  readonly documents: readonly MemoryDocument[];
  readonly candidates: readonly MemoryCandidate[];
  readonly audit: readonly MemoryAudit[];
}
export interface MemoryOperation {
  /** Host-provided identity reused after an uncertain response, never blindly replayed. */
  readonly operationId: string;
  readonly actor: MemoryActor;
  readonly reason: string;
  readonly signal?: AbortSignal;
}
export interface ProposeMemoryRequest extends MemoryOperation, MemoryContent {
  readonly targetId: string;
  readonly expectedDocumentVersion: number;
  readonly reviewSessionId?: string;
}
export interface DecideMemoryRequest extends MemoryOperation {
  readonly candidateId: string;
  readonly expectedCandidateVersion: number;
  readonly decision: "accept" | "reject";
}
export interface ChangeMemoryStatusRequest extends MemoryOperation {
  readonly id: string;
  readonly expectedVersion: number;
  readonly status: Exclude<MemoryStatus, "accepted">;
  readonly supersededBy?: string;
}
export interface MemoryQuery {
  readonly text?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
export interface MemorySnapshot {
  readonly schemaVersion: 1;
  readonly libraryId: string;
  readonly revision: number;
  readonly documents: readonly MemoryDocument[];
}
/** Host capability. Model and human Consumers have separate authority checks. */
export interface Memory {
  readonly libraryId: string;
  state(signal?: AbortSignal): Promise<MemoryState>;
  query(input?: MemoryQuery): Promise<readonly MemoryDocument[]>;
  read(id: string, signal?: AbortSignal): Promise<MemoryDocument | undefined>;
  propose(input: ProposeMemoryRequest): Promise<MemoryCandidate>;
  decide(input: DecideMemoryRequest): Promise<MemoryCandidate>;
  changeStatus(input: ChangeMemoryStatusRequest): Promise<MemoryDocument>;
  snapshot(input?: MemoryQuery): Promise<MemorySnapshot>;
  close(): Promise<void>;
}
export interface MemoryStateStore {
  readonly libraryId: string;
  read(signal?: AbortSignal): Promise<MemoryState>;
  commit(state: MemoryState, expectedRevision: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
