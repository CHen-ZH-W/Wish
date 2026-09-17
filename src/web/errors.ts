export type WebErrorCode =
  | "web_invalid_request"
  | "web_access_denied"
  | "web_policy_mismatch"
  | "web_unavailable"
  | "web_response_too_large"
  | "web_unsupported_content"
  | "web_execution_failed";

/** Stable failure vocabulary shared by Web providers and consumers. */
export class WebError extends Error {
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebError";
  }
}

export class WebInvalidRequestError extends WebError {
  constructor(message: string, options?: ErrorOptions) {
    super("web_invalid_request", message, false, options);
    this.name = "WebInvalidRequestError";
  }
}

export class WebAccessDeniedError extends WebError {
  constructor(message: string, options?: ErrorOptions) {
    super("web_access_denied", message, false, options);
    this.name = "WebAccessDeniedError";
  }
}

export class WebPolicyMismatchError extends WebError {
  constructor(message: string, options?: ErrorOptions) {
    super("web_policy_mismatch", message, false, options);
    this.name = "WebPolicyMismatchError";
  }
}

export class WebUnavailableError extends WebError {
  constructor(
    message = "Web Provider is unavailable",
    retryable = true,
    options?: ErrorOptions,
  ) {
    super("web_unavailable", message, retryable, options);
    this.name = "WebUnavailableError";
  }
}

export class WebResponseTooLargeError extends WebError {
  constructor(readonly maxBytes: number) {
    super(
      "web_response_too_large",
      `Web response exceeds the ${maxBytes} byte limit`,
      false,
    );
    this.name = "WebResponseTooLargeError";
  }
}

export class WebUnsupportedContentError extends WebError {
  constructor(contentType: string) {
    super(
      "web_unsupported_content",
      `Web response content type is not supported: ${contentType || "unknown"}`,
      false,
    );
    this.name = "WebUnsupportedContentError";
  }
}

export class WebExecutionFailedError extends WebError {
  constructor(message: string, options?: ErrorOptions) {
    super("web_execution_failed", message, true, options);
    this.name = "WebExecutionFailedError";
  }
}
