import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { DevelopmentProject, DevelopmentSpecInput, WorkspaceSnapshot } from "./types.js";

export class DevelopmentError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "DevelopmentError"; }
}
export function requireDevelopment(condition: unknown, code: string, message?: string): asserts condition { if (!condition) throw new DevelopmentError(code, message); }
export function canonical(value: unknown): string {
  const visit = (node: unknown): unknown => {
    if (node === null || typeof node === "string" || typeof node === "boolean") return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (Array.isArray(node)) return node.map(visit);
    requireDevelopment(typeof node === "object" && node !== null, "development_invalid_json");
    return Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, visit(entry)]));
  };
  return JSON.stringify(visit(value));
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function bytesDigest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function freezeJson<T>(value: T): T {
  const copy: T = JSON.parse(canonical(value));
  const freeze = (node: unknown): void => { if (node && typeof node === "object") { Object.values(node).forEach(freeze); Object.freeze(node); } };
  freeze(copy); return copy;
}
export function identifier(value: unknown): string { requireDevelopment(typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/u.test(value), "development_invalid_id"); return value; }
export function text(value: unknown, max = 100_000): string { requireDevelopment(typeof value === "string" && !!value.trim() && value.length <= max, "development_invalid_text"); return value; }
export function integer(value: unknown, min = 0): number { requireDevelopment(Number.isSafeInteger(value) && (value as number) >= min, "development_invalid_integer"); return value as number; }
export function sha(value: unknown): string { requireDevelopment(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "development_invalid_digest"); return value; }
export function timestamp(value: unknown): string { requireDevelopment(typeof value === "string" && Number.isFinite(Date.parse(value)), "development_invalid_time"); return value; }
export function strings(value: unknown, max = 100): readonly string[] { requireDevelopment(Array.isArray(value) && value.length <= max, "development_invalid_list"); value.forEach(entry => text(entry)); return value as readonly string[]; }
export function validateSpec(input: DevelopmentSpecInput): DevelopmentSpecInput {
  requireDevelopment(input && typeof input === "object", "development_invalid_spec");
  requireDevelopment(Object.keys(input).every(key => ["objective", "scope", "outOfScope", "constraints", "criteria", "questions", "assumptions", "decisions", "planMarkdown", "assessment", "artifacts"].includes(key)), "development_invalid_spec_field");
  text(input.objective); text(input.planMarkdown); strings(input.scope); requireDevelopment(input.scope.length > 0, "development_empty_scope");
  for (const list of [input.outOfScope, input.constraints, input.questions, input.assumptions, input.decisions]) strings(list);
  requireDevelopment(Array.isArray(input.criteria) && input.criteria.length > 0 && input.criteria.length <= 100, "development_invalid_criteria");
  const ids = new Set<string>();
  for (const criterion of input.criteria) { identifier(criterion.id); text(criterion.text); requireDevelopment(["technical", "user"].includes(criterion.kind) && !ids.has(criterion.id), "development_invalid_criterion"); ids.add(criterion.id); }
  const assessment = input.assessment;
  requireDevelopment(assessment && [assessment.complexity, assessment.uncertainty, assessment.risk].every(value => ["low", "medium", "high"].includes(value)), "development_invalid_assessment");
  requireDevelopment(["light", "standard", "careful"].includes(assessment.recommendedLevel), "development_invalid_level"); text(assessment.reason);
  requireDevelopment(!(assessment.risk === "high" && assessment.recommendedLevel !== "careful"), "development_risk_requires_careful");
  if (input.artifacts !== undefined) { requireDevelopment(Array.isArray(input.artifacts) && input.artifacts.length <= 100, "development_invalid_artifacts"); for (const ref of input.artifacts) { text(ref.kind, 160); text(ref.id, 160); integer(ref.version, 1); sha(ref.digest); } }
  return freezeJson(input);
}
export function validateWorkspaceSnapshot(code: WorkspaceSnapshot): WorkspaceSnapshot {
  requireDevelopment(code && code.schemaVersion === 1 && isAbsolute(code.workspaceRoot) && normalize(code.workspaceRoot) === code.workspaceRoot, "development_invalid_snapshot");
  sha(code.digest); integer(code.totalBytes); strings(code.excluded, 100);
  requireDevelopment(Array.isArray(code.files) && code.files.length <= 20_000, "development_invalid_snapshot");
  let total = 0; let previous = "";
  for (const file of code.files) { text(file.path, 4096); requireDevelopment(!isAbsolute(file.path) && !file.path.split("/").some((part: string) => !part || part === "." || part === "..") && file.path > previous, "development_invalid_snapshot_path"); previous = file.path; integer(file.bytes); sha(file.digest); total += file.bytes; }
  const { digest: identity, ...content } = code;
  requireDevelopment(total === code.totalBytes && digest(content) === identity, "development_snapshot_digest_mismatch");
  return freezeJson(code);
}
export function validateProject(value: unknown): DevelopmentProject {
  const project = value as DevelopmentProject;
  requireDevelopment(project && project.schemaVersion === 1, "development_invalid_project"); identifier(project.id); text(project.title, 1000); integer(project.revision, 1); timestamp(project.createdAt); timestamp(project.updatedAt);
  requireDevelopment(isAbsolute(project.workspaceRoot) && normalize(project.workspaceRoot) === project.workspaceRoot, "development_invalid_workspace");
  strings(project.sessionIds, 1000).forEach(identifier); requireDevelopment(new Set(project.sessionIds).size === project.sessionIds.length, "development_duplicate_session");
  requireDevelopment(Array.isArray(project.changes) && project.changes.length <= 1000, "development_invalid_changes");
  const changeIds = new Set<string>(), startIds = new Set<string>(), runIds = new Set<string>();
  for (const change of project.changes) {
    identifier(change.id); identifier(change.sessionId); text(change.rawWish); strings(change.wishUpdates); integer(change.executionEpoch); timestamp(change.createdAt); timestamp(change.updatedAt);
    if (change.originRequestId !== undefined) { identifier(change.originRequestId); sha(change.originFingerprint); }
    requireDevelopment(!changeIds.has(change.id), "development_duplicate_change"); changeIds.add(change.id);
    requireDevelopment(["exploring", "ready", "running", "stopping", "paused", "verifying", "review", "accepted", "interrupted"].includes(change.phase) && ["confirmation", "execution", "verification", "user-acceptance", "recovery", "none"].includes(change.gate), "development_invalid_phase");
    requireDevelopment(Array.isArray(change.specs) && Array.isArray(change.confirmations) && Array.isArray(change.starts) && Array.isArray(change.verifications) && Array.isArray(change.reports), "development_invalid_change");
    for (const [index, spec] of change.specs.entries()) { const { version, digest: identity, createdAt, code, ...input } = spec; requireDevelopment(version === index + 1, "development_invalid_spec_version"); timestamp(createdAt); validateSpec(input); validateWorkspaceSnapshot(code); requireDevelopment(code.workspaceRoot === project.workspaceRoot && digest({ ...input, code }) === identity, "development_spec_digest_mismatch"); }
    for (const confirmation of change.confirmations) { identifier(confirmation.id); integer(confirmation.executionEpoch); text(confirmation.actor, 1000); timestamp(confirmation.confirmedAt); validateWorkspaceSnapshot(confirmation.code); const spec = change.specs[confirmation.specVersion - 1]; const { digest: identity, specDigest, specVersion, ...content } = confirmation; requireDevelopment(spec && spec.digest === specDigest && confirmation.code.workspaceRoot === project.workspaceRoot && digest({ ...content, spec }) === identity, "development_confirmation_digest_mismatch"); }
    for (const start of change.starts) { identifier(start.id); identifier(start.runId); identifier(start.sessionId); sha(start.fingerprint); sha(start.confirmationDigest); integer(start.specVersion, 1); integer(start.executionEpoch); timestamp(start.createdAt); if (start.endedAt !== undefined) timestamp(start.endedAt); requireDevelopment(!startIds.has(start.id) && !runIds.has(start.runId) && ["dispatching", "running", "completed", "failed", "aborted", "interrupted"].includes(start.status), "development_invalid_start"); startIds.add(start.id); runIds.add(start.runId); requireDevelopment(change.confirmations.some((item: import("./types.js").DevelopmentConfirmation) => item.digest === start.confirmationDigest && item.executionEpoch === start.executionEpoch && item.specVersion === start.specVersion), "development_start_confirmation_missing"); }
    for (const receipt of change.verifications) { identifier(receipt.id); integer(receipt.specVersion, 1); integer(receipt.executionEpoch); timestamp(receipt.startedAt); timestamp(receipt.endedAt); text(receipt.command, 20_000); sha(receipt.outputDigest); requireDevelopment(typeof receipt.output === "string" && Buffer.byteLength(receipt.output, "utf8") <= 16_384 && typeof receipt.timedOut === "boolean" && (receipt.exitCode === null || Number.isInteger(receipt.exitCode)), "development_invalid_verification"); strings(receipt.criterionIds).forEach(identifier); validateWorkspaceSnapshot(receipt.code); const { digest: identity, ...content } = receipt; requireDevelopment(change.specs[receipt.specVersion - 1]?.digest === receipt.specDigest && receipt.code.workspaceRoot === project.workspaceRoot && digest(content) === identity, "development_verification_digest_mismatch"); }
    for (const report of change.reports) { identifier(report.id); integer(report.specVersion, 1); integer(report.executionEpoch); timestamp(report.createdAt); text(report.summary); strings(report.limitations); strings(report.nextSteps); strings(report.evidenceDigests).forEach(sha); validateWorkspaceSnapshot(report.code); requireDevelopment(Array.isArray(report.criteria), "development_invalid_report"); for (const result of report.criteria) { identifier(result.criterionId); strings(result.evidenceIds).forEach(identifier); requireDevelopment(["verified", "failed", "unverified", "waiting-user"].includes(result.status), "development_invalid_report"); } const { digest: identity, acceptedAt, acceptedBy, ...content } = report; if (acceptedAt !== undefined) { timestamp(acceptedAt); text(acceptedBy); } requireDevelopment(change.specs[report.specVersion - 1]?.digest === report.specDigest && report.code.workspaceRoot === project.workspaceRoot && digest(content) === identity, "development_report_digest_mismatch"); }
  }
  if (project.activeChangeId !== undefined) requireDevelopment(changeIds.has(project.activeChangeId), "development_invalid_active_change");
  return freezeJson(project);
}
