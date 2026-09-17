import type {
  ToolAuthorizationDecision,
  ToolAuthorizationInput,
  ToolAuthorizationService,
  ToolAuthorizationValidation,
} from "../core/tools/authorization.js";
import type {
  ToolApprovalPort,
  ToolApprovalResponse,
} from "../approval/types.js";

export type {
  ToolApprovalPort,
  ToolApprovalResponse,
} from "../approval/types.js";

export interface InteractiveToolAuthorizationOptions<Context = unknown> {
  readonly approval: ToolApprovalPort<Context>;
  /** A function makes policy updates observable during approval waits. */
  readonly policyVersion: string | (() => string);
  /** Bounds approvals abandoned because their caller was aborted after authorize. */
  readonly maxPendingApprovals?: number;
}

interface PendingApproval<Context> {
  readonly policyVersion: string;
  readonly call: ToolAuthorizationInput<Context>["call"];
  readonly descriptor: ToolAuthorizationInput<Context>["descriptor"];
  readonly capabilities: ToolAuthorizationInput<Context>["capabilities"];
  readonly context: Context;
  readonly scope: ToolAuthorizationInput<Context>["scope"];
  readonly snapshot: ToolAuthorizationInput<Context>["snapshot"];
}

/**
 * Converts one App approval interaction into Core's authorize/revalidate Port.
 * The approval is correlated to the exact immutable input and consumed once.
 */
export class InteractiveToolAuthorizationService<Context = unknown>
  implements ToolAuthorizationService<Context> {
  private readonly policyVersion: () => string;
  private readonly maxPendingApprovals: number;
  private readonly pending = new Map<string, PendingApproval<Context>>();

  constructor(
    private readonly options: InteractiveToolAuthorizationOptions<Context>,
  ) {
    if (
      options === null || typeof options !== "object" ||
      options.approval === null || typeof options.approval !== "object" ||
      typeof options.approval.requestApproval !== "function"
    ) {
      throw new Error(
        "Interactive Tool authorization requires an approval Port",
      );
    }
    const configuredVersion = options.policyVersion;
    this.policyVersion = typeof configuredVersion === "function"
      ? configuredVersion
      : () => configuredVersion;
    this.maxPendingApprovals = positiveSafeInteger(
      options.maxPendingApprovals ?? 1024,
      "maxPendingApprovals",
    );
    readPolicyVersion(this.policyVersion);
  }

  async authorize(
    input: ToolAuthorizationInput<Context>,
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationDecision> {
    throwIfAborted(signal);
    const key = approvalKey(input);
    // A new authorization attempt supersedes any abandoned decision for this call.
    this.pending.delete(key);
    const policyVersion = readPolicyVersion(this.policyVersion);
    const response = await this.options.approval.requestApproval(input, signal);
    throwIfAborted(signal);
    const approval = normalizeApprovalResponse(response);
    if (approval.status === "denied") return approval;

    this.pending.delete(key);
    this.pending.set(key, Object.freeze({
      policyVersion,
      call: input.call,
      descriptor: input.descriptor,
      capabilities: input.capabilities,
      context: input.context,
      scope: input.scope,
      snapshot: input.snapshot,
    }));
    this.prunePending();
    return Object.freeze({
      status: "allowed" as const,
      policyVersion,
      ...(approval.metadata === undefined
        ? {}
        : { metadata: approval.metadata }),
    });
  }

  revalidate(
    input: ToolAuthorizationInput<Context> & {
      readonly decision: Extract<
        ToolAuthorizationDecision,
        { readonly status: "allowed" }
      >;
    },
    signal?: AbortSignal,
  ): ToolAuthorizationValidation {
    throwIfAborted(signal);
    const key = approvalKey(input);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (pending === undefined || !sameAuthorizationInput(pending, input)) {
      return denied("Tool approval is missing, stale, or already consumed");
    }
    if (input.decision.policyVersion !== pending.policyVersion) {
      return denied("Tool approval decision does not match the approved policy");
    }
    const currentPolicyVersion = readPolicyVersion(this.policyVersion);
    if (currentPolicyVersion !== pending.policyVersion) {
      return denied("Tool authorization policy changed before dispatch");
    }
    throwIfAborted(signal);
    return Object.freeze({
      status: "valid" as const,
      policyVersion: currentPolicyVersion,
    });
  }

  private prunePending(): void {
    while (this.pending.size > this.maxPendingApprovals) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.pending.delete(oldest);
    }
  }
}

/** Explicit fail-closed default for an App that has not wired approval yet. */
export function createDenyAllToolAuthorizationService<Context = unknown>(
  reason = "Tool execution is disabled because no approval service is configured",
): ToolAuthorizationService<Context> {
  const denial = denied(requireText(reason, "Tool denial reason"));
  return Object.freeze({
    authorize(): ToolAuthorizationDecision {
      return denial;
    },
    revalidate(): ToolAuthorizationValidation {
      return denial;
    },
  });
}

function approvalKey<Context>(input: ToolAuthorizationInput<Context>): string {
  return JSON.stringify([
    requireIdentifier(input.scope.runId, "Run id"),
    requireIdentifier(input.scope.userTurnId, "UserTurn id"),
    requireIdentifier(input.scope.stepId, "Step id"),
    requireIdentifier(input.call.id, "Tool call id"),
    requireIdentifier(input.call.name, "Tool name"),
    requireIdentifier(input.snapshot.authorityVersion, "Authority version"),
    nonNegativeSafeInteger(input.snapshot.registryVersion, "Registry version"),
  ]);
}

function sameAuthorizationInput<Context>(
  pending: PendingApproval<Context>,
  input: ToolAuthorizationInput<Context>,
): boolean {
  return pending.call === input.call &&
    pending.descriptor === input.descriptor &&
    pending.capabilities === input.capabilities &&
    Object.is(pending.context, input.context) &&
    pending.scope === input.scope &&
    pending.snapshot === input.snapshot;
}

function normalizeApprovalResponse(response: ToolApprovalResponse):
  | Extract<ToolAuthorizationDecision, { readonly status: "denied" }>
  | {
      readonly status: "approved";
      readonly metadata?: Readonly<Record<string, unknown>>;
    } {
  if (response?.status === "denied") {
    return denied(requireText(response.reason, "Tool approval denial reason"));
  }
  if (response?.status !== "approved") {
    throw new Error("Tool approval Port returned an unknown response");
  }
  return Object.freeze({
    status: "approved" as const,
    ...(response.metadata === undefined
      ? {}
      : { metadata: snapshotMetadata(response.metadata) }),
  });
}

function snapshotMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(metadata)) {
    throw new Error("Tool approval metadata must be a plain object");
  }
  return deepFreezePlainValue({ ...metadata }) as Readonly<Record<string, unknown>>;
}

function deepFreezePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezePlainValue));
  if (isPlainRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreezePlainValue(item)]),
    ));
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function denied(
  reason: string,
): Extract<ToolAuthorizationDecision, { readonly status: "denied" }> {
  return Object.freeze({ status: "denied" as const, reason });
}

function readPolicyVersion(read: () => string): string {
  return requireIdentifier(read(), "Tool authorization policy version");
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Tool approval was aborted", { cause: signal.reason });
}
