/** Serializable child composition selected by the Host, never by a model Tool input. */
import { PERMISSION_PROFILES, TOOL_CAPABILITY_KINDS, type PermissionProfile } from "../permissions/index.js";
import type { CapabilityKind } from "../permissions/authorization.js";
import type { ToolCompositionContract } from "./agent-scope.js";

export interface AgentLocalToolDeclaration extends ToolCompositionContract {
  readonly name: string;
}

export interface AgentScopePreset {
  readonly role: string;
  readonly availableTools?: readonly string[];
  /** Host-declared names supplied by plugins loaded only inside this child role. */
  readonly localTools?: readonly AgentLocalToolDeclaration[];
  readonly prompt?: string;
  readonly compaction?: {
    readonly keepRecentTokens?: number;
    readonly summaryMaxOutputTokens?: number;
  };
  readonly memory?: "snapshot" | "none";
  readonly permissionProfile?: PermissionProfile;
  readonly allowedCapabilities?: readonly CapabilityKind[];
}

export function parseAgentScopePresets(json: string | undefined): readonly AgentScopePreset[] {
  if (json === undefined || json === "") return Object.freeze([]);
  if (Buffer.byteLength(json) > 128_000) throw new TypeError("Agent Scope presets exceed byte limit");
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length > 64) throw new TypeError("Agent Scope presets must be an array of at most 64 entries");
  const roles = new Set<string>();
  return Object.freeze(value.map(item => {
    const preset = snapshotAgentScopePreset(item);
    if (roles.has(preset.role)) throw new TypeError(`Duplicate Agent Scope role ${preset.role}`);
    roles.add(preset.role);
    return preset;
  }));
}

export function snapshotAgentScopePreset(value: unknown): AgentScopePreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Agent Scope preset");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["role", "availableTools", "localTools", "prompt", "compaction", "memory", "permissionProfile", "allowedCapabilities"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError("Unknown Agent Scope preset field");
  const role = identifier(input.role, "Agent Scope role");
  let availableTools: readonly string[] | undefined;
  if (input.availableTools !== undefined) {
    if (!Array.isArray(input.availableTools) || input.availableTools.length === 0 || input.availableTools.length > 128) throw new TypeError("Invalid Agent Scope Tool list");
    const names = input.availableTools.map(value => identifier(value, "Agent Scope Tool"));
    if (new Set(names).size !== names.length) throw new TypeError("Duplicate Agent Scope Tool");
    availableTools = Object.freeze(names);
  }
  let localTools: readonly AgentLocalToolDeclaration[] | undefined;
  if (input.localTools !== undefined) {
    if (!Array.isArray(input.localTools) || input.localTools.length === 0 || input.localTools.length > 64) throw new TypeError("Invalid Agent Scope local Tool declarations");
    const declarations = input.localTools.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Agent Scope local Tool declaration");
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).some(key => !["name", "requires", "requiredCapabilities"].includes(key))) throw new TypeError("Unknown Agent Scope local Tool field");
      const name = identifier(entry.name, "Agent Scope local Tool");
      const requires = stringList(entry.requires ?? [], "Agent Scope runtime feature");
      const requiredCapabilities = entry.requiredCapabilities === undefined ? undefined : capabilityList(entry.requiredCapabilities);
      return Object.freeze({ name, requires,
        ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
      });
    });
    if (new Set(declarations.map(item => item.name)).size !== declarations.length) throw new TypeError("Duplicate Agent Scope local Tool");
    localTools = Object.freeze(declarations);
  }
  const prompt = input.prompt === undefined ? undefined : (() => {
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 32_000) throw new TypeError("Invalid Agent Scope Prompt");
    return input.prompt;
  })();
  let compaction: AgentScopePreset["compaction"];
  if (input.compaction !== undefined) {
    if (!input.compaction || typeof input.compaction !== "object" || Array.isArray(input.compaction)) throw new TypeError("Invalid Agent Scope Compaction");
    const policy = input.compaction as Record<string, unknown>;
    if (Object.keys(policy).some(key => key !== "keepRecentTokens" && key !== "summaryMaxOutputTokens")) throw new TypeError("Unknown Agent Scope Compaction field");
    compaction = Object.freeze({
      ...(policy.keepRecentTokens === undefined ? {} : { keepRecentTokens: positive(policy.keepRecentTokens) }),
      ...(policy.summaryMaxOutputTokens === undefined ? {} : { summaryMaxOutputTokens: positive(policy.summaryMaxOutputTokens) }),
    });
  }
  if (input.memory !== undefined && input.memory !== "snapshot" && input.memory !== "none") throw new TypeError("Invalid Agent Scope Memory mode");
  if (input.permissionProfile !== undefined && !PERMISSION_PROFILES.includes(input.permissionProfile as PermissionProfile)) throw new TypeError("Invalid Agent Scope permission profile");
  let allowedCapabilities: readonly CapabilityKind[] | undefined;
  if (input.allowedCapabilities !== undefined) {
    allowedCapabilities = capabilityList(input.allowedCapabilities);
  }
  return Object.freeze({ role,
    ...(availableTools === undefined ? {} : { availableTools }),
    ...(localTools === undefined ? {} : { localTools }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(input.memory === undefined ? {} : { memory: input.memory as "snapshot" | "none" }),
    ...(input.permissionProfile === undefined ? {} : { permissionProfile: input.permissionProfile as PermissionProfile }),
    ...(allowedCapabilities === undefined ? {} : { allowedCapabilities }),
  });
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string" || !item.trim() || item !== item.trim()) || new Set(value).size !== value.length) {
    throw new TypeError(`Invalid ${label} list`);
  }
  return Object.freeze([...value]);
}

function capabilityList(value: unknown): readonly CapabilityKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TOOL_CAPABILITY_KINDS.length ||
      value.some(kind => !TOOL_CAPABILITY_KINDS.includes(kind as CapabilityKind)) || new Set(value).size !== value.length) {
    throw new TypeError("Invalid Agent Scope capability list");
  }
  return Object.freeze([...value] as CapabilityKind[]);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(value)) throw new TypeError(`${label} must be a lowercase identifier`);
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("Agent Scope Compaction value must be a positive integer");
  return value as number;
}
