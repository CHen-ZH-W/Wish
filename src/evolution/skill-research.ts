import { digest, freezeJson } from "../agent-profiles/validation.js";
import { validateSkillPackageSnapshot } from "../skills/local.js";
import type { SkillPackageSnapshot } from "../skills/types.js";
import { mergeSkillPatches, validateSkillChangeProposal, type SkillChangeProposal } from "./skill-proposals.js";
import { validateTrace, type TraceRecord, type TaskOutcomeReceipt, taskOutcomeReceipt } from "./observations.js";
import { sha, text, fail } from "./validation.js";
import { ProfileRecordStore } from "../agent-profiles/store.js";
import type { StorageBackendResolver } from "../storage/backend.js";

export interface SkillResearchResult {
  readonly schemaVersion: 1; readonly id: string; readonly digest: string; readonly baseDigest: string;
  readonly status: "ready" | "conflicted" | "incomplete";
  readonly analyses: readonly { readonly traceId: string; readonly traceDigest: string; readonly proposal?: SkillChangeProposal; readonly error?: string }[];
  readonly merges: readonly SkillChangeProposal[]; readonly result?: SkillChangeProposal;
}
/** Every analyst sees the same immutable base. No sequential drift and no implicit conflict resolution. */
export async function researchSkill(input: {
  readonly id: string; readonly base: SkillPackageSnapshot; readonly expectedBaseDigest: string;
  readonly traces: readonly TraceRecord[]; readonly concurrency?: number; readonly signal: AbortSignal;
  readonly analyze: (context: { readonly base: SkillPackageSnapshot; readonly trace: TraceRecord; readonly signal: AbortSignal }) => Promise<SkillChangeProposal>;
  readonly onAnalysis?: (receipt: SkillResearchResult["analyses"][number]) => Promise<void>;
}): Promise<SkillResearchResult> {
  const base = validateSkillPackageSnapshot(input.base), concurrency = input.concurrency ?? 1;
  if (base.digest !== input.expectedBaseDigest || !/^[a-zA-Z0-9_.-]{1,80}$/u.test(input.id) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 || !input.traces.length || input.traces.length > 32) fail("evolution_skill_research_invalid");
  const traces = input.traces.map(validateTrace).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(traces.map(trace => trace.id)).size !== traces.length || traces.some(trace => ["held-out", "evolution"].includes(trace.sourceKind))) fail("evolution_skill_research_evidence_forbidden");
  const analyses: SkillResearchResult["analyses"][number][] = new Array(traces.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, traces.length) }, async () => {
    for (;;) {
      input.signal.throwIfAborted(); const index = next++; if (index >= traces.length) return;
      const trace = traces[index]!;
      let receipt: SkillResearchResult["analyses"][number];
      try {
        const proposal = validateSkillChangeProposal(await input.analyze({ base, trace, signal: input.signal })); input.signal.throwIfAborted();
        if (proposal.kind !== "patch" || proposal.bases.length !== 1 || proposal.bases[0]!.digest !== base.digest) fail("evolution_skill_research_base_changed");
        receipt = { traceId: trace.id, traceDigest: trace.digest, proposal };
      } catch (error) {
        input.signal.throwIfAborted(); receipt = { traceId: trace.id, traceDigest: trace.digest, error: (error instanceof Error ? error.message : String(error)).slice(0, 4000) };
      }
      analyses[index] = freezeJson(receipt); await input.onAnalysis?.(analyses[index]!);
    }
  }));
  const rejected = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected");
  if (rejected) throw rejected.reason;
  const merges: SkillChangeProposal[] = [];
  let level = analyses.flatMap(item => item.proposal ? [item.proposal] : []), depth = 0;
  let status: SkillResearchResult["status"] = analyses.some(item => item.error) ? "incomplete" : "ready";
  while (level.length > 1 && status === "ready") {
    const merged: SkillChangeProposal[] = [];
    for (let offset = 0; offset < level.length; offset += 8) {
      const proposal = mergeSkillPatches({ id: `${input.id}-merge-${depth}-${offset / 8}`, version: 1, reason: "Consolidate independent proposals against one frozen Skill base.",
        base, expectedBaseDigest: base.digest, proposals: level.slice(offset, offset + 8) });
      merges.push(proposal); merged.push(proposal);
      if (proposal.status === "conflicted") status = "conflicted";
    }
    level = merged; depth++;
  }
  const body = { schemaVersion: 1 as const, id: input.id, baseDigest: base.digest, status, analyses, merges,
    ...(status === "ready" && level[0] ? { result: level[0] } : {}) };
  return freezeJson({ ...body, digest: digest(body) });
}

export interface SkillUsageReceipt {
  readonly operationId: string; readonly packageDigest: string; readonly runId: string; readonly taskId: string;
  readonly kind: "read" | "invoke" | "execute" | "verification"; readonly evidenceRef: string;
  readonly verification?: TaskOutcomeReceipt;
}
function validateUsage(value: unknown): SkillUsageReceipt {
  const row = value as SkillUsageReceipt;
  text(row?.operationId); sha(row.packageDigest); text(row.runId); text(row.taskId); text(row.evidenceRef);
  if (!["read", "invoke", "execute", "verification"].includes(row.kind) || (row.kind === "verification") !== (row.verification !== undefined)) fail("evolution_skill_usage_invalid");
  if (row.verification) { const checked = taskOutcomeReceipt(row.verification); if (checked.runId !== row.runId || checked.taskId !== row.taskId || ["held-out", "evolution"].includes(checked.sourceKind)) fail("evolution_skill_usage_provenance_invalid"); }
  return freezeJson(row);
}
export function skillUsageSummary(receipts: readonly SkillUsageReceipt[]) {
  const unique = new Map<string, SkillUsageReceipt>();
  for (const raw of receipts) { const row = validateUsage(raw), old = unique.get(row.operationId); if (old && digest(old) !== digest(row)) fail("evolution_skill_usage_identity_conflict"); unique.set(row.operationId, row); }
  const rows = [...unique.values()];
  const count = (kind: SkillUsageReceipt["kind"]) => rows.filter(row => row.kind === kind).length;
  const executed = new Set(rows.filter(row => row.kind === "execute").map(row => `${row.packageDigest}:${row.runId}:${row.taskId}`));
  return { reads: count("read"), invocations: count("invoke"), executions: count("execute"),
    verifiedSuccessTasks: new Set(rows.filter(row => row.kind === "verification" && row.verification?.result === "passed" && executed.has(`${row.packageDigest}:${row.runId}:${row.taskId}`)).map(row => `${row.packageDigest}:${row.taskId}`)).size,
    verifiedFailureTasks: new Set(rows.filter(row => row.kind === "verification" && row.verification?.result === "failed" && executed.has(`${row.packageDigest}:${row.runId}:${row.taskId}`)).map(row => `${row.packageDigest}:${row.taskId}`)).size };
}
export class SkillUsageLedger {
  private readonly rows: ProfileRecordStore<SkillUsageReceipt>;
  constructor(storage: StorageBackendResolver, backendId: string) { this.rows = new ProfileRecordStore(storage, backendId, "evolution/skill-usage/v1", validateUsage); }
  record(value: SkillUsageReceipt) { const row = validateUsage(value); return this.rows.create(row.operationId, row); }
  async list(packageDigest?: string) { return (await this.rows.list()).filter(row => !packageDigest || row.packageDigest === packageDigest); }
  async summary(packageDigest?: string) { return skillUsageSummary(await this.list(packageDigest)); }
}
