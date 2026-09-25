import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { Service, type Context } from "@deepseek-ai/cordis";

import type { ToolAuthorizationInput } from "../core/tools/authorization.js";
import { ApprovalConflictError } from "./errors.js";
import type {
  ApprovalRegistration,
  ApprovalRegistrationOptions,
  ToolApprovalPort,
  ToolApprovalResponse,
} from "./types.js";
import {
  APPROVAL_RULE_SCOPES,
  type ApprovalRuleScope,
} from "../permissions/rules/types.js";

type ApprovalAnswerer = (
  input: ToolAuthorizationInput<unknown>,
  signal?: AbortSignal,
) => Promise<ToolApprovalResponse> | ToolApprovalResponse;

interface RegisteredAnswerer {
  readonly id: string;
  readonly answer: ApprovalAnswerer;
  readonly pending: Set<PendingApprovalRequest>;
}

interface PendingApprovalRequest {
  cancel(reason: string): void;
}

/** Cordis lifecycle hub joining policy requests to the active process surface. */
export class ApprovalHub extends Service {
  private readonly answerers: RegisteredAnswerer[] = [];
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context) {
    super(ctx, "approval");
    this.work = new PluginWorkOwner(ctx, {
      code: "approval_hub",
      codeReload: true,
      beforeDrain: () => this.cancelAll("Tool approval was cancelled because its owner is changing"),
      close: () => {
        this.cancelAll("Tool approval was cancelled because its owner was closed");
        this.answerers.splice(0);
      },
    });
  }

  /** Register one answerer for exactly the lifetime of the calling plugin fiber. */
  register<ApprovalContext>(
    answerer: ToolApprovalPort<ApprovalContext>,
    options: ApprovalRegistrationOptions = {},
  ): ApprovalRegistration {
    this.work.assertAttached();
    validateAnswerer(answerer);
    const id = requireIdentifier(options.id ?? "default", "Approval owner id");
    const current = this.answerers.at(-1);
    if (
      current !== undefined &&
      (options.replace !== true || current.id !== id)
    ) throw new ApprovalConflictError();

    const registered: RegisteredAnswerer = Object.freeze({
      id,
      pending: new Set<PendingApprovalRequest>(),
      answer: (
        input: ToolAuthorizationInput<unknown>,
        signal?: AbortSignal,
      ) => answerer.requestApproval(
        input as ToolAuthorizationInput<ApprovalContext>,
        signal,
      ),
    });
    this.answerers.push(registered);
    let active = true;
    const registration: ApprovalRegistration = Object.freeze({
      id,
      unregister: (): boolean => {
        if (!active) return false;
        active = false;
        const index = this.answerers.indexOf(registered);
        if (index >= 0) this.answerers.splice(index, 1);
        cancelPending(
          registered,
          "Tool approval was cancelled because its answerer was unregistered",
        );
        return true;
      },
    });

    try {
      this.ctx.effect(() => () => {
        registration.unregister();
      }, "approval.register(answerer)");
      if (current !== undefined) {
        cancelPending(
          current,
          "Tool approval was cancelled because its answerer was replaced",
        );
      }
    } catch (error: unknown) {
      registration.unregister();
      throw error;
    }
    return registration;
  }

  hasAnswerer(): boolean {
    this.work.assertOpen();
    return this.answerers.length > 0;
  }

  async requestApproval<ApprovalContext>(
    input: ToolAuthorizationInput<ApprovalContext>,
    signal?: AbortSignal,
  ): Promise<ToolApprovalResponse> {
    // Route to the current answerer synchronously before the caller can retire
    // that answerer's Fiber; the hold still owns the asynchronous response.
    const release = this.work.hold();
    try {
      throwIfAborted(signal);
      const answerer = this.answerers.at(-1);
      if (answerer === undefined) {
        return denied(
          "Tool approval is unavailable because no answerer is registered",
        );
      }
      const controller = new AbortController();
      let settled = false;
      let cancellationReason: string | undefined;
      let settleCancellation!: (response: ToolApprovalResponse) => void;
      let rejectCancellation!: (reason: unknown) => void;
      const cancellation = new Promise<ToolApprovalResponse>((resolve, reject) => {
        settleCancellation = resolve;
        rejectCancellation = reject;
      });
      const abort = () => {
        if (settled) return;
        const reason = abortReason(signal);
        controller.abort(reason);
        rejectCancellation(reason);
      };
      const pending: PendingApprovalRequest = Object.freeze({
        cancel(reason: string): void {
          if (settled) return;
          cancellationReason ??= reason;
          controller.abort(new Error(reason));
          settleCancellation(denied(reason));
        },
      });
      answerer.pending.add(pending);
      signal?.addEventListener("abort", abort, { once: true });
      let response: Promise<ToolApprovalResponse>;
      try {
        response = Promise.resolve(answerer.answer(
          input as ToolAuthorizationInput<unknown>,
          controller.signal,
        ));
      } catch (error: unknown) {
        response = Promise.reject(error);
      }
      try {
        const result = await Promise.race([response, cancellation]);
        throwIfAborted(signal);
        if (cancellationReason !== undefined) return denied(cancellationReason);
        return snapshotApprovalResponse(result);
      } finally {
        settled = true;
        answerer.pending.delete(pending);
        signal?.removeEventListener("abort", abort);
      }
    } finally {
      release();
    }
  }

  private cancelAll(reason: string): void {
    for (const answerer of this.answerers) cancelPending(answerer, reason);
  }
}

function cancelPending(answerer: RegisteredAnswerer, reason: string): void {
  for (const request of [...answerer.pending]) request.cancel(reason);
}

function denied(reason: string): ToolApprovalResponse {
  return Object.freeze({ status: "denied" as const, reason });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Approval request was aborted", { cause: signal?.reason });
}

function validateAnswerer<ApprovalContext>(
  answerer: ToolApprovalPort<ApprovalContext>,
): void {
  if (
    answerer === null || typeof answerer !== "object" ||
    typeof answerer.requestApproval !== "function"
  ) {
    throw new TypeError("Approval answerer must implement requestApproval()");
  }
}

function snapshotApprovalResponse(response: ToolApprovalResponse): ToolApprovalResponse {
  if (response?.status === "denied") {
    return Object.freeze({
      status: "denied" as const,
      reason: requireText(response.reason, "Approval denial reason"),
    });
  }
  if (response?.status !== "approved") {
    throw new TypeError("Approval answerer returned an unknown response");
  }
  return Object.freeze({
    status: "approved" as const,
    ...(response.scope === undefined
      ? {}
      : { scope: approvalScope(response.scope) }),
    ...(response.metadata === undefined
      ? {}
      : {
          metadata: snapshotPlainValue(response.metadata) as Readonly<
            Record<string, unknown>
          >,
        }),
  });
}

function approvalScope(
  value: ApprovalRuleScope,
): ApprovalRuleScope {
  if (!(APPROVAL_RULE_SCOPES as readonly unknown[]).includes(value)) {
    throw new TypeError("Approval scope is invalid");
  }
  return value;
}

function snapshotPlainValue(value: unknown): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean" || value === undefined
  ) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotPlainValue));
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, snapshotPlainValue(item)]),
    ));
  }
  throw new TypeError("Approval metadata must contain only plain values");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) throw new TypeError(`${label} must be a non-empty trimmed string`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Approval request was aborted", { cause: signal.reason });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    approval: ApprovalHub;
  }
}

export default ApprovalHub;
