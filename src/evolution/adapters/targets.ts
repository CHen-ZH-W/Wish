import type { CandidateSource } from "../../candidates/types.js";
import { source as validateSource } from "../../candidates/validation.js";
import type { EvolutionTarget } from "../types.js";
import { fail } from "../validation.js";

export const SUPPORTED_EVOLUTION_TARGETS = Object.freeze(["prompt", "skill", "tool", "plugin"] as const);
/** Object-specific admission above the existing Candidate gates. It grants no additional authority. */
export function assertEvolutionTargetSource(target: EvolutionTarget, value: CandidateSource): void {
  const source = validateSource(value), manifest = source.manifest;
  if (!(SUPPORTED_EVOLUTION_TARGETS as readonly string[]).includes(target)) fail("evolution_target_contract_unavailable");
  if (!source.tests.length || !["drain", "generation"].includes(manifest.replacement)) fail("evolution_target_lifecycle_required");
  const contracts = manifest.contracts; if (!contracts) fail("evolution_target_contract_required");
  const requires = contracts.requires;
  if (target === "prompt" || target === "skill") {
    const service = target === "prompt" ? "systemPrompt" : "skills", method = target === "prompt" ? "register" : "registerSource";
    if (!requires[service]?.methods.includes(method) || Object.keys(requires).some(name => name !== service) || Object.keys(contracts.provides).length ||
      manifest.permissions.capabilities.length || manifest.state.mode !== "stateless" || manifest.sandbox.filesystem !== "none" || manifest.sandbox.process !== "none" || manifest.sandbox.network !== "none") fail("evolution_target_scope_mismatch");
  }
  if (target === "tool" && !requires.tools?.methods.some(method => ["register", "registerScoped"].includes(method))) fail("evolution_tool_registration_required");
  if (target === "tool") toolTargetNames(source);
}
export function toolTargetNames(source: CandidateSource): readonly string[] {
  let value: unknown;
  try { value = JSON.parse(source.files["evolution-target.json"] ?? "null"); } catch { fail("evolution_tool_descriptor_required"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("evolution_tool_descriptor_required");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["schemaVersion", "kind", "tools"].includes(key)) || item.schemaVersion !== 1 || item.kind !== "tool" || !Array.isArray(item.tools) || !item.tools.length || item.tools.length > 16 || new Set(item.tools).size !== item.tools.length ||
    item.tools.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(name) || !name.startsWith(`${source.id.replaceAll("-", "_")}_`))) fail("evolution_tool_descriptor_invalid");
  return Object.freeze([...item.tools]) as readonly string[];
}
