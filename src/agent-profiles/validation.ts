import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { loadModelsConfiguration, formatModelReference, resolveConfiguredModel } from "../models/config.js";
import { PERMISSION_PROFILES, TOOL_CAPABILITY_KINDS } from "../permissions/types.js";
import type { AgentProfileDefinition, AgentProfileSnapshot } from "./types.js";
import { validateProfileResources } from "./resources.js";

export class AgentProfileError extends Error {
  constructor(readonly code: string, message: string = code) { super(message); this.name = "AgentProfileError"; }
}

/** Canonical JSON rejects lossy values and produces the same digest regardless of key insertion order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item)).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new AgentProfileError("profile_non_json", "Profile inputs must be lossless JSON");
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function freezeJson<T>(value: T): T {
  const copy: T = JSON.parse(canonical(value));
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value)) throw new AgentProfileError("profile_invalid_id");
  return value;
}
export function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AgentProfileError("profile_invalid_number");
  return Number(value);
}
function nonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AgentProfileError("profile_invalid_number");
  return Number(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentProfileError("profile_invalid_object");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new AgentProfileError("profile_unknown_field");
}
export function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()) || new Set(value).size !== value.length) throw new AgentProfileError("profile_invalid_list");
  return value as string[];
}
export function validateDefinition(value: unknown): AgentProfileDefinition {
  const input = record(value);
  exact(input, ["schemaVersion", "id", "version", "description", "model", "reasoningEffort", "instructions", "tools", "permissionProfile", "allowedCapabilities", "compaction", "reservedOutputTokens", "maxParallelCalls", "request", "memory"]);
  if (input.schemaVersion !== 1 || typeof input.model !== "string" || !input.model.includes("/")) throw new AgentProfileError("profile_invalid_definition");
  identifier(input.id); positive(input.version); strings(input.tools);
  if (!PERMISSION_PROFILES.includes(input.permissionProfile as typeof PERMISSION_PROFILES[number])) throw new AgentProfileError("profile_invalid_permission");
  if (input.memory !== "none" && input.memory !== "isolated") throw new AgentProfileError("profile_invalid_memory");
  if (input.memory === "none" && (input.tools as string[]).some(name => name.startsWith("memory_"))) throw new AgentProfileError("profile_memory_tool_conflict");
  for (const key of ["description", "instructions"]) if (input[key] !== undefined && (typeof input[key] !== "string" || String(input[key]).length > 128_000)) throw new AgentProfileError("profile_invalid_text");
  if (input.reasoningEffort !== undefined && !["none", "low", "high", "max"].includes(String(input.reasoningEffort))) throw new AgentProfileError("profile_invalid_reasoning");
  if (input.allowedCapabilities !== undefined && strings(input.allowedCapabilities).some(kind => !(TOOL_CAPABILITY_KINDS as readonly string[]).includes(kind))) throw new AgentProfileError("profile_invalid_capability");
  if (input.maxParallelCalls !== undefined) positive(input.maxParallelCalls);
  if (input.reservedOutputTokens !== undefined) nonNegative(input.reservedOutputTokens);
  if (input.compaction !== undefined) {
    const policy = record(input.compaction); exact(policy, ["strategyId", "keepRecentTokens", "summaryMaxOutputTokens"]);
    if (policy.strategyId !== undefined) identifier(policy.strategyId);
    for (const key of ["keepRecentTokens", "summaryMaxOutputTokens"]) if (policy[key] !== undefined) positive(policy[key]);
  }
  if (input.request !== undefined) {
    const request = record(input.request); exact(request, ["temperature", "maxOutputTokens"]);
    if (request.maxOutputTokens !== undefined) positive(request.maxOutputTokens);
    if (request.temperature !== undefined && (typeof request.temperature !== "number" || !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new AgentProfileError("profile_invalid_temperature");
  }
  return freezeJson(input) as unknown as AgentProfileDefinition;
}
export function validateSnapshot(value: unknown): AgentProfileSnapshot {
  const input = record(value);
  exact(input, ["schemaVersion", "digest", "runtime", "definition", "model", "models", "instructions", "promptSections", "permissions", "compaction", "reservedOutputTokens", "maxParallelCalls", "code", "plugins", "deployment", "candidate", "resources"]);
  if (input.resources !== undefined) {
    const resources = validateProfileResources(input.resources);
    if (record(input.definition).memory === "none" && resources.memory.kind !== "empty") throw new AgentProfileError("profile_memory_resource_conflict");
  }
  if (input.candidate !== undefined) {
    const candidate = record(input.candidate); exact(candidate, ["sourceDigest", "artifactDigest"]);
    if (!/^[a-f0-9]{64}$/u.test(String(candidate.sourceDigest)) || !/^[a-f0-9]{64}$/u.test(String(candidate.artifactDigest))) throw new AgentProfileError("profile_invalid_candidate");
  }
  if (input.schemaVersion !== 1 || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/u.test(input.digest)) throw new AgentProfileError("profile_invalid_snapshot");
  const definition = validateDefinition(input.definition);
  const { digest: claimed, ...body } = input;
  if (digest(body) !== claimed) throw new AgentProfileError("profile_snapshot_digest_mismatch");
  for (const key of ["code", "plugins", "deployment", "instructions", "promptSections"]) if (!Array.isArray(input[key])) throw new AgentProfileError("profile_invalid_snapshot");
  nonNegative(input.reservedOutputTokens); positive(input.maxParallelCalls);
  const runtime = record(input.runtime); exact(runtime, ["node", "platform", "arch", "modules"]);
  if (Object.values(runtime).length !== 4 || Object.values(runtime).some(value => typeof value !== "string" || !value)) throw new AgentProfileError("profile_invalid_runtime");
  const model = record(input.model); exact(model, ["provider", "model"]);
  if (typeof model.provider !== "string" || typeof model.model !== "string") throw new AgentProfileError("profile_invalid_model");
  const models = record(input.models), defaultModel = record(models.defaultModel);
  if (!Array.isArray(models.fallbackModels)) throw new AgentProfileError("profile_invalid_models");
  const parsedModels = loadModelsConfiguration({ json: { ...models,
    defaultModel: `${String(defaultModel.provider)}/${String(defaultModel.model)}`,
    fallbackModels: models.fallbackModels.map(value => { const item = record(value); return `${String(item.provider)}/${String(item.model)}`; }),
  }, availableProtocols: (Array.isArray(models.providers) ? models.providers : []).map(value => String(record(value).protocol)) });
  const resolved = resolveConfiguredModel(parsedModels, definition.model);
  if (formatModelReference(resolved.ref) !== `${model.provider}/${model.model}` || formatModelReference(parsedModels.defaultModel) !== `${model.provider}/${model.model}`) throw new AgentProfileError("profile_model_mismatch");
  const permissions = record(input.permissions); exact(permissions, ["profile", "availableTools", "allowedCapabilities"]);
  if (permissions.profile !== definition.permissionProfile || canonical(permissions.availableTools) !== canonical(definition.tools)) throw new AgentProfileError("profile_permission_mismatch");
  if (permissions.allowedCapabilities !== undefined && strings(permissions.allowedCapabilities).some(kind => !(TOOL_CAPABILITY_KINDS as readonly string[]).includes(kind))) throw new AgentProfileError("profile_invalid_capability");
  const policy = record(input.compaction); exact(policy, ["strategyId", "keepRecentTokens", "summaryMaxOutputTokens"]);
  identifier(policy.strategyId); positive(policy.keepRecentTokens); positive(policy.summaryMaxOutputTokens);
  const code = input.code as unknown[];
  if (!code.length || code.length > 20_000) throw new AgentProfileError("profile_invalid_code");
  const paths = new Set<string>();
  for (const value of code) {
    const file = record(value); exact(file, ["path", "sha256"]);
    if (typeof file.path !== "string" || !isAbsolute(file.path) || paths.has(file.path) || !/^[a-f0-9]{64}$/u.test(String(file.sha256))) throw new AgentProfileError("profile_invalid_code");
    paths.add(file.path);
  }
  for (const value of input.plugins as unknown[]) {
    const plugin = record(value); exact(plugin, ["id", "module", "enabled", "config"]);
    if (typeof plugin.id !== "string" || typeof plugin.module !== "string" || typeof plugin.enabled !== "boolean" || !("config" in plugin)) throw new AgentProfileError("profile_invalid_plugins");
  }
  return freezeJson(input) as unknown as AgentProfileSnapshot;
}

export function verifyRuntime(snapshot: AgentProfileSnapshot): void {
  const current = { node: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules };
  if (canonical(snapshot.runtime) !== canonical(current)) throw new AgentProfileError("profile_runtime_unavailable");
}
