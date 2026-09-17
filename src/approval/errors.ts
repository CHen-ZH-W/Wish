export class ApprovalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalError";
  }
}

export class ApprovalConflictError extends ApprovalError {
  constructor() {
    super("An Approval answerer is already registered");
    this.name = "ApprovalConflictError";
  }
}
