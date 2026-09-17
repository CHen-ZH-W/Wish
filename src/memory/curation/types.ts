import type { MemoryContent, MemoryEvidence } from "../types.js";

/** Frozen evidence, not instructions and not proof that validation succeeded. */
export interface CurationEvidence {
  readonly id: string;
  readonly sourceId: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown";
  readonly sessionId?: string;
  readonly runId?: string;
  readonly appliesTo: string;
  readonly text: string;
  readonly references: readonly MemoryEvidence[];
}
export interface CurationEvidenceSource {
  readonly id: string;
  /** Backscan committed authority; notifications alone are insufficient. */
  scan(signal?: AbortSignal): Promise<readonly CurationEvidence[]>;
}
export interface MemoryCandidateExtractor {
  extract(evidence: CurationEvidence, signal: AbortSignal): Promise<readonly MemoryContent[]>;
}
export interface CurationJob {
  readonly id: string;
  readonly evidence: CurationEvidence;
  readonly status: "queued" | "running" | "proposing" | "completed" | "failed" | "cancelled";
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Commit extracted bodies before performing any Memory operation. */
  readonly proposals?: readonly MemoryContent[];
  readonly candidateIds: readonly string[];
  readonly error?: string;
}
export interface CurationState {
  readonly schemaVersion: 1;
  readonly libraryId: string;
  readonly revision: number;
  readonly jobs: readonly CurationJob[];
}
export interface CurationStore {
  read(signal?: AbortSignal): Promise<CurationState>;
  commit(state: CurationState, expectedRevision: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
