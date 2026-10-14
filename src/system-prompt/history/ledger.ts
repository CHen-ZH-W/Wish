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

/** Append-only history kept outside the canonical Session transcript. */
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
}

function decodeSnapshot(bytes: Uint8Array): SystemPromptSnapshot {
  return normalizeSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as SystemPromptSnapshotInput);
}

function normalizeSnapshot(value: SystemPromptSnapshotInput): SystemPromptSnapshot {
  if (!value || typeof value !== "object") throw new TypeError("System Prompt snapshot must be an object");
  const capturedAt = timestamp(value.capturedAt);
  if (!value.model || typeof value.model !== "object") throw new TypeError("System Prompt snapshot model is invalid");
  const sections = value.sections.map(normalizeSection);
  const size = sections.reduce((total, section) => total + section.content.length, 0);
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
    sections: Object.freeze(sections),
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
