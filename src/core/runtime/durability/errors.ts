export type RuntimeReconciliationErrorCode =
  | "runtime_reconciliation_not_found"
  | "runtime_reconciliation_conflict";

export abstract class RuntimeReconciliationError extends Error {
  abstract readonly code: RuntimeReconciliationErrorCode;

  protected constructor(
    message: string,
    readonly runId: string,
    readonly callId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RuntimeReconciliationNotFoundError
  extends RuntimeReconciliationError {
  readonly code = "runtime_reconciliation_not_found" as const;

  constructor(runId: string, callId: string) {
    super(
      `Pending Runtime reconciliation was not found for Run "${runId}" Tool call "${callId}"`,
      runId,
      callId,
    );
  }
}

export class RuntimeReconciliationConflictError
  extends RuntimeReconciliationError {
  readonly code = "runtime_reconciliation_conflict" as const;

  constructor(
    runId: string,
    callId: string,
    message = `Runtime reconciliation for Run "${runId}" Tool call "${callId}" is already resolved`,
  ) {
    super(message, runId, callId);
  }
}
