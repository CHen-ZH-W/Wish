/** Stable provider and model identity resolved before a Run starts. */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export type ModelRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export type DeveloperRoleMode = "native" | "system-fallback";

export interface ModelMessageToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export type ModelMessageContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image_url";
      readonly imageUrl: {
        readonly url: string;
        readonly detail?: "auto" | "low" | "high";
      };
    };

/** Provider-neutral message emitted by Context projection. */
export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
  readonly contentParts?: readonly ModelMessageContentPart[];
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelMessageToolCall[];
  readonly reasoningContent?: string;
}

/** Provider-neutral tool view. Runtime execution remains owned by Tools. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaJson: string;
}

export type ModelMetadata = Readonly<Record<string, unknown>>;

/** Complete input for one model stream attempt. */
export interface ModelRequest {
  readonly model: ModelRef;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly metadata?: ModelMetadata;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type ModelErrorCode =
  | "missing_api_key"
  | "invalid_request"
  | "http_error"
  | "provider_error"
  | "stream_parse_error"
  | "context_overflow"
  | "aborted"
  | "network_error"
  | "unknown";

/** Serializable operational failure. Programming errors may still throw. */
export interface ModelError {
  readonly code: ModelErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export type ModelStreamEvent =
  | {
      readonly type: "start";
      readonly model: ModelRef;
      readonly developerRoleMode?: DeveloperRoleMode;
      readonly authorityDegraded?: boolean;
    }
  | {
      readonly type: "retry";
      readonly error: ModelError;
      readonly retryCount: number;
      readonly delayMs: number;
      readonly fromModel?: ModelRef;
      readonly toModel?: ModelRef;
    }
  | {
      readonly type: "reasoning_delta";
      readonly text: string;
    }
  | {
      readonly type: "text_delta";
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly call: ModelToolCall;
    }
  | {
      readonly type: "done";
      readonly finishReason?: string;
      readonly usage?: ModelUsage;
    }
  | {
      readonly type: "error";
      readonly error: ModelError;
    };

/** Aggregated successful output derived from one completed model stream. */
export interface ModelOutput {
  readonly model: ModelRef;
  readonly reasoning: string;
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason?: string;
  readonly usage?: ModelUsage;
  readonly developerRoleMode?: DeveloperRoleMode;
  readonly authorityDegraded?: boolean;
}
