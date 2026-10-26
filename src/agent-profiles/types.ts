import type { ModelRef } from "../core/model/model.js";
import type { ModelsConfiguration, ModelReasoningEffort } from "../models/types.js";
import type { AgentPermissionConfiguration, PermissionProfile } from "../permissions/types.js";
import type { RegisteredSystemPromptSection } from "../system-prompt/types.js";
import type { ContextInstruction } from "../context/types.js";
import type { ProcessOwner } from "./process-owner.js";

/** An immutable, explicitly numbered Agent recipe, independent of deployment Profiles. */
export interface AgentProfileDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly description?: string;
  readonly model: string;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly instructions?: string;
  readonly tools: readonly string[];
  readonly permissionProfile: PermissionProfile;
  readonly allowedCapabilities?: AgentPermissionConfiguration["allowedCapabilities"];
  readonly compaction?: { readonly strategyId?: string; readonly keepRecentTokens?: number; readonly summaryMaxOutputTokens?: number };
  readonly reservedOutputTokens?: number;
  readonly maxParallelCalls?: number;
  readonly request?: { readonly temperature?: number; readonly maxOutputTokens?: number };
  /** Experiments start with empty private storage; none disables Memory contributions too. */
  readonly memory: "none" | "isolated";
}

/** Exact bytes required by this snapshot. Missing or changed implementations reject execution. */
export interface ProfileCodeFile { readonly path: string; readonly sha256: string }
export interface ProfilePlugin {
  readonly id: string;
  readonly module: string;
  readonly config: unknown;
  readonly enabled: boolean;
}

/** Content-addressed resolved inputs; timestamps and mutable aliases are outside the digest. */
export interface AgentProfileSnapshot {
  /** Absent on legacy recipes; complete resource coverage is always explicit. */
  readonly resources?: import("./resources.js").ProfileResources;
  /** Candidate snapshots are executable only by the confined experiment Provider. */
  readonly candidate?: { readonly sourceDigest: string; readonly artifactDigest: string };
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly runtime: { readonly node: string; readonly platform: string; readonly arch: string; readonly modules: string };
  readonly definition: AgentProfileDefinition;
  readonly model: ModelRef;
  readonly models: ModelsConfiguration;
  readonly instructions: readonly ContextInstruction[];
  readonly promptSections: readonly RegisteredSystemPromptSection[];
  readonly permissions: AgentPermissionConfiguration;
  readonly compaction: { readonly strategyId: string; readonly keepRecentTokens: number; readonly summaryMaxOutputTokens: number };
  readonly reservedOutputTokens: number;
  readonly maxParallelCalls: number;
  readonly code: readonly ProfileCodeFile[];
  readonly plugins: readonly ProfilePlugin[];
  /** Frozen, resolved Cordis tree for a fresh experiment Host; contains no credential values. */
  readonly deployment: readonly Readonly<Record<string, unknown>>[];
}

/** Durable binding is committed before a Run can request a model or execute a Tool. */
export interface ProfileRunBinding {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly snapshotDigest: string;
  readonly instanceId: string;
  readonly owner: ProcessOwner;
  readonly startedAt: string;
  readonly status: "admitted" | "completed" | "failed" | "aborted" | "interrupted";
  readonly endedAt?: string;
}
