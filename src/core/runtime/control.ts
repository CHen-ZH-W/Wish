import type { AgentRunId, UserTurnId } from "../agent/types.js";
import type {
  AgentStepId,
  RuntimeCancellation,
} from "./state.js";

export type RuntimeControlKind = "steer" | "follow_up" | "abort";

export type RuntimeControlDisposition =
  | "queued"
  | "delivered"
  | "expired"
  | "cancelled"
  | "rejected";

export type RuntimeControlTerminalReason =
  | "user_turn_replaced"
  | "user_turn_completed"
  | "user_turn_failed"
  | "user_turn_aborted"
  | "step_budget_exhausted"
  | "run_cancelled"
  | "run_completed"
  | "run_failed";

export type RuntimeControlReceiptReason =
  | RuntimeControlTerminalReason
  | "duplicate_control"
  | "empty_control_message"
  | "user_turn_not_active"
  | "next_step_inbox_full"
  | "next_step_inbox_bytes_exceeded"
  | "next_turn_queue_full"
  | "next_turn_queue_bytes_exceeded"
  | "already_cancelled"
  | "run_already_terminal"
  | "unknown_run"
  | "agent_mismatch";

interface RuntimeControlBase {
  readonly id?: string;
  readonly source?: string;
}

export interface SteerControl extends RuntimeControlBase {
  readonly type: "steer";
  readonly text: string;
  readonly receivedAt?: string;
}

export interface FollowUpControl<Payload> extends RuntimeControlBase {
  readonly type: "follow_up";
  readonly payload: Payload;
  readonly text?: string;
  readonly receivedAt?: string;
  /** Bypasses only the entry-count limit; the byte limit remains absolute. */
  readonly reserveCapacity?: boolean;
}

export interface AbortControl extends RuntimeControlBase {
  readonly type: "abort";
  readonly reason?: string;
  readonly requestedAt?: string;
}

export type RuntimeControl<Payload = unknown> =
  | SteerControl
  | FollowUpControl<Payload>
  | AbortControl;

export interface RuntimeControlMessage<
  Kind extends Extract<RuntimeControlKind, "steer" | "follow_up"> = Extract<
    RuntimeControlKind,
    "steer" | "follow_up"
  >,
> {
  readonly id: string;
  readonly kind: Kind;
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly text: string;
  readonly source: string;
  readonly receivedAt: string;
}

export interface RuntimeControlRecord<
  Kind extends Extract<RuntimeControlKind, "steer" | "follow_up"> = Extract<
    RuntimeControlKind,
    "steer" | "follow_up"
  >,
> {
  readonly message: RuntimeControlMessage<Kind>;
  readonly status: RuntimeControlDisposition;
  readonly deliveredStepId?: AgentStepId;
  readonly dispositionReason?: RuntimeControlReceiptReason;
}

export interface RuntimeControlReceipt {
  readonly accepted: boolean;
  readonly kind: RuntimeControlKind;
  readonly runId: AgentRunId;
  readonly controlId: string;
  readonly position?: number;
  readonly reason?: RuntimeControlReceiptReason;
  readonly cancellation?: RuntimeCancellation;
}

export interface RuntimeMailboxLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export const DEFAULT_STEP_INBOX_LIMITS: RuntimeMailboxLimits = Object.freeze({
  maxEntries: 100,
  maxBytes: 256 * 1024,
});

export const DEFAULT_TURN_QUEUE_LIMITS: RuntimeMailboxLimits = Object.freeze({
  maxEntries: 5,
  maxBytes: 512 * 1024,
});

interface QueueReceipt<
  Kind extends Extract<RuntimeControlKind, "steer" | "follow_up">,
> {
  readonly accepted: boolean;
  readonly message: RuntimeControlMessage<Kind>;
  readonly position?: number;
  readonly reason?: RuntimeControlReceiptReason;
}

/** Ordered, once-only steering delivery to the next Step of one UserTurn. */
export class NextStepInbox {
  private readonly records: Array<MutableControlRecord<"steer">> = [];
  private readonly closedUserTurns = new Map<
    UserTurnId,
    RuntimeControlTerminalReason
  >();
  private activeUserTurnId: UserTurnId | undefined;
  private closedReason: RuntimeControlTerminalReason | undefined;

  constructor(
    private readonly limits: RuntimeMailboxLimits = DEFAULT_STEP_INBOX_LIMITS,
  ) {
    validateLimits(limits, false);
  }

  openUserTurn(userTurnId: UserTurnId): void {
    if (this.closedReason !== undefined) return;
    if (
      this.activeUserTurnId !== undefined &&
      this.activeUserTurnId !== userTurnId
    ) {
      this.closeUserTurn(this.activeUserTurnId, "user_turn_replaced");
    }
    this.activeUserTurnId = userTurnId;
  }

  enqueue(message: RuntimeControlMessage<"steer">): QueueReceipt<"steer"> {
    const duplicate = this.records.find(
      (record) => record.message.id === message.id,
    );
    if (duplicate !== undefined) {
      return {
        accepted: duplicate.status === "queued",
        message: duplicate.message,
        ...(duplicate.status === "queued"
          ? { position: this.pending(message.userTurnId).indexOf(duplicate) + 1 }
          : {}),
        reason: "duplicate_control",
      };
    }

    const rejection = this.enqueueRejection(message);
    if (rejection !== undefined) {
      this.records.push({
        message,
        status: "rejected",
        dispositionReason: rejection,
      });
      return { accepted: false, message, reason: rejection };
    }

    this.records.push({ message, status: "queued" });
    return {
      accepted: true,
      message,
      position: this.pending(message.userTurnId).length,
    };
  }

  drain(
    userTurnId: UserTurnId,
    stepId: AgentStepId,
  ): readonly RuntimeControlMessage<"steer">[] {
    if (this.closedReason !== undefined || this.activeUserTurnId !== userTurnId) {
      return Object.freeze([]);
    }
    const pending = this.pending(userTurnId);
    for (const record of pending) {
      record.status = "delivered";
      record.deliveredStepId = stepId;
    }
    return Object.freeze(pending.map((record) => record.message));
  }

  hasPending(userTurnId: UserTurnId): boolean {
    return this.pending(userTurnId).length > 0;
  }

  closeUserTurn(
    userTurnId: UserTurnId,
    reason: RuntimeControlTerminalReason = "user_turn_completed",
  ): void {
    for (const record of this.pending(userTurnId)) {
      record.status = "expired";
      record.dispositionReason = reason;
    }
    if (this.activeUserTurnId === userTurnId) {
      this.activeUserTurnId = undefined;
    }
    this.closedUserTurns.set(userTurnId, reason);
  }

  close(
    reason: RuntimeControlTerminalReason = "run_cancelled",
    disposition: Extract<RuntimeControlDisposition, "cancelled" | "expired"> =
      "cancelled",
  ): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const record of this.records) {
      if (record.status === "queued") {
        record.status = disposition;
        record.dispositionReason = reason;
      }
    }
    this.activeUserTurnId = undefined;
  }

  history(): readonly RuntimeControlRecord<"steer">[] {
    return Object.freeze(this.records.map(copyRecord));
  }

  private enqueueRejection(
    message: RuntimeControlMessage<"steer">,
  ): RuntimeControlReceiptReason | undefined {
    if (this.closedReason !== undefined) return this.closedReason;
    const closedReason = this.closedUserTurns.get(message.userTurnId);
    if (closedReason !== undefined) return closedReason;
    if (this.activeUserTurnId !== message.userTurnId) {
      return "user_turn_not_active";
    }
    if (message.text.trim().length === 0) return "empty_control_message";
    const pending = this.pending(message.userTurnId);
    if (pending.length >= this.limits.maxEntries) {
      return "next_step_inbox_full";
    }
    if (
      pending.reduce(
        (total, record) => total + utf8Bytes(record.message.text),
        0,
      ) + utf8Bytes(message.text) > this.limits.maxBytes
    ) {
      return "next_step_inbox_bytes_exceeded";
    }
    return undefined;
  }

  private pending(userTurnId: UserTurnId): Array<MutableControlRecord<"steer">> {
    return this.records.filter(
      (record) =>
        record.status === "queued" && record.message.userTurnId === userTurnId,
    );
  }
}

interface QueuedTurn<Payload> {
  readonly payload: Payload;
  readonly bytes: number;
  readonly record: MutableControlRecord<"follow_up">;
}

/** Ordered next-UserTurn queue with bounded entries and UTF-8 bytes. */
export class NextTurnQueue<Payload> {
  private readonly entries: Array<QueuedTurn<Payload>> = [];
  private readonly records: Array<MutableControlRecord<"follow_up">> = [];
  private closedReason: RuntimeControlTerminalReason | undefined;

  constructor(
    private readonly limits: RuntimeMailboxLimits = DEFAULT_TURN_QUEUE_LIMITS,
  ) {
    validateLimits(limits, true);
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(
    payload: Payload,
    message: RuntimeControlMessage<"follow_up">,
    options: { readonly reserveCapacity?: boolean } = {},
  ): QueueReceipt<"follow_up"> {
    const duplicate = this.records.find(
      (record) => record.message.id === message.id,
    );
    if (duplicate !== undefined) {
      const index = this.entries.findIndex((entry) => entry.record === duplicate);
      return {
        accepted: duplicate.status === "queued",
        message: duplicate.message,
        ...(index < 0 ? {} : { position: index + 1 }),
        reason: "duplicate_control",
      };
    }

    const bytes = utf8Bytes(message.text);
    const rejection = this.enqueueRejection(
      bytes,
      message.text,
      options.reserveCapacity === true,
    );
    const record: MutableControlRecord<"follow_up"> = {
      message,
      status: rejection === undefined ? "queued" : "rejected",
      ...(rejection === undefined ? {} : { dispositionReason: rejection }),
    };
    this.records.push(record);
    if (rejection !== undefined) {
      return { accepted: false, message, reason: rejection };
    }
    this.entries.push({ payload, bytes, record });
    return { accepted: true, message, position: this.entries.length };
  }

  dequeue():
    | {
        readonly payload: Payload;
        readonly message: RuntimeControlMessage<"follow_up">;
      }
    | undefined {
    const next = this.entries.shift();
    if (next === undefined) return undefined;
    next.record.status = "delivered";
    return { payload: next.payload, message: next.record.message };
  }

  close(
    reason: RuntimeControlTerminalReason = "run_cancelled",
    disposition: Extract<RuntimeControlDisposition, "cancelled" | "expired"> =
      "cancelled",
  ): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const entry of this.entries.splice(0, this.entries.length)) {
      entry.record.status = disposition;
      entry.record.dispositionReason = reason;
    }
  }

  history(): readonly RuntimeControlRecord<"follow_up">[] {
    return Object.freeze(this.records.map(copyRecord));
  }

  private enqueueRejection(
    bytes: number,
    text: string,
    reserveCapacity: boolean,
  ): RuntimeControlReceiptReason | undefined {
    if (this.closedReason !== undefined) return this.closedReason;
    if (text.trim().length === 0) return "empty_control_message";
    if (!reserveCapacity && this.entries.length >= this.limits.maxEntries) {
      return "next_turn_queue_full";
    }
    const queuedBytes = this.entries.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    if (queuedBytes + bytes > this.limits.maxBytes) {
      return "next_turn_queue_bytes_exceeded";
    }
    return undefined;
  }
}

export function createRuntimeControlMessage<
  Kind extends Extract<RuntimeControlKind, "steer" | "follow_up">,
>(input: {
  readonly id: string;
  readonly kind: Kind;
  readonly runId: AgentRunId;
  readonly userTurnId: UserTurnId;
  readonly text: string;
  readonly source: string;
  readonly receivedAt: string;
}): RuntimeControlMessage<Kind> {
  return Object.freeze({ ...input });
}

interface MutableControlRecord<
  Kind extends Extract<RuntimeControlKind, "steer" | "follow_up">,
> {
  readonly message: RuntimeControlMessage<Kind>;
  status: RuntimeControlDisposition;
  deliveredStepId?: AgentStepId;
  dispositionReason?: RuntimeControlReceiptReason;
}

function copyRecord<
  Kind extends Extract<RuntimeControlKind, "steer" | "follow_up">,
>(record: MutableControlRecord<Kind>): RuntimeControlRecord<Kind> {
  return Object.freeze({
    message: record.message,
    status: record.status,
    ...(record.deliveredStepId === undefined
      ? {}
      : { deliveredStepId: record.deliveredStepId }),
    ...(record.dispositionReason === undefined
      ? {}
      : { dispositionReason: record.dispositionReason }),
  });
}

function validateLimits(
  limits: RuntimeMailboxLimits,
  allowZeroEntries: boolean,
): void {
  const minimum = allowZeroEntries ? 0 : 1;
  if (!Number.isInteger(limits.maxEntries) || limits.maxEntries < minimum) {
    throw new Error(
      allowZeroEntries
        ? "Runtime mailbox maxEntries must be a non-negative integer"
        : "Runtime mailbox maxEntries must be a positive integer",
    );
  }
  if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error("Runtime mailbox maxBytes must be a positive integer");
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

