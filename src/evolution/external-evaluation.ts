import { digest, exact, freezeJson, identifier, record } from "../agent-profiles/validation.js";
import { fail, sha, text } from "./validation.js";

/** A portable request for a future evaluator. Creating it starts no work or network call. */
export interface EvaluationRequest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly digest: string;
  readonly campaignId: string;
  readonly attemptId: string;
  readonly baselineSnapshotDigest: string;
  readonly candidateDigest: string;
  readonly validationId: string;
  readonly artifactDigest: string;
  readonly snapshotDigest: string;
  readonly datasetDigest?: string;
  readonly requestedAt: string;
}

/** External evidence is transport data. It grants no CandidateReview or publication authority. */
export interface EvaluationReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly evaluator: { readonly id: string; readonly version: string };
  readonly completedAt: string;
  /** The external check's outcome, never a claim that the candidate improved over baseline. */
  readonly outcome: "passed" | "failed" | "inconclusive";
  readonly evidenceDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly summary: string;
}

export type EvaluationStatus =
  | { readonly status: "not-requested" }
  | { readonly status: "waiting-external"; readonly request: EvaluationRequest }
  | { readonly status: "completed"; readonly request: EvaluationRequest; readonly receipt: EvaluationReceipt };

export function createEvaluationRequest(value: Omit<EvaluationRequest, "schemaVersion" | "digest">): EvaluationRequest {
  const body = { schemaVersion: 1 as const, ...value };
  return validateEvaluationRequest({ ...body, digest: digest(body) });
}

export function validateEvaluationRequest(value: unknown): EvaluationRequest {
  const input = record(value);
  exact(input, ["schemaVersion", "id", "digest", "campaignId", "attemptId", "baselineSnapshotDigest", "candidateDigest", "validationId", "artifactDigest", "snapshotDigest", "datasetDigest", "requestedAt"]);
  if (input.schemaVersion !== 1) fail("evolution_evaluation_schema_invalid");
  for (const name of ["id", "campaignId", "attemptId", "validationId"]) identifier(input[name]);
  for (const name of ["digest", "baselineSnapshotDigest", "candidateDigest", "artifactDigest", "snapshotDigest"]) sha(input[name]);
  if (input.datasetDigest !== undefined) sha(input.datasetDigest);
  timestamp(input.requestedAt);
  const { digest: claimed, ...body } = input;
  if (digest(body) !== claimed) fail("evolution_evaluation_request_changed");
  return freezeJson(input) as unknown as EvaluationRequest;
}

export function validateEvaluationReceipt(value: unknown, request?: EvaluationRequest): EvaluationReceipt {
  const input = record(value);
  exact(input, ["schemaVersion", "id", "requestId", "requestDigest", "evaluator", "completedAt", "outcome", "evidenceDigest", "evidenceRefs", "summary"]);
  if (input.schemaVersion !== 1) fail("evolution_evaluation_schema_invalid");
  for (const name of ["id", "requestId"]) identifier(input[name]);
  sha(input.requestDigest); sha(input.evidenceDigest); timestamp(input.completedAt); text(input.summary);
  const evaluator = record(input.evaluator); exact(evaluator, ["id", "version"]);
  identifier(evaluator.id); text(evaluator.version);
  if (!["passed", "failed", "inconclusive"].includes(String(input.outcome))) fail("evolution_evaluation_outcome_invalid");
  if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.length > 1_000 || input.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 4_096)) fail("evolution_evaluation_evidence_required");
  if (request) {
    const checked = validateEvaluationRequest(request);
    if (input.requestId !== checked.id || input.requestDigest !== checked.digest) fail("evolution_evaluation_request_mismatch");
    if (Date.parse(String(input.completedAt)) < Date.parse(checked.requestedAt)) fail("evolution_evaluation_time_mismatch");
  }
  return freezeJson(input) as unknown as EvaluationReceipt;
}

/** A completed receipt is separate from acceptance, improvement and formal publication. */
export function evaluationStatus(input: { readonly request?: EvaluationRequest; readonly receipt?: EvaluationReceipt } = {}): EvaluationStatus {
  if (!input.request) {
    if (input.receipt) fail("evolution_evaluation_request_required");
    return Object.freeze({ status: "not-requested" });
  }
  const request = validateEvaluationRequest(input.request);
  return input.receipt
    ? freezeJson({ status: "completed", request, receipt: validateEvaluationReceipt(input.receipt, request) })
    : freezeJson({ status: "waiting-external", request });
}

function timestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("evolution_evaluation_time_invalid");
}
