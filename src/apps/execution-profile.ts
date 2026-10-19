import type { AgentScope } from "../composition/agent-scope.js";
import type { ContextInstruction } from "../context/types.js";
import type { ModelRef } from "../core/model/model.js";
import type { AgentLoopRequestOptions } from "../core/agent-loop/types.js";
import type { ModelsConfiguration, ModelReasoningEffort, ModelCredentialResolver } from "../models/types.js";
import type { ContextOverflowCompactor } from "../compaction/types.js";
import type { AgentPermissionConfiguration, PermissionProfile } from "../permissions/types.js";
import type { RegisteredSystemPromptSection } from "../system-prompt/types.js";
import type { WishHostConfiguration } from "./config.js";

/** Application-owned consumer port; Profile storage and resolution remain replaceable. */
export interface ApplicationExecutionProfile {
  readonly identity: { readonly id: string; readonly version: number; readonly digest: string };
  readonly model: ModelRef;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly permissionProfile: PermissionProfile;
  readonly models: ModelsConfiguration;
  readonly scope: AgentScope;
  readonly permissions: AgentPermissionConfiguration;
  readonly instructions: readonly ContextInstruction[];
  readonly promptSections: readonly RegisteredSystemPromptSection[];
  readonly reservedOutputTokens: number;
  readonly keepRecentTokens: number;
  readonly summaryMaxOutputTokens: number;
  readonly maxParallelCalls: number;
  readonly request?: AgentLoopRequestOptions;
  readonly excludedContextProviders: readonly string[];
  readonly compactor: ContextOverflowCompactor;
  assertCurrent(): Promise<void>;
  admit(sessionId: string, runId: string): Promise<void>;
  finish(runId: string, status: "completed" | "failed" | "aborted"): Promise<void>;
  release(): Promise<void>;
  attachRuntime(retire: () => Promise<void>): void;
}

export interface ApplicationExecutionProfileProvider {
  open(selection: string, configuration: WishHostConfiguration, credential?: ModelCredentialResolver): Promise<ApplicationExecutionProfile>;
}
