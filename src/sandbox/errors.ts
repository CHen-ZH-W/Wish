export class SandboxPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxPolicyError";
  }
}

export class SandboxPolicyUnavailableError extends SandboxPolicyError {
  constructor(message = "SandboxPolicy Provider is unavailable") {
    super(message);
    this.name = "SandboxPolicyUnavailableError";
  }
}
