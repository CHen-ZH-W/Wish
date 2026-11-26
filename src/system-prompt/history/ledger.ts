import { createHash } from "node:crypto";
import { StorageCorruptionError } from "../../storage/errors.js";
import { JOURNAL_ANY, type Journal } from "../../storage/journal.js";
import type {
  SystemPromptHistory,
  SystemPromptSnapshot,
  SystemPromptSnapshotInput,
  SystemPromptSnapshotSection,
} from "./types.js";

export const SYSTEM_PROMPT_HISTORY_NAMESPACE = "system-prompt/history/v1";

/** Immutable request snapshots with owner-directed reclamation, outside the Session transcript. */
export class JournalSystemPromptHistory implements SystemPromptHistory {
  private closing: Promise<void> | undefined;

  constructor(private readonly journal: Journal, private readonly backendId: string) {}

  async record(input: SystemPromptSnapshotInput, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const snapshot = normalizeSnapshot(input);
    const idempotency = createHash("sha256").update(JSON.stringify({
      sessionId: snapshot.sessionId,
      runId: snapshot.runId,
      stepId: snapshot.stepId,
      digest: snapshot.digest,
      ...(snapshot.runtimeState === undefined ? {} : { stateDigest: snapshot.runtimeState.digest }),
    })).digest("hex");
    await this.journal.append({
      idempotencyKey: `system-prompt:${idempotency}`,
      entries: [new TextEncoder().encode(JSON.stringify(snapshot))],
    }, JOURNAL_ANY, signal);
  }

  async list(sessionIdValue: string, signal?: AbortSignal): Promise<readonly SystemPromptSnapshot[]> {
    throwIfAborted(signal);
    const sessionId = identifier(sessionIdValue, "Session id");
    const records = new Map<string, SystemPromptSnapshot>();
    try {
      for await (const entry of this.journal.read(signal === undefined ? {} : { signal })) {
        const snapshot = decodeSnapshot(entry.value);
        if (snapshot.sessionId === sessionId) records.set(`${snapshot.runId}/${snapshot.stepId}`, snapshot);
      }
    } catch (error: unknown) {
      if (error instanceof StorageCorruptionError) throw error;
      if (error instanceof SyntaxError || error instanceof TypeError) {
        throw new StorageCorruptionError("System Prompt history contains invalid data", {
          backendId: this.backendId,
          facet: "journal",
          namespace: SYSTEM_PROMPT_HISTORY_NAMESPACE,
        }, { cause: error });
      }
      throw error;
    }
    return Object.freeze([...records.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)));
  }

  close(): Promise<void> {
    return this.closing ??= this.journal.flush().then(() => this.journal.close());
  }

  async purgeSession(sessionId: string): Promise<void> {
    const owner = identifier(sessionId, "Session id");
    if (!this.journal.compact) throw new Error("System Prompt history Journal does not support reclamation");
    await this.journal.compact(entry => decodeSnapshot(entry.value).sessionId !== owner);
  }

  async sweepDeletedSessions(wasDeleted: (sessionId: string) => Promise<boolean>): Promise<void> {
    const owners = new Set<string>();
    for await (const entry of this.journal.read()) owners.add(decodeSnapshot(entry.value).sessionId);
    const removed = new Set<string>();
    for (const owner of owners) if (await wasDeleted(owner)) removed.add(owner);
    if (!removed.size) return;
    if (!this.journal.compact) throw new Error("System Prompt history Journal does not support reclamation");
    await this.journal.compact(entry => !removed.has(decodeSnapshot(entry.value).sessionId));
  }
}

function decodeSnapshot(bytes: Uint8Array): SystemPromptSnapshot {
  return normalizeSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as SystemPromptSnapshotInput);
}

function normalizeSnapshot(value: SystemPromptSnapshotInput): SystemPromptSnapshot {
  if (!value || typeof value !== "object") throw new TypeError("System Prompt snapshot must be an object");
  const capturedAt = timestamp(value.capturedAt);
  if (!value.model || typeof value.model !== "object") throw new TypeError("System Prompt snapshot model is invalid");
  const sections = value.sections.map(normalizeSection);
  if (value.runtimeState !== undefined && (!value.runtimeState || !Array.isArray(value.runtimeState.sections))) {
    throw new TypeError("Runtime state snapshot is invalid");
  }
  const stateSections = value.runtimeState?.sections.map(normalizeSection);
  if (stateSections?.some(section => section.channel !== "dynamic_tail")) throw new TypeError("Runtime state snapshot channel is invalid");
  const stateDigest = stateSections && createHash("sha256").update(JSON.stringify(stateSections)).digest("hex");
  if (value.runtimeState && stateDigest !== digest(value.runtimeState.digest)) throw new TypeError("Runtime state snapshot digest does not match its contents");
  if (value.dynamicTailScope !== undefined && value.dynamicTailScope !== "all-instructions") throw new TypeError("System Prompt dynamic tail scope is invalid");
  const size = [...sections, ...(stateSections ?? [])].reduce((total, section) => total + section.content.length, 0);
  if (size > 2_097_152) throw new TypeError("System Prompt snapshot exceeds 2 MiB");
  return Object.freeze({
    schemaVersion: 1,
    sessionId: identifier(value.sessionId, "Session id"),
    runId: identifier(value.runId, "Run id"),
    userTurnId: identifier(value.userTurnId, "UserTurn id"),
    stepId: identifier(value.stepId, "Step id"),
    capturedAt,
    model: Object.freeze({
      provider: identifier(value.model.provider, "Model provider"),
      model: identifier(value.model.model, "Model id"),
    }),
    digest: digest(value.digest),
    ...(value.dynamicTailScope === undefined ? {} : { dynamicTailScope: value.dynamicTailScope }),
    sections: Object.freeze(sections),
    ...(stateSections === undefined ? {} : { runtimeState: Object.freeze({ digest: stateDigest!, sections: Object.freeze(stateSections) }) }),
  });
}

function normalizeSection(value: SystemPromptSnapshotSection): SystemPromptSnapshotSection {
  if (!value || typeof value !== "object") throw new TypeError("System Prompt snapshot section is invalid");
  if (value.channel !== "instructions" && value.channel !== "dynamic_tail") throw new TypeError("System Prompt snapshot channel is invalid");
  if (value.role !== "system" && value.role !== "developer") throw new TypeError("System Prompt snapshot role is invalid");
  if (typeof value.content !== "string" || value.content.length === 0) throw new TypeError("System Prompt snapshot content is invalid");
  return Object.freeze({ channel: value.channel, role: value.role, content: value.content });
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > 512) throw new TypeError(`${label} is invalid`);
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("System Prompt snapshot digest is invalid");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("System Prompt snapshot timestamp is invalid");
  return new Date(value).toISOString();
}
function throwIfAborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
