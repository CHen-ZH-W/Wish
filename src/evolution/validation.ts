import { canonical, digest, freezeJson } from "../agent-profiles/validation.js";
import { source, review } from "../candidates/validation.js";
import type { EvolutionAttempt, EvolutionCampaign, EvolutionCampaignSpec, EvolutionStage, EvolutionStageReceipt, EvolutionStageFailure, EvolutionUsage } from "./types.js";
import { validateExperience } from "./experience.js";
import { validateStrategyGene } from "./strategy.js";

export { canonical, digest };
export class EvolutionError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "EvolutionError"; }
}
export class EvolutionStageError extends EvolutionError {
  constructor(readonly failure: EvolutionStageFailure) { super("evolution_stage_failed", failure.reason); }
}
export function validateStageFailure(value: unknown, stage: EvolutionStage): EvolutionStageFailure {
  const item = object(value);
  if (Object.keys(item).some(key => !["authority", "kind", "stage", "reason", "usage"].includes(key)) || item.authority !== "host" || item.kind !== "stage-failure" || item.stage !== stage || text(item.reason).length > 4000 || stage === "publish") fail("evolution_failure_receipt_invalid");
  usage(item.usage);
  return freezeJson(item) as unknown as EvolutionStageFailure;
}
export function fail(code: string): never { throw new EvolutionError(code); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("evolution_invalid_object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) fail("evolution_invalid_text");
  return value;
}
export function sha(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) fail("evolution_invalid_digest"); return result; }
function number(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail("evolution_invalid_number");
  return value;
}
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value) || value.length > 10_000) fail("evolution_invalid_array"); return value; }
function strings(value: unknown): void { for (const item of array(value)) text(item); }
function oneOf(value: unknown, values: readonly string[]): string { const result = text(value); if (!values.includes(result)) fail("evolution_invalid_enum"); return result; }
const targets = ["skill", "prompt", "workflow", "tool", "plugin", "kernel"];
const states = ["waiting-input", "running", "awaiting-external-validation", "awaiting-review", "completed", "paused", "cancelled", "failed", "interrupted", "reconciliation-required"];
const stages = ["evidence", "generate", "candidate", "evaluate", "feedback", "publish"];
export function usage(value: unknown): EvolutionUsage {
  const item = object(value); const costs = object(item.costByCurrency);
  for (const [currency, cost] of Object.entries(costs)) { if (!/^[A-Z]{3}$/.test(currency)) fail("evolution_invalid_currency"); if (cost !== null) number(cost); }
  if (typeof item.complete !== "boolean") fail("evolution_incomplete_usage");
  return { modelCalls: number(item.modelCalls, true), tokens: number(item.tokens, true), costByCurrency: costs as Record<string, number | null>, complete: item.complete };
}
export function validateSpec(value: unknown): EvolutionCampaignSpec {
  const item = object(value); text(item.objective); sha(item.baselineSnapshotDigest);
  for (const key of Object.keys(item)) if (!["objective", "baselineSnapshotDigest", "datasetDigest", "evaluationMode", "context", "allowedTargets", "budget", "maxRounds", "patience"].includes(key)) fail("evolution_invalid_spec_key");
  if (item.datasetDigest !== undefined) sha(item.datasetDigest);
  if (item.evaluationMode !== undefined) oneOf(item.evaluationMode, ["deferred", "external"]);
  if (item.evaluationMode === "external" && item.datasetDigest === undefined) fail("evolution_external_dataset_required");
  if (item.context !== undefined) {
    const context = object(item.context);
    for (const [key, value] of Object.entries(context)) {
      if (!["sessionId", "workspaceRoot", "traceIds", "hypothesis", "parentId", "entryId", "generatorId", "generatorSnapshotDigest"].includes(key)) fail("evolution_invalid_context_key");
      if (key === "traceIds") { strings(value); if (array(value).length > 100) fail("evolution_context_limit"); }
      else if (text(value).length > (key === "hypothesis" ? 12_000 : 4_096)) fail("evolution_context_limit");
      if (key === "generatorSnapshotDigest") sha(value);
    }
  }
  const allowed = array(item.allowedTargets); if (!allowed.length || new Set(allowed).size !== allowed.length) fail("evolution_invalid_targets");
  for (const target of allowed) oneOf(target, targets);
  const budget = object(item.budget); number(budget.modelCalls, true); number(budget.tokens, true);
  const costs = object(budget.costByCurrency); for (const [currency, cost] of Object.entries(costs)) { if (!/^[A-Z]{3}$/.test(currency)) fail("evolution_invalid_currency"); number(cost); }
  if (!number(budget.timeoutMs, true) || number(budget.timeoutMs) > 86_400_000) fail("evolution_invalid_timeout");
  if (!number(item.maxRounds, true) || number(item.maxRounds) > 1_000 || !number(item.patience, true) || number(item.patience) > number(item.maxRounds)) fail("evolution_invalid_rounds");
  return freezeJson({ ...item, evaluationMode: item.evaluationMode ?? "deferred" }) as unknown as EvolutionCampaignSpec;
}
export function validateReceipt(stage: EvolutionStage, value: unknown, campaign: EvolutionCampaign, attempt: EvolutionAttempt): EvolutionStageReceipt {
  const item = object(value); if (stage !== "publish") { if (item.usage === undefined) fail("evolution_usage_missing"); usage(item.usage); }
  if (stage === "evidence") {
    const traces = array(item.traces), tickets = array(item.tickets), ids = new Set<string>();
    for (const raw of traces) {
      const trace = object(raw); const id = text(trace.id); if (ids.has(id)) fail("evolution_duplicate_trace"); ids.add(id);
      sha(trace.digest); text(trace.runId); text(trace.terminalStatus); text(trace.capturedAt); text(trace.summary); strings(trace.evidenceRefs);
      oneOf(trace.sourceKind, ["production", "development", "regression", "held-out", "evolution"]);
      if (trace.sourceKind === "held-out") fail("evolution_heldout_evidence_forbidden");
      if (trace.sourceKind === "evolution") fail("evolution_self_evidence_forbidden");
      oneOf(trace.taskOutcome, ["passed", "failed", "unknown"]);
      if (trace.profileSnapshotDigest !== undefined) sha(trace.profileSnapshotDigest);
    }
    const ticketIds = new Set<string>(), traceDigests = new Set(traces.map(raw => object(raw).digest));
    for (const raw of tickets) {
      const ticket = object(raw); const id = text(ticket.id); if (ticketIds.has(id)) fail("evolution_duplicate_ticket"); ticketIds.add(id);
      strings(ticket.traceIds); strings(ticket.traceDigests); strings(ticket.evidenceRefs); text(ticket.summary); text(ticket.problem); text(ticket.hypothesis);
      const selectedIds = array(ticket.traceIds), selectedDigests = array(ticket.traceDigests);
      if (new Set(selectedIds).size !== selectedIds.length || new Set(selectedDigests).size !== selectedDigests.length || selectedIds.length !== selectedDigests.length || selectedIds.some(id => !ids.has(String(id))) || selectedDigests.some(id => !traceDigests.has(id))) fail("evolution_ticket_evidence_missing");
      const selected = traces.map(object).filter(trace => selectedIds.includes(trace.id));
      if (selected.some(trace => !selectedDigests.includes(trace.digest))) fail("evolution_ticket_trace_digest_mismatch");
      const selectedRefs = new Set(selected.flatMap(trace => array(trace.evidenceRefs)));
      const refs = array(ticket.evidenceRefs);
      if (refs.some(ref => !selectedRefs.has(ref)) || selected.some(trace => array(trace.evidenceRefs).length && !array(trace.evidenceRefs).some(ref => refs.includes(ref)))) fail("evolution_ticket_reference_mismatch");
      oneOf(ticket.failureCategory, ["environment", "authorization", "project", "harness", "unknown"]);
      if (ticket.pattern !== undefined) oneOf(ticket.pattern, ["failure", "repeated-tool", "high-token-use", "high-cost"]);
      if (ticket.alternatives !== undefined) strings(ticket.alternatives);
      if (!campaign.spec.allowedTargets.includes(oneOf(ticket.target, targets) as never) || number(ticket.confidence) > 1) fail("evolution_ticket_target_or_confidence");
    }
    const experiences = item.experiences === undefined ? [] : array(item.experiences).map(validateExperience);
    if (experiences.length > 8 || experiences.some(entry => entry.scope !== campaign.spec.context?.workspaceRoot)) fail("evolution_experience_scope_mismatch");
    const strategies = item.strategies === undefined ? [] : array(item.strategies).map(validateStrategyGene);
    if (strategies.length > 3 || strategies.some(gene => gene.scope !== campaign.spec.context?.workspaceRoot || gene.experienceDigests.some(key => !experiences.some(entry => entry.digest === key)))) fail("evolution_gene_provenance_missing");
  } else if (stage === "generate") {
    for (const key of Object.keys(item)) if (!["id", "ticketIds", "target", "rationale", "source", "usage", "generation"].includes(key)) fail("evolution_untrusted_host_output");
    text(item.id); text(item.rationale); strings(item.ticketIds); source(item.source);
    if (!campaign.spec.allowedTargets.includes(oneOf(item.target, targets) as never)) fail("evolution_target_not_allowed");
    if (!array(item.ticketIds).length || array(item.ticketIds).some(id => !attempt.evidence?.tickets.some(ticket => ticket.id === id))) fail("evolution_proposal_ticket_missing");
    if (item.generation !== undefined) {
      const receipt = object(item.generation); sha(receipt.snapshotDigest); sha(receipt.trajectoryDigest); text(receipt.sessionId); text(receipt.runId);
      if (receipt.engine !== "runtime" || receipt.snapshotDigest !== campaign.spec.context?.generatorSnapshotDigest) fail("evolution_generator_identity_mismatch");
    }
  } else if (stage === "candidate") {
    sha(item.candidateDigest); text(item.validationId); sha(item.artifactDigest); sha(item.snapshotDigest);
    if (!attempt.proposal || digest(attempt.proposal.source) !== item.candidateDigest) fail("evolution_candidate_identity_mismatch");
  } else if (stage === "evaluate") {
    if (item.authority !== "host" || item.datasetDigest !== campaign.spec.datasetDigest || item.candidateDigest !== attempt.candidate?.candidateDigest) fail("evolution_verdict_identity_mismatch");
    text(item.experimentId); text(item.reason); sha(item.evidenceDigest); number(item.baselineScore); number(item.candidateScore);
    oneOf(item.decision, ["accepted", "rejected", "inconclusive"]);
    if (item.review !== undefined) {
      const checked = review(item.review);
      if (checked.candidateDigest !== attempt.candidate?.candidateDigest || checked.artifactDigest !== attempt.candidate?.artifactDigest || checked.snapshotDigest !== attempt.candidate?.snapshotDigest || checked.validationId !== attempt.candidate?.validationId) fail("evolution_review_identity_mismatch");
    }
    if (item.decision === "accepted" && item.review === undefined) fail("evolution_review_required");
  } else if (stage === "feedback") {
    text(item.id); text(item.summary); strings(item.evidenceRefs);
  } else {
    if (item.authority !== "host" || item.approvedDigest !== campaign.review?.digest) fail("evolution_approval_digest_mismatch");
    text(item.promotionId); oneOf(item.status, ["active", "rejected", "recovery-required", "interrupted"]);
  }
  return freezeJson(item) as unknown as EvolutionStageReceipt;
}
export function validateCampaign(value: unknown): EvolutionCampaign {
  const item = object(value); if (item.schemaVersion !== 1) fail("evolution_invalid_schema");
  text(item.id); text(item.requestId); sha(item.specDigest); const spec = validateSpec(item.spec);
  if (digest(spec) !== item.specDigest) fail("evolution_spec_digest_mismatch");
  if (!number(item.revision, true)) fail("evolution_invalid_revision"); oneOf(item.state, states);
  text(item.createdAt); text(item.updatedAt); number(item.elapsedMs); usage(item.usage); number(item.nonImprovingRounds, true);
  const attempts = array(item.attempts); if (attempts.length > spec.maxRounds) fail("evolution_round_limit");
  const campaign = item as unknown as EvolutionCampaign;
  for (const [index, raw] of attempts.entries()) {
    const attempt = object(raw); text(attempt.id); number(attempt.round, true); text(attempt.startedAt);
    if (attempt.round !== index + 1 || attempt.id !== `${campaign.id}-round-${index + 1}`) fail("evolution_attempt_identity_mismatch");
    const ids = new Set<string>();
    for (const rawOperation of array(attempt.operations)) {
      const operation = object(rawOperation); const id = text(operation.id); if (ids.has(id)) fail("evolution_duplicate_operation"); ids.add(id);
      oneOf(operation.stage, stages); oneOf(operation.status, ["pending", "completed", "failed"]); text(operation.startedAt);
      if (operation.id !== `${attempt.id}-${operation.stage}`) fail("evolution_operation_identity_mismatch");
      if (operation.status === "completed" && operation.receipt === undefined) fail("evolution_receipt_missing");
      if (operation.status === "failed") {
        validateStageFailure(operation.failure, operation.stage as EvolutionStage);
        if (!operation.endedAt || operation.receipt !== undefined) fail("evolution_failure_receipt_invalid");
      } else if (operation.failure !== undefined) fail("evolution_failure_receipt_invalid");
      if (operation.status === "completed") {
        const checked = validateReceipt(operation.stage as EvolutionStage, operation.receipt, campaign, raw as EvolutionAttempt);
        const field = operation.stage === "generate" ? "proposal" : operation.stage === "evaluate" ? "verdict" : operation.stage;
        if (field !== "publish" && canonical(attempt[String(field)]) !== canonical(checked)) fail("evolution_stage_receipt_mismatch");
      }
    }
    if (attempt.contentDigest !== undefined) sha(attempt.contentDigest);
    if (attempt.parentAttemptId !== undefined && (index === 0 || attempt.parentAttemptId !== object(attempts[index - 1]).id)) fail("evolution_lineage_invalid");
    if (attempt.duplicateOf !== undefined && !attempts.slice(0, index).some(raw => object(raw).id === attempt.duplicateOf && object(raw).contentDigest === attempt.contentDigest)) fail("evolution_duplicate_identity_mismatch");
  }
  if (item.inputs !== undefined) for (const raw of array(item.inputs)) {
    const input = object(raw); text(input.requestId); if (text(input.feedback).length > 12_000) fail("evolution_input_limit"); strings(input.traceIds); text(input.createdAt);
  }
  if (item.review !== undefined) {
    const checked = review(item.review);
    if (!campaign.attempts.some(attempt => attempt.verdict?.decision === "accepted" && attempt.verdict.review?.digest === checked.digest)) fail("evolution_review_receipt_missing");
  }
  if (item.state === "awaiting-review" && (!campaign.review || campaign.attempts.at(-1)?.verdict?.decision !== "accepted")) fail("evolution_host_review_required");
  if (item.state === "awaiting-external-validation" && (!campaign.attempts.at(-1)?.candidate || !campaign.attempts.at(-1)?.feedback)) fail("evolution_technical_receipt_missing");
  if (item.publication !== undefined) {
    const receipt = campaign.attempts.at(-1)?.operations.find(operation => operation.stage === "publish" && operation.status === "completed")?.receipt;
    if (!receipt || canonical(receipt) !== canonical(item.publication)) fail("evolution_publication_receipt_missing");
  }
  return freezeJson(item) as unknown as EvolutionCampaign;
}
