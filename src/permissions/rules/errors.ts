/** Base error for retained approval-rule persistence and lifecycle failures. */
export class ApprovalRuleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalRuleError";
  }
}

export class ApprovalRuleClosedError extends ApprovalRuleError {
  constructor() {
    super("ApprovalRuleStore is closed");
    this.name = "ApprovalRuleClosedError";
  }
}
