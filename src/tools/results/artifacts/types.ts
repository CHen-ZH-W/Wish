import type { ToolResultArtifact } from "../../../core/tools/tool.js";

export interface PutToolOutputArtifactRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly mediaType: string;
  readonly value: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface GetToolOutputArtifactRequest {
  readonly artifact: ToolResultArtifact;
  readonly signal?: AbortSignal;
}

/** Stable artifact persistence used by Tool Consumers before result archival. */
export interface ToolOutputArtifactStore {
  put(request: PutToolOutputArtifactRequest): Promise<ToolResultArtifact>;
  get(request: GetToolOutputArtifactRequest): Promise<Uint8Array | undefined>;
}
