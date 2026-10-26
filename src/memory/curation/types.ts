import type { MemoryContent, MemoryDocument, MemoryEvidence, MemoryRetirement, MemoryUpsert } from "../types.js";

/** Frozen evidence, not instructions and not proof that validation succeeded. */
export interface CurationEvidence {
  readonly id: string;
  readonly sourceId: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown";
  readonly sessionId?: string;
  readonly runId?: string;
  readonly occurredAt?: string;
  readonly appliesTo: string;
  readonly text: string;
  readonly references: readonly MemoryEvidence[];
}
export interface CurationEvidenceSource {
  readonly id: string;
  /** Backscan committed authority; notifications alone are insufficient. */
  scan(signal?: AbortSignal, context?: CurationScanContext): Promise<readonly CurationEvidence[]>;
}
/** Automatic selection uses activity and evidence identity, not a fixed task quota. */
export interface CurationScanContext {
  readonly oldestAt: number;
  readonly knownEvidenceIds: ReadonlySet<string>;
  acceptsSession(sessionId: string): Promise<boolean>;
}
export interface ExtractedMemory extends MemoryContent { readonly rolloutSummary?: string; readonly rolloutSlug?: string }
export interface MemoryExtractor {
  extract(evidence: CurationEvidence, signal: AbortSignal): Promise<readonly ExtractedMemory[]>;
}
export interface CurationJob {
  readonly id: string;
  readonly evidence: CurationEvidence;
  readonly status: "queued" | "running" | "extracted" | "consolidating" | "proposing" | "completed" | "failed" | "cancelled";
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Commit extracted bodies before performing any Memory operation. */
  readonly rawMemories?: readonly ExtractedMemory[];
  readonly usageCount?: number;
  readonly lastUsedAt?: string;
  /** Legacy extraction payload, read for migration only. */
  readonly proposals?: readonly MemoryContent[];
  /** Historical candidate receipts; new jobs do not create candidates. */
  readonly candidateIds: readonly string[];
  readonly documentIds?: readonly string[];
  readonly error?: string;
}
export interface CurationState {
  readonly schemaVersion: 1;
  readonly libraryId: string;
  readonly revision: number;
  readonly jobs: readonly CurationJob[];
  readonly consolidation?: ConsolidationPlan;
  readonly inputDigest?: string;
  readonly libraryRevision?: number;
  readonly selectedJobIds?: readonly string[];
  /** Source identities retained after old extraction payloads are pruned. */
  readonly retiredEvidenceIds?: readonly string[];
}
export interface CurationStore {
  read(signal?: AbortSignal): Promise<CurationState>;
  commit(state: CurationState, expectedRevision: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface RawMemory extends MemoryContent { readonly id: string }
export interface ConsolidationInput {
  readonly rawMemories: readonly RawMemory[];
  readonly documents: readonly MemoryDocument[];
  readonly jobs?: readonly CurationJob[];
  readonly removedJobIds?: readonly string[];
}
export interface MemoryChanges {
  readonly upserts: readonly MemoryUpsert[];
  readonly retirements: readonly MemoryRetirement[];
  /** Complete prepared workspace, durably saved before atomic publication. */
  readonly files?: Readonly<Record<string, string>>;
  readonly workspaceBefore?: Readonly<Record<string, string>>;
}
export interface MemoryConsolidator {
  consolidate(input: ConsolidationInput, signal: AbortSignal): Promise<MemoryChanges>;
  inputFingerprint?(): Promise<string>;
  publish?(files: Readonly<Record<string, string>>, signal: AbortSignal, before?: Readonly<Record<string, string>>): Promise<void>;
}
export interface ConsolidationPlan extends MemoryChanges {
  readonly operationId: string;
  readonly jobIds: readonly string[];
  readonly expectedRevision: number;
  readonly inputDigest?: string;
  readonly workspaceFingerprint?: string;
}
/** Compatibility name for existing extraction adapters. */
export type MemoryCandidateExtractor = MemoryExtractor;
