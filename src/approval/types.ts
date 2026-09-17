import type { ToolAuthorizationInput } from "../core/tools/authorization.js";
import type { ApprovalRuleScope } from "../permissions/rules/types.js";

export type ToolApprovalResponse =
  | {
      readonly status: "approved";
      /** Omitted by legacy surfaces and resolved as one call only. */
      readonly scope?: ApprovalRuleScope;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

/** UI-neutral approval Port; Permissions owns retention and rule persistence. */
export interface ToolApprovalPort<Context = unknown> {
  requestApproval(
    input: ToolAuthorizationInput<Context>,
    signal?: AbortSignal,
  ): Promise<ToolApprovalResponse> | ToolApprovalResponse;
}

/** Lifecycle handle for one process-surface approval answerer. */
export interface ApprovalRegistration {
  readonly id: string;
  unregister(): boolean;
}

export interface ApprovalRegistrationOptions {
  /** Stable owner identity used to correlate transactional generation replacement. */
  readonly id?: string;
  /** Allow a newer generation of the same owner to shadow the old one. */
  readonly replace?: boolean;
}
