import type { AgentProfiles } from "../../agent-profiles/service.js";
import type { AgentProfileDefinition } from "../../agent-profiles/types.js";
import { digest, freezeJson, validateDefinition } from "../../agent-profiles/validation.js";
import type { Candidates } from "../../candidates/service.js";
import type { CandidatePromotion, CandidateReview, CandidateValidation } from "../../candidates/types.js";
import { review as validateReview, source as validateSource, target as validateTarget } from "../../candidates/validation.js";
import { LOCAL_USAGE } from "../generator.js";
import { EvolutionError, fail } from "../validation.js";
import type {
  EvolutionCandidateReceipt, EvolutionFeedback, EvolutionPorts,
  EvolutionPublicationReceipt, EvolutionStageContext,
} from "../types.js";
import { assertEvolutionTargetSource, toolTargetNames } from "./targets.js";

export interface CandidateEvolutionOptions {
  readonly candidates: Pick<Candidates, "submit" | "validate" | "history" | "verifySnapshot" | "promote" | "reconcile">;
  readonly agentProfiles: Pick<AgentProfiles, "get">;
  readonly evidence: EvolutionPorts["evidence"];
  readonly generate: EvolutionPorts["generate"];
  readonly feedback?: EvolutionPorts["feedback"];
  /** Explicit Host integration only. Deferred campaigns do not call this port. */
  readonly evaluate?: EvolutionPorts["evaluate"];
}

/** Reuses the existing technical admission and approved Root deployment pipeline unchanged. */
export function createCandidateEvolutionPorts(options: CandidateEvolutionOptions): EvolutionPorts {
  const candidate: EvolutionPorts["candidate"] = async context => {
    context.signal.throwIfAborted();
    const proposal = requireProposal(context);
    const submission = await options.candidates.submit(proposal.source);
    if (submission.digest !== digest(proposal.source)) fail("evolution_candidate_identity_mismatch");
    context.signal.throwIfAborted();
    const recipe = await validationInput(options, context);
    const checked = await options.candidates.validate({ ...recipe, candidateDigest: submission.digest }, context.signal);
    return candidateReceipt(checked);
  };

  const publish: NonNullable<EvolutionPorts["publish"]> = async (context, approvedDigest) => {
    context.signal.throwIfAborted();
    const review = publicationReview(context, approvedDigest);
    // Candidates rechecks evaluation, artifact bytes, approval and Root revisions itself.
    return publicationReceipt(await options.candidates.promote(review, approvedDigest, context.signal));
  };

  return {
    evidence: options.evidence,
    generate: options.generate,
    candidate,
    ...(options.evaluate ? { evaluate: options.evaluate } : {}),
    feedback: options.feedback ?? recordFeedback,
    publish,
    async reconcile(context, operation) {
      context.signal.throwIfAborted();
      if (operation.stage === "candidate") {
        const proposal = requireProposal(context);
        const expected = await validationInput(options, { ...context, operationId: operation.id });
        const history = await options.candidates.history();
        const matches = history.validations.filter(item => item.candidateDigest === digest(proposal.source)
          && item.baseSnapshotDigest === expected.baseSnapshotDigest && digest(item.target) === digest(expected.target)
          && digest(item.profile) === digest(expected.profile));
        // Ambiguous, running, failed or absent outcomes must not cause a new validation.
        if (matches.length !== 1 || matches[0]!.status !== "passed") return undefined;
        const checked = matches[0]!;
        await options.candidates.verifySnapshot(await options.agentProfiles.get(checked.snapshotDigest!));
        return candidateReceipt(checked);
      }
      if (operation.stage === "publish") return reconcilePublication(options, context);
      // Evidence/generation/feedback callbacks may have effects we cannot infer. Never replay.
      return undefined;
    },
  };
}

function requireProposal(context: EvolutionStageContext) {
  const proposal = context.attempt.proposal;
  if (!proposal || !context.campaign.spec.allowedTargets.includes(proposal.target)) fail("evolution_proposal_required");
  validateSource(proposal.source);
  assertEvolutionTargetSource(proposal.target, proposal.source);
  return proposal;
}

async function validationInput(options: CandidateEvolutionOptions, context: EvolutionStageContext): Promise<{
  readonly baseSnapshotDigest: string; readonly target: CandidateValidation["target"]; readonly profile: AgentProfileDefinition;
}> {
  const proposal = requireProposal(context);
  const baseline = await options.agentProfiles.get(context.campaign.spec.baselineSnapshotDigest);
  if (baseline.candidate) fail("evolution_baseline_must_be_stable");
  // Only explicitly declared Tool names extend visibility. Model, policy, Memory,
  // retry, instructions and compaction semantics stay fixed to the baseline.
  const profile = validateDefinition({ ...baseline.definition,
    id: `evolution-${digest({ campaign: context.campaign.id, attempt: context.attempt.id, operation: context.operationId }).slice(0, 32)}`,
    version: context.attempt.round,
    ...(proposal.target === "tool" ? { tools: [...new Set([...baseline.definition.tools, ...toolTargetNames(proposal.source)])] } : {}),
  });
  const hints = context.campaign.spec.context;
  const target = validateTarget({ parentId: hints?.parentId ?? "app", entryId: hints?.entryId ?? `evolved-${digest(proposal.source.id).slice(0, 24)}` });
  return { baseSnapshotDigest: baseline.digest, target, profile };
}

function candidateReceipt(checked: CandidateValidation): EvolutionCandidateReceipt {
  if (checked.status !== "passed" || !checked.artifactDigest || !checked.snapshotDigest) {
    throw new EvolutionError("evolution_candidate_validation_failed", checked.error?.slice(0, 4_000) || "evolution_candidate_validation_failed");
  }
  return freezeJson({ candidateDigest: checked.candidateDigest, validationId: checked.id,
    artifactDigest: checked.artifactDigest, snapshotDigest: checked.snapshotDigest, usage: LOCAL_USAGE });
}

function publicationReview(context: EvolutionStageContext, approvedDigest: string): CandidateReview {
  const candidate = context.attempt.candidate, raw = context.campaign.review;
  if (!raw || !candidate) fail("evolution_review_required");
  const review = validateReview(raw);
  if (review.digest !== approvedDigest || review.candidateDigest !== candidate.candidateDigest
    || review.validationId !== candidate.validationId || review.artifactDigest !== candidate.artifactDigest
    || review.snapshotDigest !== candidate.snapshotDigest) fail("evolution_review_identity_mismatch");
  return review;
}

function publicationReceipt(promotion: CandidatePromotion): EvolutionPublicationReceipt {
  const status = promotion.status;
  if (!["active", "rejected", "recovery-required", "interrupted"].includes(status)) fail("evolution_publication_outcome_unknown");
  return freezeJson({ authority: "host", approvedDigest: promotion.review.digest, promotionId: promotion.id,
    status: status as EvolutionPublicationReceipt["status"] });
}

async function reconcilePublication(options: CandidateEvolutionOptions, context: EvolutionStageContext): Promise<EvolutionPublicationReceipt | undefined> {
  if (!context.campaign.review) return undefined;
  const review = publicationReview(context, context.campaign.review.digest);
  const matches = (await options.candidates.history()).promotions.filter(item => item.review.digest === review.digest);
  if (matches.length !== 1) return undefined;
  const promotion = matches[0]!;
  if (promotion.status === "rolling-back" || promotion.status === "rolled-back") return undefined;
  try {
    // Reconciliation inspects durable Root receipts; it never repeats promote/apply.
    return publicationReceipt(await options.candidates.reconcile(promotion.id));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["candidate_promotion_still_running", "candidate_reconciliation_ambiguous", "candidate_management_recovery_required"].includes(code)) return undefined;
    throw error;
  }
}

async function recordFeedback(context: EvolutionStageContext): Promise<EvolutionFeedback> {
  context.signal.throwIfAborted();
  const candidate = context.attempt.candidate;
  if (!candidate) fail("evolution_candidate_required");
  const verdict = context.attempt.verdict;
  return freezeJson({ id: `feedback-${digest({ attempt: context.attempt.id, candidate: candidate.candidateDigest, verdict: verdict?.evidenceDigest ?? null })}`,
    summary: verdict
      ? `Host evaluation ${verdict.decision}: ${verdict.reason}`
      : "Candidate passed technical admission. This adapter has not requested or run effect evaluation. External validation and the existing approved CandidateReview are still required for formal publication.",
    evidenceRefs: [`candidate:${candidate.candidateDigest}`, `validation:${candidate.validationId}`, `artifact:${candidate.artifactDigest}`,
      ...(verdict ? [`evaluation:${verdict.experimentId}:${verdict.evidenceDigest}`] : [])],
    usage: LOCAL_USAGE,
  });
}
