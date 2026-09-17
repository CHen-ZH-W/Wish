import type { PermissionProfile } from "../permissions/index.js";
import type { ModelsConfiguration } from "../models/types.js";
import type { CapabilityKind } from "../permissions/authorization.js";

export interface SubagentOwner {
  readonly parentAgentId: string;
  readonly parentSessionId: string;
  readonly parentRunId: string;
  readonly workspaceRoot: string;
}

/** Executable selected by a Host launcher, never by model input. */
export interface SubagentCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
}

/** Provider-neutral, serializable address of one observable child execution. */
export interface SubagentExecutionTarget {
  readonly providerId: string;
  readonly id: string;
  readonly target: string;
  readonly attachCommand: string;
  readonly captureCommand: string;
  readonly locator: Readonly<Record<string, string>>;
}

export interface SubagentExecutionSnapshot {
  readonly target: SubagentExecutionTarget;
  readonly active: boolean;
  readonly exitCode?: number;
}

export type SubagentStatus =
  | "starting"
  | "running"
  | "exited"
  | "stopped"
  | "failed"
  | "lost";

/** Durable semantic identity; the selected execution Provider owns live-process facts. */
export interface SubagentRecord {
  /** Host-committed attachment binding, saved before the child starts. */
  readonly resourceManifestDigest?: string;
  readonly allowedCapabilities?: readonly CapabilityKind[];
  readonly schemaVersion: 1;
  readonly id: string;
  readonly parentAgentId: string;
  readonly parentSessionId: string;
  readonly parentRunId: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly workspaceRoot: string;
  readonly role: string;
  readonly task: string;
  readonly model?: string;
  readonly permissionProfile?: PermissionProfile;
  readonly availableTools?: readonly string[];
  readonly status: SubagentStatus;
  readonly target?: SubagentExecutionTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly failure?: string;
  readonly result?: SubagentResult;
}

export interface SubagentResult {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly childSessionId: string;
  readonly childRunId: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly text?: string;
  readonly error?: string;
  readonly completedAt: string;
}

export interface SpawnSubagentRequest extends SubagentOwner {
  /** Host-only capability ceiling, in addition to the Tool allow-list. */
  readonly allowedCapabilities?: readonly CapabilityKind[];
  /** Host-owned dispatch identity. Repeating a key never starts a second child. */
  readonly idempotencyKey?: string;
  readonly task: string;
  readonly role?: string;
  readonly model?: string;
  /** Host-only resolved snapshot used to reproduce the parent's Model catalog. */
  readonly modelsConfiguration?: ModelsConfiguration;
  readonly permissionProfile?: PermissionProfile;
  readonly availableTools?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ListSubagentsRequest extends SubagentOwner {
  readonly status?: SubagentStatus;
  readonly signal?: AbortSignal;
}
/** Host-only stored observation across a Session's Runs. Does not refresh or operate processes. */
export interface ObserveSessionSubagentsRequest extends Omit<SubagentOwner, "parentRunId"> { readonly signal?: AbortSignal }

export interface InspectSubagentRequest extends SubagentOwner {
  readonly id: string;
  readonly signal?: AbortSignal;
}

export interface CaptureSubagentRequest extends InspectSubagentRequest {
  readonly lines?: number;
  readonly maxChars?: number;
}

export interface SendSubagentRequest extends InspectSubagentRequest {
  readonly text: string;
  readonly enter?: boolean;
}

export interface StopSubagentRequest extends InspectSubagentRequest {}

export interface CollectSubagentRequest extends CaptureSubagentRequest {}

export interface CollectedSubagent {
  readonly record: SubagentRecord;
  readonly output?: string;
}

export interface SubagentEvent {
  readonly type: "subagent.updated";
  readonly occurredAt: string;
  readonly record: SubagentRecord;
}

export type SubagentEventListener = (event: SubagentEvent) => void;

export interface SubagentLaunchIdentity {
  readonly id: string;
  readonly childSessionId: string;
  readonly childRunId: string;
}

export interface SubagentLaunch {
  readonly resourceManifestDigest?: string;
  readonly command: SubagentCommand;
  readonly windowName?: string;
  readonly cleanupOnFailure?: () => Promise<void> | void;
}

export interface SubagentResultReader {
  read(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined>;
}

/** Host-owned command factory. Model input can never choose an executable. */
export interface SubagentLauncher {
  resolve(
    request: SpawnSubagentRequest,
    identity: SubagentLaunchIdentity,
  ): Promise<SubagentLaunch> | SubagentLaunch;
}

export interface SubagentRecordStore {
  create(record: SubagentRecord, signal?: AbortSignal): Promise<void>;
  replace(record: SubagentRecord, signal?: AbortSignal): Promise<void>;
  get(id: string, signal?: AbortSignal): Promise<SubagentRecord | undefined>;
  list(signal?: AbortSignal): Promise<readonly SubagentRecord[]>;
  close(): Promise<void>;
}

export interface Subagents {
  observeSession(request: ObserveSessionSubagentsRequest): Promise<readonly SubagentRecord[]>;
  spawn(request: SpawnSubagentRequest): Promise<SubagentRecord>;
  list(request: ListSubagentsRequest): Promise<readonly SubagentRecord[]>;
  inspect(request: InspectSubagentRequest): Promise<SubagentRecord | undefined>;
  capture(request: CaptureSubagentRequest): Promise<string>;
  send(request: SendSubagentRequest): Promise<void>;
  stop(request: StopSubagentRequest): Promise<SubagentRecord>;
  collect(request: CollectSubagentRequest): Promise<CollectedSubagent>;
  subscribe(listener: SubagentEventListener): () => void;
  close(): Promise<void>;
}
