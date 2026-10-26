import type { CandidateSource } from "../candidates/types.js";
import { digest } from "../agent-profiles/validation.js";
import type { EvolutionAttempt, EvolutionCampaign, EvolutionOperation, EvolutionProposal, TaskTrace } from "./types.js";

export type EvolutionProposalView = Omit<EvolutionProposal, "source"> & {
  readonly source: Pick<CandidateSource, "id" | "version">; readonly sourceDigest: string; readonly fileNames: readonly string[];
};
export type EvolutionAttemptView = Omit<EvolutionAttempt, "proposal" | "operations"> & {
  readonly proposal?: EvolutionProposalView; readonly operations: readonly Omit<EvolutionOperation, "receipt">[];
};
export type EvolutionCampaignView = Omit<EvolutionCampaign, "attempts"> & { readonly attempts: readonly EvolutionAttemptView[] };
/** Polling transports state, not source packages and raw transcripts. Detail reads remain bound to exact bytes. */
export function campaignView(campaign: EvolutionCampaign): EvolutionCampaignView {
  return { ...campaign, attempts: campaign.attempts.map(attempt => { const { proposal: _proposal, ...rest } = attempt; return ({ ...rest,
    operations: attempt.operations.map(({ receipt: _receipt, ...operation }) => operation),
    ...(attempt.evidence ? { evidence: { ...attempt.evidence, traces: attempt.evidence.traces.map(trace => {
      const value: TaskTrace = { id: trace.id, digest: trace.digest, sourceKind: trace.sourceKind, runId: trace.runId, terminalStatus: trace.terminalStatus, taskOutcome: trace.taskOutcome,
        evidenceRefs: trace.evidenceRefs, summary: trace.summary, capturedAt: trace.capturedAt, ...(trace.sessionId ? { sessionId: trace.sessionId } : {}), ...(trace.profileSnapshotDigest ? { profileSnapshotDigest: trace.profileSnapshotDigest } : {}) };
      return value;
    }) } } : {}),
    ...(attempt.proposal ? { proposal: { ...attempt.proposal, source: { id: attempt.proposal.source.id, version: attempt.proposal.source.version }, sourceDigest: digest(attempt.proposal.source), fileNames: Object.keys(attempt.proposal.source.files) } } : {}),
  }); }) };
}
export interface EvolutionSourceDetail { readonly sourceDigest: string; readonly source: CandidateSource; readonly previousSource?: CandidateSource }
