import type { ToolAuthorizationInput } from "../../core/tools/authorization.js";
import type { ToolApprovalPort, ToolApprovalResponse } from "../../tools/index.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { WishCliTerminal } from "./terminal.js";

export type CliControlReadResult =
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "approval" }
  | { readonly type: "stopped" }
  | { readonly type: "eof" };

interface ActiveControlRead {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  interruption?: "approval" | "stopped";
}

/**
 * Serializes terminal approval questions and temporarily preempts the active
 * control prompt. This coordinates stdin only; Runtime still owns all queues.
 */
export class CliInputCoordinator {
  readonly approval: ToolApprovalPort<WishToolExecutionContext>;
  private approvalTail = Promise.resolve();
  private pendingApprovals = 0;
  private approvalsIdle = Promise.resolve();
  private resolveApprovalsIdle: (() => void) | undefined;
  private activeControlRead: ActiveControlRead | undefined;

  constructor(
    private readonly terminal: WishCliTerminal,
    approval: ToolApprovalPort<WishToolExecutionContext>,
  ) {
    this.approval = Object.freeze({
      requestApproval: (
        input: ToolAuthorizationInput<WishToolExecutionContext>,
        signal?: AbortSignal,
      ) =>
        this.requestApproval(approval, input, signal),
    });
  }

  async readControlLine(
    prompt: string,
    stopSignal: AbortSignal,
  ): Promise<CliControlReadResult> {
    if (stopSignal.aborted) return Object.freeze({ type: "stopped" as const });
    if (this.pendingApprovals > 0) {
      await this.approvalsIdle;
      if (stopSignal.aborted) return Object.freeze({ type: "stopped" as const });
    }

    const controller = new AbortController();
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: ActiveControlRead = { controller, settled, settle };
    this.activeControlRead = active;
    const stop = () => {
      active.interruption = "stopped";
      controller.abort(stopSignal.reason);
    };
    stopSignal.addEventListener("abort", stop, { once: true });
    let line: string | undefined;
    try {
      line = await this.terminal.readLine(prompt, controller.signal);
    } finally {
      stopSignal.removeEventListener("abort", stop);
      if (this.activeControlRead === active) this.activeControlRead = undefined;
      active.settle();
    }

    if (active.interruption === "stopped" || stopSignal.aborted) {
      return Object.freeze({ type: "stopped" as const });
    }
    if (line !== undefined) {
      return Object.freeze({ type: "line" as const, line });
    }
    if (active.interruption === "approval") {
      await this.approvalsIdle;
      return stopSignal.aborted
        ? Object.freeze({ type: "stopped" as const })
        : Object.freeze({ type: "approval" as const });
    }
    return Object.freeze({ type: "eof" as const });
  }

  private async requestApproval(
    approval: ToolApprovalPort<WishToolExecutionContext>,
    input: ToolAuthorizationInput<WishToolExecutionContext>,
    signal?: AbortSignal,
  ): Promise<ToolApprovalResponse> {
    this.beginApproval();
    const activeReadSettled = this.preemptControlRead();
    const previous = this.approvalTail;
    let release = () => {};
    this.approvalTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      await activeReadSettled;
      return await approval.requestApproval(input, signal);
    } finally {
      release();
      this.finishApproval();
    }
  }

  private beginApproval(): void {
    this.pendingApprovals += 1;
    if (this.pendingApprovals !== 1) return;
    this.approvalsIdle = new Promise<void>((resolve) => {
      this.resolveApprovalsIdle = resolve;
    });
  }

  private finishApproval(): void {
    this.pendingApprovals -= 1;
    if (this.pendingApprovals !== 0) return;
    this.resolveApprovalsIdle?.();
    this.resolveApprovalsIdle = undefined;
    this.approvalsIdle = Promise.resolve();
  }

  private preemptControlRead(): Promise<void> {
    const active = this.activeControlRead;
    if (active === undefined) return Promise.resolve();
    if (active.interruption === undefined) active.interruption = "approval";
    active.controller.abort("Tool approval needs terminal input");
    return active.settled;
  }
}
