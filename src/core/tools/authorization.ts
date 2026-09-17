import {
  assertActiveCapabilityAuthorizationGrant,
  capabilityRequestDigest,
  issueCapabilityAuthorizationGrant,
  normalizeCapabilityRequest,
  withActiveCapabilityAuthorizationGrant,
  type CapabilityAuthorizationGrant,
  type CapabilityClock,
  type CapabilityKind,
  type CapabilityRequest,
  type CapabilityRequirement,
} from "../../permissions/authorization.js";
import type {
  ReadyToolCall,
  ToolDescriptor,
  ToolExecutionScope,
  ToolExecutionSnapshot,
} from "./tool.js";

/** Compatibility names for Tool definitions; the canonical types are generic. */
export type ToolCapabilityKind = CapabilityKind;
export type ToolCapabilityRequirement = CapabilityRequirement;
export type ToolCapabilityRequest = CapabilityRequest;
export type ToolClock = CapabilityClock;

export const normalizeToolCapabilityRequest = normalizeCapabilityRequest;
export const toolCapabilityRequestDigest = capabilityRequestDigest;

export interface ToolAuthorizationInput<Context = unknown> {
  readonly call: ReadyToolCall;
  readonly descriptor: ToolDescriptor;
  readonly capabilities: CapabilityRequest;
  readonly context: Context;
  readonly scope: ToolExecutionScope;
  readonly snapshot: ToolExecutionSnapshot;
}

export type ToolAuthorizationDecision =
  | {
      readonly status: "allowed";
      readonly policyVersion: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

export type ToolAuthorizationValidation =
  | {
      readonly status: "valid";
      readonly policyVersion: string;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

/** Tool-facing policy adapter. Capability Providers do not depend on it. */
export interface ToolAuthorizationService<Context = unknown> {
  authorize(
    input: ToolAuthorizationInput<Context>,
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;

  revalidate(
    input: ToolAuthorizationInput<Context> & {
      readonly decision: Extract<ToolAuthorizationDecision, {
        readonly status: "allowed";
      }>;
    },
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationValidation> | ToolAuthorizationValidation;

  commit?(
    input: ToolAuthorizationInput<Context> & {
      readonly decision: Extract<ToolAuthorizationDecision, {
        readonly status: "allowed";
      }>;
    },
    signal?: AbortSignal,
  ): Promise<ToolAuthorizationValidation> | ToolAuthorizationValidation;
}

export type ToolAuthorizationGrant = CapabilityAuthorizationGrant & {
  readonly subject: {
    readonly kind: "tool";
    readonly id: string;
    readonly name: string;
    readonly generation: number;
  };
};

export interface ToolAuthorizationGrantExpectation {
  readonly call?: ReadyToolCall;
  readonly callId?: string;
  readonly toolName?: string;
  readonly policyVersion?: string;
  readonly authorityVersion?: string;
  readonly registryVersion?: number;
}

export interface IssueToolAuthorizationGrantInput {
  readonly grantId: string;
  readonly call: ReadyToolCall;
  readonly capabilities: CapabilityRequest;
  readonly policyVersion: string;
  readonly snapshot: ToolExecutionSnapshot;
  readonly clock: CapabilityClock;
  readonly issuedAtEpochMs: number;
  readonly ttlMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const issuedCalls = new WeakMap<ToolAuthorizationGrant, ReadyToolCall>();

/** @internal Used by the Core ToolExecutor after final authorization checks. */
export function issueToolAuthorizationGrant(
  input: IssueToolAuthorizationGrantInput,
): ToolAuthorizationGrant {
  const grant = issueCapabilityAuthorizationGrant({
    grantId: input.grantId,
    subject: {
      kind: "tool",
      id: input.call.id,
      name: input.call.name,
      generation: input.snapshot.registryVersion,
    },
    capabilities: input.capabilities,
    policyVersion: input.policyVersion,
    authorityVersion: input.snapshot.authorityVersion,
    clock: input.clock,
    issuedAtEpochMs: input.issuedAtEpochMs,
    ttlMs: input.ttlMs,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }) as ToolAuthorizationGrant;
  issuedCalls.set(grant, input.call);
  return grant;
}

/** Activates a Tool-issued Grant for exactly one dynamic execution extent. */
export function withActiveToolAuthorizationGrant<Output>(
  grant: ToolAuthorizationGrant,
  execute: () => Promise<Output> | Output,
): Promise<Output> {
  return withActiveCapabilityAuthorizationGrant(grant, execute);
}

/** Tool-specific subject validation layered over generic Grant validation. */
export function assertActiveToolAuthorizationGrant(
  grant: ToolAuthorizationGrant,
  expected: ToolAuthorizationGrantExpectation = {},
): void {
  assertActiveCapabilityAuthorizationGrant(grant, {
    subjectKind: "tool",
    ...(expected.callId === undefined ? {} : { subjectId: expected.callId }),
    ...(expected.toolName === undefined ? {} : { subjectName: expected.toolName }),
    ...(expected.registryVersion === undefined
      ? {}
      : { subjectGeneration: expected.registryVersion }),
    ...(expected.policyVersion === undefined
      ? {}
      : { policyVersion: expected.policyVersion }),
    ...(expected.authorityVersion === undefined
      ? {}
      : { authorityVersion: expected.authorityVersion }),
  });
  if (expected.call !== undefined && issuedCalls.get(grant) !== expected.call) {
    throw new Error(`Authorization Grant ${grant.grantId} belongs to another input`);
  }
}
