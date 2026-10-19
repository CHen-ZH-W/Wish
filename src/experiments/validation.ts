import { isAbsolute } from "node:path";
import { AgentProfileError, exact, freezeJson, identifier, positive, record, strings } from "../agent-profiles/validation.js";
import type { ExperimentDataset, ExperimentPlan, ExperimentRun } from "./types.js";
import { validateProcessOwner } from "../agent-profiles/process-owner.js";

export function relativeFile(value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) throw new AgentProfileError("experiment_invalid_file");
  return value;
}
export function validateDataset(value: unknown): ExperimentDataset {
  const input = record(value); exact(input, ["schemaVersion", "id", "version", "cases"]);
  if (input.schemaVersion !== 1 || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 256) throw new AgentProfileError("experiment_invalid_dataset");
  identifier(input.id); positive(input.version);
  const ids = new Set<string>(); let bytes = 0;
  for (const value of input.cases) {
    const item = record(value); exact(item, ["id", "prompt", "files", "assertion"]);
    const id = identifier(item.id); if (ids.has(id)) throw new AgentProfileError("experiment_duplicate_case"); ids.add(id);
    if (typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 128_000) throw new AgentProfileError("experiment_invalid_prompt");
    const files = record(item.files);
    for (const [path, text] of Object.entries(files)) { relativeFile(path); if (typeof text !== "string") throw new AgentProfileError("experiment_invalid_file"); bytes += Buffer.byteLength(text); }
    const assertion = record(item.assertion); exact(assertion, ["kind", "expected", "path"]);
    if (!["exact", "contains", "file-equals"].includes(String(assertion.kind)) || typeof assertion.expected !== "string") throw new AgentProfileError("experiment_invalid_assertion");
    if (assertion.kind === "file-equals") relativeFile(assertion.path);
    else if (assertion.path !== undefined) throw new AgentProfileError("experiment_invalid_assertion");
  }
  if (bytes > 16 * 1024 * 1024) throw new AgentProfileError("experiment_dataset_limit");
  return freezeJson(input) as unknown as ExperimentDataset;
}
export function validatePlan(value: unknown): ExperimentPlan {
  const input = record(value); exact(input, ["datasetDigest", "variants", "baseline", "repetitions", "timeoutMs", "maxSteps"]);
  if (!/^[a-f0-9]{64}$/u.test(String(input.datasetDigest)) || !Array.isArray(input.variants) || input.variants.length < 1 || input.variants.length > 16) throw new AgentProfileError("experiment_invalid_plan");
  const labels: string[] = [];
  for (const value of input.variants) {
    const variant = record(value); exact(variant, ["label", "snapshotDigest"]);
    labels.push(identifier(variant.label));
    if (!/^[a-f0-9]{64}$/u.test(String(variant.snapshotDigest))) throw new AgentProfileError("experiment_invalid_snapshot");
  }
  strings(labels); if (!labels.includes(String(input.baseline))) throw new AgentProfileError("experiment_missing_baseline");
  if (positive(input.repetitions) > 100 || positive(input.timeoutMs) > 3_600_000 || positive(input.maxSteps) > 10_000) throw new AgentProfileError("experiment_invalid_limit");
  return freezeJson(input) as unknown as ExperimentPlan;
}
export function validateRun(value: unknown): ExperimentRun {
  const input = record(value);
  if (input.schemaVersion !== 1 || !["running", "completed", "failed", "cancelled", "interrupted"].includes(String(input.status)) || !Array.isArray(input.results) || !Number.isFinite(Date.parse(String(input.startedAt)))) throw new AgentProfileError("experiment_invalid_record");
  identifier(input.id); identifier(input.instanceId); validatePlan(input.plan);
  validateProcessOwner(input.owner);
  return freezeJson(input) as unknown as ExperimentRun;
}
