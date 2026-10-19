import type { CandidateSource, CandidateValidation } from "../candidates/types.js";
import type { AgentProfileSnapshot } from "../agent-profiles/types.js";
import { digest } from "../agent-profiles/validation.js";
import { TOOL_CAPABILITY_KINDS } from "../permissions/types.js";
import { ADMISSION_POLICY_VERSION, inspectArchitecture, verifyCompiledImports } from "./architecture.js";
import { deny } from "./contracts.js";

/** Deterministic evidence bound to source, target, Agent authority and immutable baseline. */
export function candidateAdmission(source: CandidateSource, validation: Pick<CandidateValidation, "candidateDigest" | "baseSnapshotDigest" | "target" | "profile">, base: AgentProfileSnapshot) {
  const architecture = inspectArchitecture(source);
  const ceiling = new Set(base.permissions.allowedCapabilities ?? TOOL_CAPABILITY_KINDS);
  const selected = new Set(validation.profile.allowedCapabilities ?? base.permissions.allowedCapabilities ?? TOOL_CAPABILITY_KINDS);
  if ([...selected].some(capability => !ceiling.has(capability)) || source.manifest.permissions.capabilities.some(capability => !selected.has(capability))) deny("plugin_admission_agent_capability_mismatch");
  if (validation.profile.permissionProfile === "read-only" && source.manifest.permissions.capabilities.some(capability => !["filesystem.read", "runtime.read", "process.exec"].includes(capability))) deny("plugin_admission_agent_profile_mismatch");
  const body = { policyVersion: ADMISSION_POLICY_VERSION, sourceDigest: validation.candidateDigest, baseSnapshotDigest: validation.baseSnapshotDigest,
    profileDigest: digest(validation.profile), target: validation.target, manifestDigest: digest(source.manifest), architecture };
  return { ...body, digest: digest(body) };
}
export function checkCompiledCandidate(source: CandidateSource, report: ReturnType<typeof candidateAdmission>, files: Readonly<Record<string, string>>): void {
  const allowed = report.architecture.imports.filter(item => report.architecture.runtimeFiles.includes(item.file) && !item.typeOnly && !item.specifier.startsWith("."))
    .map(item => item.specifier.startsWith("node:") ? item.specifier : import.meta.resolve(item.specifier));
  verifyCompiledImports(files["plugin.mjs"] ?? "", allowed);
  let actual: unknown; try { actual = JSON.parse(files["wish-plugin.json"] ?? ""); } catch { deny("plugin_admission_manifest_changed"); }
  if (digest(actual) !== digest(source.manifest)) deny("plugin_admission_manifest_changed");
}
