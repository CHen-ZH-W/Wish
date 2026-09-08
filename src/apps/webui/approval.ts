import { randomUUID } from "node:crypto";

import type { ToolAuthorizationInput } from
  "../../core/tools/authorization.js";
import type {
  BasicToolContext,
  ToolApprovalPort,
  ToolApprovalResponse,
} from "../../tools/index.js";
import type {
  WishWebApproval,
  WishWebApprovalEvent,
} from "./types.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING_APPROVALS = 100;

export interface WebToolApprovalBrokerOptions {
  readonly timeoutMs?: number;
  readonly maxPendingApprovals?: number;
  readonly approvalId?: () => string;
  readonly now?: () => Date;
}

interface PendingApproval {
  readonly view: WishWebApproval & { readonly status: "pending" };
  readonly resolve: (response: ToolApprovalResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
}

type ApprovalListener = (event: WishWebApprovalEvent) => void;

/** One-shot WebUI approval authority; it never creates persistent allow rules. */
export class WebToolApprovalBroker implements ToolApprovalPort<BasicToolContext> {
  private readonly timeoutMs: number;
  private readonly maxPendingApprovals: number;
  private readonly nextApprovalId: () => string;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listenersByRun = new Map<string, Set<ApprovalListener>>();
  private closed = false;

  constructor(options: WebToolApprovalBrokerOptions = {}) {
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      "Web approval timeout",
    );
    this.maxPendingApprovals = positiveInteger(
      options.maxPendingApprovals ?? DEFAULT_MAX_PENDING_APPROVALS,
      "Web pending approval limit",
    );
    this.nextApprovalId = options.approvalId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  requestApproval(
    input: ToolAuthorizationInput<BasicToolContext>,
    signal?: AbortSignal,
  ): Promise<ToolApprovalResponse> | ToolApprovalResponse {
    if (this.closed) return denied("WebUI approval service is closed");
    if (signal?.aborted === true) {
      return denied("Tool approval was cancelled because the Run was aborted");
    }
    if (this.pending.size >= this.maxPendingApprovals) {
      return denied("WebUI pending approval limit was reached");
    }

    const approvalId = requireIdentifier(
      this.nextApprovalId(),
      "Web approval id",
    );
    if (this.pending.has(approvalId)) {
      throw new Error(`Web approval id is already pending: ${approvalId}`);
    }
    const createdAt = validDate(this.now(), "Web approval clock");
    const expiresAt = new Date(createdAt.getTime() + this.timeoutMs);
    const view = approvalView(input, approvalId, createdAt, expiresAt);
    let resolve = (_response: ToolApprovalResponse) => {};
    const promise = new Promise<ToolApprovalResponse>((accept) => {
      resolve = accept;
    });
    const abort = () => {
      this.settle(
        approvalId,
        "cancelled",
        "Tool approval was cancelled because the Run was aborted",
      );
    };
    const timer = setTimeout(() => {
      this.settle(
        approvalId,
        "expired",
        "Tool approval expired before it was answered",
      );
    }, this.timeoutMs);
    timer.unref?.();
    const pending: PendingApproval = {
      view,
      resolve,
      timer,
      abort,
      ...(signal === undefined ? {} : { signal }),
    };
    this.pending.set(approvalId, pending);
    signal?.addEventListener("abort", abort, { once: true });
    this.emit(input.scope.runId, Object.freeze({
      type: "approval.requested" as const,
      approval: view,
    }));
    return promise;
  }

  listPending(runId?: string): readonly WishWebApproval[] {
    const normalizedRunId = runId === undefined
      ? undefined
      : requireIdentifier(runId, "Run id");
    return Object.freeze(
      [...this.pending.values()]
        .map((item) => item.view)
        .filter((item) =>
          normalizedRunId === undefined || item.scope.runId === normalizedRunId
        ),
    );
  }

  decide(approvalId: string, approved: boolean): WishWebApproval | undefined {
    if (typeof approved !== "boolean") {
      throw new Error("Web approval decision must be boolean");
    }
    return this.settle(
      requireIdentifier(approvalId, "Web approval id"),
      approved ? "approved" : "denied",
      approved ? undefined : "Tool approval was denied by the user",
    );
  }

  subscribe(runId: string, listener: ApprovalListener): () => void {
    const id = requireIdentifier(runId, "Run id");
    const listeners = this.listenersByRun.get(id) ?? new Set<ApprovalListener>();
    listeners.add(listener);
    this.listenersByRun.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByRun.delete(id);
    };
  }

  close(reason = "WebUI approval service was closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const approvalId of [...this.pending.keys()]) {
      this.settle(approvalId, "cancelled", reason);
    }
    this.listenersByRun.clear();
  }

  private settle(
    approvalId: string,
    status: Exclude<WishWebApproval["status"], "pending">,
    reason: string | undefined,
  ): WishWebApproval | undefined {
    const pending = this.pending.get(approvalId);
    if (pending === undefined) return undefined;
    this.pending.delete(approvalId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    const resolvedAt = validDate(this.now(), "Web approval clock").toISOString();
    const approval: WishWebApproval = deepFreeze({
      ...pending.view,
      status,
      resolvedAt,
      ...(reason === undefined ? {} : { reason }),
    }) as WishWebApproval;
    this.emit(pending.view.scope.runId, Object.freeze({
      type: "approval.resolved" as const,
      approval,
    }));
    pending.resolve(status === "approved"
      ? Object.freeze({
          status: "approved" as const,
          metadata: Object.freeze({
            source: "wish-webui",
            persistence: "once",
            approvalId,
          }),
        })
      : denied(requireDefined(reason, "Web approval denial reason")));
    return approval;
  }

  private emit(runId: string, event: WishWebApprovalEvent): void {
    for (const listener of this.listenersByRun.get(runId) ?? []) {
      try {
        listener(event);
      } catch {
        // Approval visibility is diagnostic; listeners cannot change authority.
      }
    }
  }
}

function approvalView(
  input: ToolAuthorizationInput<BasicToolContext>,
  approvalId: string,
  createdAt: Date,
  expiresAt: Date,
): WishWebApproval & { readonly status: "pending" } {
  return deepFreeze({
    schemaVersion: 1 as const,
    approvalId,
    status: "pending" as const,
    call: input.call,
    descriptor: input.descriptor,
    capabilities: input.capabilities,
    scope: input.scope,
    workspace: { cwd: input.context.cwd },
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }) as WishWebApproval & { readonly status: "pending" };
}

function denied(reason: string): ToolApprovalResponse {
  return Object.freeze({ status: "denied" as const, reason });
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must return a valid Date`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireDefined<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`${label} is missing`);
  return value;
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreeze(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
