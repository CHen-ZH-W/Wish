import type { DurableRuntimeLifecycleEvent } from "../../core/runtime/durability/types.js";
import type { ReadSessionHistoryInput, SessionHistorySnapshot, Session, GetSessionInput } from "../../sessions/types.js";
import { SessionNotFoundError } from "../../sessions/types.js";
import { hash } from "../validation.js";
import type { CurationEvidence, CurationEvidenceSource, CurationScanContext } from "../curation/types.js";
import { snapshotEvidence } from "../curation/validation.js";

export interface SessionEvidenceAccess {
  get?(input: GetSessionInput): Promise<Session>;
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
    occurredAt: terminal.occurredAt,
    appliesTo: `Session ${input.sessionId}; Run ${input.runId}. Recheck workspace and applicability before reuse.`,
    text: JSON.stringify({ untrustedCommittedMessages: records }),
    references: [{ kind: "session", id: `${input.sessionId}:${input.runId}`, revision: `run:${digest}`, digest, throughSequence }] });
}
export class SessionRunEvidenceSource implements CurationEvidenceSource {
  readonly id = "runtime-sessions";
  constructor(private readonly sessions: SessionEvidenceAccess, private readonly lifecycle: RuntimeEvidenceAccess) {}
  async scan(signal?: AbortSignal, context?: CurationScanContext): Promise<readonly CurationEvidence[]> {
    const events = await this.lifecycle.readEvents(undefined, signal), scopes = new Map<string, string>(), terminals = new Map<string, DurableRuntimeLifecycleEvent>();
    for (const event of events) {
      if (event.type === "run.opened" && event.scope) scopes.set(event.runId, event.scope);
      if (["run.completed", "run.failed", "run.aborted", "run.interrupted"].includes(event.type)) terminals.set(event.runId, event);
    }
    const result: CurationEvidence[] = [];
    const activeSessions = new Set([...scopes].filter(([runId]) => !terminals.has(runId)).map(([, sessionId]) => sessionId));
    const candidates = [...terminals].sort((a, b) => Date.parse(b[1].occurredAt) - Date.parse(a[1].occurredAt));
    const seen = new Set<string>();
    for (const [runId, terminal] of candidates) {
      signal?.throwIfAborted();
      const sessionId = scopes.get(runId); if (!sessionId || seen.has(sessionId) || activeSessions.has(sessionId)) continue;
      seen.add(sessionId);
      if (context && (Date.parse(terminal.occurredAt) < context.oldestAt || !await context.acceptsSession(sessionId))) continue;
      try {
        const history = await this.sessions.readHistory({ sessionId, ...(signal ? { signal } : {}) });
        const records = history.records.filter(record => record.kind === "message" && record.message.role !== "system" && record.message.role !== "developer");
        if (!records.length) continue;
        // Legacy provenance remains readable; known internal-only conversations are not learning sources.
        if (!records.some(record => record.kind === "message" && record.message.role === "user" && (record.inputSource === undefined || ["user", "unknown"].includes(record.inputSource)))) continue;
        const metadata = await this.sessions.get?.({ sessionId, ...(signal ? { signal } : {}) });
        if (metadata && metadata.status !== "active") continue;
        const digest = hash(records), throughSequence = records.at(-1)!.sequence;
        const evidence = snapshotEvidence({ id: `session-${hash({ sessionId, digest })}`, sourceId: this.id, sessionId, runId,
          occurredAt: terminal.occurredAt, outcome: terminal.type === "run.completed" ? "completed" : terminal.type === "run.failed" ? "failed" : "unknown",
          appliesTo: metadata?.scope ?? `Session ${sessionId}; verify workspace applicability`,
          text: JSON.stringify({ sessionId, workspace: metadata?.scope, untrustedCommittedMessages: records }),
          references: [{ kind: "session", id: sessionId, revision: `rollout:${digest}`, digest, throughSequence }] });
        if (!context?.knownEvidenceIds.has(evidence.id)) result.push(evidence);
      } catch (error) {
        // Other Application data roots are outside this adapter's Session lease.
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
    }
    return Object.freeze(result);
  }
}
