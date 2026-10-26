import { ProfileRecordStore } from "../agent-profiles/store.js";
import { freezeJson } from "../agent-profiles/validation.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { digest, EvolutionStageError, fail, object, sha, text, validateReceipt, validateStageFailure } from "./validation.js";
import type { EvolutionPorts, EvolutionStage, EvolutionStageContext, EvolutionStageFailure, EvolutionStageReceipt, EvolutionUsage } from "./types.js";

interface JournalEntry {
  readonly operationId: string; readonly inputDigest: string; readonly stage: EvolutionStage;
  readonly receipt?: EvolutionStageReceipt; readonly failure?: EvolutionStageFailure;
}
export interface EvolutionOperationJournal {
  read(operationId: string): Promise<JournalEntry | undefined>;
  put(value: JournalEntry): Promise<JournalEntry>;
}
/** Durable receipts precede Controller acknowledgement; models have no access to this store. */
export class StorageEvolutionOperationJournal implements EvolutionOperationJournal {
  private readonly records: ProfileRecordStore<JournalEntry>;
  constructor(storage: StorageBackendResolver, backendId: string) {
    this.records = new ProfileRecordStore(storage, backendId, "evolution/operation-receipts/v1", value => {
      const row = object(value); text(row.operationId); sha(row.inputDigest);
      if (!["evidence", "generate", "candidate", "evaluate", "feedback", "publish"].includes(String(row.stage)) || (row.receipt === undefined) === (row.failure === undefined)) fail("evolution_journal_invalid");
      return freezeJson(row) as unknown as JournalEntry;
    });
  }
  read(operationId: string) { return this.records.get(operationId); }
  put(value: JournalEntry) { return this.records.create(value.operationId, value); }
}
export class MemoryEvolutionOperationJournal implements EvolutionOperationJournal {
  private readonly records = new Map<string, JournalEntry>();
  async read(id: string) { return this.records.get(id); }
  async put(value: JournalEntry) {
    const old = this.records.get(value.operationId);
    if (old && digest(old) !== digest(value)) fail("evolution_journal_conflict");
    const stable = freezeJson(value); this.records.set(value.operationId, stable); return stable;
  }
}
function inputDigest(context: EvolutionStageContext, stage: EvolutionStage): string {
  const { attempt, campaign } = context;
  const index = ["evidence", "generate", "candidate", "evaluate", "feedback", "publish"].indexOf(stage);
  return digest({ spec: campaign.specDigest, attempt: attempt.id, operation: context.operationId, stage,
    inputs: campaign.inputs ?? [], prior: campaign.attempts.filter(item => item.id !== attempt.id).map(item => item.proposal?.id ?? item.id),
    evidence: index > 0 ? attempt.evidence ?? null : null, proposal: index > 1 ? attempt.proposal ?? null : null,
    candidate: index > 2 ? attempt.candidate ?? null : null, verdict: index > 3 ? attempt.verdict ?? null : null,
    review: stage === "publish" ? campaign.review ?? null : null });
}
export function journalEvolutionPorts(ports: EvolutionPorts, journal: EvolutionOperationJournal,
  failureUsage?: (context: EvolutionStageContext, stage: EvolutionStage, error: unknown) => Promise<EvolutionUsage | undefined>): EvolutionPorts {
  const read = async (context: EvolutionStageContext, stage: EvolutionStage) => {
    const row = await journal.read(context.operationId);
    if (row && (row.stage !== stage || row.inputDigest !== inputDigest(context, stage))) fail("evolution_journal_input_mismatch");
    if (row?.failure) return validateStageFailure(row.failure, stage);
    return row?.receipt ? validateReceipt(stage, row.receipt, context.campaign, context.attempt) : undefined;
  };
  const call = async (context: EvolutionStageContext, stage: EvolutionStage, invoke: () => Promise<EvolutionStageReceipt>) => {
    const existing = await read(context, stage);
    if (existing) { if ("kind" in existing && existing.kind === "stage-failure") throw new EvolutionStageError(existing); return existing as EvolutionStageReceipt; }
    try {
      const receipt = validateReceipt(stage, await invoke(), context.campaign, context.attempt);
      await journal.put({ operationId: context.operationId, inputDigest: inputDigest(context, stage), stage, receipt });
      return receipt;
    } catch (error) {
      if (context.signal.aborted || stage === "publish") throw error;
      const measured = await failureUsage?.(context, stage, error);
      if (!measured) throw error;
      const failure = validateStageFailure({ authority: "host", kind: "stage-failure", stage, usage: measured,
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 4000) || "evolution_stage_failed" }, stage);
      await journal.put({ operationId: context.operationId, inputDigest: inputDigest(context, stage), stage, failure });
      throw new EvolutionStageError(failure);
    }
  };
  return {
    evidence: context => call(context, "evidence", () => ports.evidence(context)) as ReturnType<EvolutionPorts["evidence"]>,
    generate: context => call(context, "generate", () => ports.generate(context)) as ReturnType<EvolutionPorts["generate"]>,
    candidate: context => call(context, "candidate", () => ports.candidate(context)) as ReturnType<EvolutionPorts["candidate"]>,
    feedback: context => call(context, "feedback", () => ports.feedback(context)) as ReturnType<EvolutionPorts["feedback"]>,
    ...(ports.evaluate ? { evaluate: (context: EvolutionStageContext) => call(context, "evaluate", () => ports.evaluate!(context)) as ReturnType<NonNullable<EvolutionPorts["evaluate"]>> } : {}),
    ...(ports.publish ? { publish: (context: EvolutionStageContext, approved: string) => call(context, "publish", () => ports.publish!(context, approved)) as ReturnType<NonNullable<EvolutionPorts["publish"]>> } : {}),
    reconcile: async (context, operation) => await read(context, operation.stage) ?? await ports.reconcile?.(context, operation),
    ...(ports.cleanup ? { cleanup: ports.cleanup } : {}),
  };
}
