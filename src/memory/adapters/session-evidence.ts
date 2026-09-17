import type { DurableRuntimeLifecycleEvent } from "../../core/runtime/durability/types.js";
import type { ReadSessionHistoryInput, SessionHistorySnapshot } from "../../sessions/types.js";
import { SessionNotFoundError } from "../../sessions/types.js";
import { hash } from "../validation.js";
import type { CurationEvidence, CurationEvidenceSource } from "../curation/types.js";
import { clipEvidenceText, snapshotEvidence } from "../curation/validation.js";

export interface SessionEvidenceAccess {
  readHistory(input: ReadSessionHistoryInput): Promise<SessionHistorySnapshot>;
}
export interface RuntimeEvidenceAccess {
  readEvents(runId?: string, signal?: AbortSignal): Promise<readonly DurableRuntimeLifecycleEvent[]>;
}
export async function captureSessionEvidence(input: {
  readonly sessions: SessionEvidenceAccess; readonly sessionId: string; readonly runId: string;
  readonly terminal: DurableRuntimeLifecycleEvent; readonly sourceId?: string; readonly signal?: AbortSignal;
}): Promise<CurationEvidence | undefined> {
  input.signal?.throwIfAborted();
  const terminal = input.terminal;
  if (terminal.runId !== input.runId || !["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(terminal.type)) throw new Error("Session evidence requires a matching committed terminal Run fact");
  const history = await input.sessions.readHistory({ sessionId: input.sessionId, ...(input.signal ? { signal: input.signal } : {}) });
  input.signal?.throwIfAborted();
  const committed = history.records.filter(record => record.kind === "message" && record.runId === input.runId);
  const records = committed.filter(record => record.kind === "message" && record.message.role !== "system" && record.message.role !== "developer").map(record => {
    if (record.kind !== "message") throw new Error("Unreachable record kind");
    return { sequence: record.sequence, recordId: record.recordId, userTurnId: record.userTurnId, stepId: record.stepId,
      origin: record.origin, inputSource: record.inputSource ?? "unknown", message: record.message,
      ...(record.toolResultArchive ? { toolResultArchive: record.toolResultArchive } : {}) };
  });
  if (!records.length) return undefined;
  const digest = hash(committed), throughSequence = committed.at(-1)!.sequence;
  const packageDigest = hash({ sessionId: input.sessionId, runId: input.runId, terminal: { type: terminal.type, occurredAt: terminal.occurredAt }, digest });
  const outcome = terminal.type === "run.completed" ? "completed" : terminal.type === "run.failed" ? "failed" : terminal.type === "run.aborted" ? "cancelled" : "unknown";
  return snapshotEvidence({ id: `session-${packageDigest}`, sourceId: input.sourceId ?? "runtime-sessions", sessionId: input.sessionId, runId: input.runId, outcome,
    appliesTo: `Session ${input.sessionId}; Run ${input.runId}. Recheck workspace and applicability before reuse.`,
    text: clipEvidenceText(JSON.stringify({ untrustedCommittedMessages: records.map(record => ({ ...record, message: {
      role: record.message.role, content: clipEvidenceText(record.message.content, 12_000),
      originalContentChars: record.message.content.length, truncated: record.message.content.length > 12_000,
      ...(record.message.toolCallId ? { toolCallId: record.message.toolCallId } : {}),
    } })) })),
    references: [{ kind: "session", id: `${input.sessionId}:${input.runId}`, revision: `run:${digest}`, digest, throughSequence }] });
}
export class SessionRunEvidenceSource implements CurationEvidenceSource {
  readonly id = "runtime-sessions";
  constructor(private readonly sessions: SessionEvidenceAccess, private readonly lifecycle: RuntimeEvidenceAccess) {}
  async scan(signal?: AbortSignal): Promise<readonly CurationEvidence[]> {
    const events = await this.lifecycle.readEvents(undefined, signal), scopes = new Map<string, string>(), terminals = new Map<string, DurableRuntimeLifecycleEvent>();
    for (const event of events) {
      if (event.type === "run.opened" && event.scope) scopes.set(event.runId, event.scope);
      if (["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)) terminals.set(event.runId, event);
    }
    const result: CurationEvidence[] = [];
    for (const [runId, terminal] of terminals) {
      signal?.throwIfAborted();
      const sessionId = scopes.get(runId); if (!sessionId) continue;
      try {
        const evidence = await captureSessionEvidence({ sessions: this.sessions, sessionId, runId, terminal, sourceId: this.id, ...(signal ? { signal } : {}) });
        if (evidence) result.push(evidence);
      } catch (error) {
        // Other Application data roots are outside this adapter's Session lease.
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
    }
    return Object.freeze(result);
  }
}
