export type JournalPrecondition =
  | { readonly kind: "any" }
  | { readonly kind: "revision"; readonly revision: string };

export interface JournalBatch {
  /** Identifies this whole atomic append, not an individual entry. */
  readonly idempotencyKey: string;
  readonly entries: readonly Uint8Array[];
}

export interface JournalCommit {
  readonly idempotencyKey: string;
  readonly firstCursor: number;
  readonly lastCursor: number;
  readonly revision: string;
  readonly replayed: boolean;
}

export interface JournalEntry {
  readonly cursor: number;
  readonly revision: string;
  readonly idempotencyKey: string;
  readonly batchIndex: number;
  readonly value: Uint8Array;
}

export interface JournalReadOptions {
  /** Exclusive cursor. Omit to read from the beginning. */
  readonly afterCursor?: number;
  readonly signal?: AbortSignal;
}

export interface Journal {
  append(
    batch: JournalBatch,
    precondition: JournalPrecondition,
    signal?: AbortSignal,
  ): Promise<JournalCommit>;
  read(options?: JournalReadOptions): AsyncIterable<JournalEntry>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenJournalRequest {
  readonly namespace: string;
}

export interface JournalStorageBackend {
  readonly facet: "journal";
  open(request: OpenJournalRequest): Journal;
}

export const JOURNAL_ANY: JournalPrecondition = Object.freeze({ kind: "any" });
