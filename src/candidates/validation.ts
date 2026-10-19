import { parseWishPluginManifest, assertWishPluginConfig } from "../boot/plugin-control/manifest.js";
import { qualityGate } from "../plugin-admission/quality.js";
import { AgentProfileError, canonical, digest, exact, freezeJson, identifier, record, validateDefinition } from "../agent-profiles/validation.js";
import { validateProcessOwner } from "../agent-profiles/process-owner.js";
import type { CandidateSource, CandidateArtifact, CandidateValidation, CandidateEvaluation, CandidatePromotion, CandidateReview } from "./types.js";

export class CandidateError extends AgentProfileError {}
export function fail(code: string): never { throw new CandidateError(code); }
export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("candidate_digest_invalid");
  return value;
}
export function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail("candidate_text_invalid");
  return value;
}
export function path(value: unknown): string {
  const name = text(value, 240);
  if (!/^[a-zA-Z0-9_./-]+$/u.test(name) || name.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".") || part === "node_modules") || name.startsWith("/") || name === "package.json" || name === "package-lock.json") fail("candidate_path_invalid");
  return name;
}
export function fileMap(value: unknown): Readonly<Record<string, string>> {
  const input = record(value); const names = Object.keys(input);
  if (!names.length || names.length > 128) fail("candidate_file_limit");
  for (const name of names) { path(name); if (typeof input[name] !== "string" || String(input[name]).length > 512 * 1024) fail("candidate_file_limit"); }
  for (const name of names) if (names.some(other => other.startsWith(`${name}/`))) fail("candidate_path_collision");
  if (Buffer.byteLength(canonical(input)) > 4 * 1024 * 1024) fail("candidate_file_limit");
  return freezeJson(input) as Readonly<Record<string, string>>;
}
export function source(value: unknown): CandidateSource {
  const input = record(value);
  exact(input, ["schemaVersion", "id", "version", "entry", "files", "tests", "manifest", "config", "provenance"]);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.version) || Number(input.version) < 1) fail("candidate_source_invalid");
  identifier(input.id);
  const files = fileMap(input.files), entry = path(input.entry);
  if (!Object.hasOwn(files, entry) || !/\.[cm]?[jt]s$/u.test(entry)) fail("candidate_entry_missing");
  if (!Array.isArray(input.tests) || input.tests.length < 1 || input.tests.length > 16) fail("candidate_tests_required");
  const tests = input.tests.map(path);
  if (new Set(tests).size !== tests.length || tests.some(name => !Object.hasOwn(files, name) || !/\.[cm]?[jt]s$/u.test(name))) fail("candidate_test_invalid");
  const manifest = parseWishPluginManifest(input.manifest);
  if (manifest.entry !== "./plugin.mjs" || manifest.id !== input.id) fail("candidate_manifest_identity_mismatch");
  const config = record(input.config); assertWishPluginConfig(manifest.configSchema, config);
  const provenance = record(input.provenance); exact(provenance, ["author", "purpose", "sessionId", "runId"]);
  text(provenance.author, 128); text(provenance.purpose, 4000);
  if (provenance.sessionId !== undefined) identifier(provenance.sessionId);
  if (provenance.runId !== undefined) identifier(provenance.runId);
  return freezeJson({ ...input, files, entry, tests, manifest, config, provenance }) as unknown as CandidateSource;
}
export function target(value: unknown): CandidateValidation["target"] {
  const input = record(value); exact(input, ["parentId", "entryId"]);
  for (const name of [input.parentId, input.entryId]) if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(name)) fail("candidate_target_invalid");
  return freezeJson(input) as unknown as CandidateValidation["target"];
}
export function artifact(value: unknown): CandidateArtifact {
  const input = record(value); exact(input, ["schemaVersion", "digest", "sourceDigest", "files", "hostCode", "imports"]);
  sha(input.digest); sha(input.sourceDigest); fileMap(input.files);
  if (input.schemaVersion !== 1 || !Array.isArray(input.hostCode) || !input.hostCode.length || !Array.isArray(input.imports) || input.imports.some(item => typeof item !== "string")) fail("candidate_artifact_invalid");
  for (const raw of input.hostCode) { const file = record(raw); text(file.path, 4096); sha(file.sha256); }
  const { digest: _, ...body } = input;
  if (digest(body) !== input.digest) fail("candidate_artifact_digest_mismatch");
  if (typeof record(input.files)["plugin.mjs"] !== "string") fail("candidate_artifact_invalid");
  return freezeJson(input) as unknown as CandidateArtifact;
}
export function validation(value: unknown): CandidateValidation {
  const input = record(value); identifier(input.id); sha(input.candidateDigest); sha(input.baseSnapshotDigest); validateProcessOwner(input.owner); target(input.target); validateDefinition(input.profile);
  if (input.schemaVersion !== 1 || !["running", "passed", "failed", "cancelled", "interrupted"].includes(String(input.status))) fail("candidate_validation_invalid");
  if (input.status === "passed") { sha(input.artifactDigest); sha(input.snapshotDigest); }
  if (input.admissionDigest !== undefined) sha(input.admissionDigest);
  if (input.checks !== undefined) candidateChecks(input.checks);
  return freezeJson(input) as unknown as CandidateValidation;
}
export function candidateChecks(value: unknown): import("./types.js").CandidateChecks {
  const input = record(value), names = ["typecheck", "build", "activation", "interfaces", "ownership", "unload"];
  exact(input, [...names, "tests"]);
  const tests = record(input.tests); exact(tests, ["passed", "failed"]);
  if (names.some(name => input[name] !== "passed") || !Number.isSafeInteger(tests.passed) || Number(tests.passed) < 1 || Number(tests.passed) > 1_000_000 || tests.failed !== 0) fail("candidate_checks_invalid");
  return freezeJson(input) as unknown as import("./types.js").CandidateChecks;
}
export function evaluation(value: unknown): CandidateEvaluation {
  const input = record(value); identifier(input.id); identifier(input.validationId); identifier(input.experimentId); sha(input.datasetDigest);
  qualityGate(input.gate);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.repetitions) || Number(input.repetitions) < 1) fail("candidate_evaluation_invalid");
  return freezeJson(input) as unknown as CandidateEvaluation;
}
export function review(value: unknown): CandidateReview {
  const input = record(value); exact(input, ["schemaVersion", "digest", "validationId", "evaluationId", "artifactDigest", "candidateDigest", "snapshotDigest", "evidenceDigest", "deploymentDigest", "managementRevision", "overlayDigest", "previousOverlay", "target", "previousEntry", "reviewer", "reason", "trust", "admissionDigest"]);
  if (input.admissionDigest !== undefined) sha(input.admissionDigest);
  for (const key of ["digest", "artifactDigest", "candidateDigest", "snapshotDigest", "evidenceDigest", "deploymentDigest", "overlayDigest"]) sha(input[key]);
  identifier(input.validationId); identifier(input.evaluationId); text(input.managementRevision); text(input.reviewer, 128); text(input.reason, 4000); target(input.target);
  if (input.schemaVersion !== 1 || input.trust !== "trusted-in-process" || !Array.isArray(input.previousOverlay) || (input.previousEntry !== null && typeof input.previousEntry !== "object")) fail("candidate_review_invalid");
  const { digest: _, ...body } = input; if (digest(body) !== input.digest) fail("candidate_review_changed");
  return freezeJson(input) as unknown as CandidateReview;
}
export function promotion(value: unknown): CandidatePromotion {
  const input = record(value); identifier(input.id); review(input.review); validateProcessOwner(input.owner);
  if (input.schemaVersion !== 1 || !["applying", "active", "rejected", "recovery-required", "rolling-back", "rolled-back", "interrupted"].includes(String(input.status))) fail("candidate_promotion_invalid");
  return freezeJson(input) as unknown as CandidatePromotion;
}
