import type { ModelRef } from "../../core/model/model.js";
import type { ToolCapabilityRequest } from
  "../../core/tools/authorization.js";
import type {
  ReadyToolCall,
  ToolDescriptor,
  ToolExecutionScope,
} from "../../core/tools/tool.js";
import type { WishRunCompletion, WishRunHandle } from "../types.js";

export type WishWebApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "expired";

/** Serializable, non-executable view of one WebUI Tool approval. */
export interface WishWebApproval {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly status: WishWebApprovalStatus;
  readonly call: ReadyToolCall;
  readonly descriptor: ToolDescriptor;
  readonly capabilities: ToolCapabilityRequest;
  readonly scope: ToolExecutionScope;
  readonly workspace: { readonly cwd: string };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
  readonly reason?: string;
}

export type WishWebApprovalEvent =
  | {
      readonly type: "approval.requested";
      readonly approval: WishWebApproval & { readonly status: "pending" };
    }
  | {
      readonly type: "approval.resolved";
      readonly approval: WishWebApproval;
    };

export type WishWebRunStatus = "running" | WishRunCompletion["status"];

export interface WishWebRunView {
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly runId: string;
  readonly initialUserTurnId: string;
  readonly sessionId: string;
  readonly status: WishWebRunStatus;
  readonly createdAt: string;
  readonly completion?: WishRunCompletion;
}

export interface WishWebRunAccepted {
  readonly run: WishWebRunView & { readonly status: "running" };
  readonly eventsUrl: string;
  readonly controlsUrl: string;
}

export interface WishWebStartRunBody {
  readonly text: string;
  readonly model?: ModelRef;
}

export function wishWebRunAccepted(
  handle: WishRunHandle,
  createdAt = new Date().toISOString(),
): WishWebRunAccepted {
  const runId = encodeURIComponent(handle.runId);
  return Object.freeze({
    run: Object.freeze({
      schemaVersion: 1 as const,
      agentId: handle.agentId,
      runId: handle.runId,
      initialUserTurnId: handle.initialUserTurnId,
      sessionId: handle.scope,
      status: "running" as const,
      createdAt,
    }),
    eventsUrl: `/api/runs/${runId}/events`,
    controlsUrl: `/api/runs/${runId}/controls`,
  });
}
