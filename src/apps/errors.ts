export type WishApplicationRequestStatus = 400 | 404 | 409 | 503;

/** Transport-neutral public request failure produced by the Application facade. */
export class WishApplicationRequestError extends Error {
  constructor(
    readonly status: WishApplicationRequestStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WishApplicationRequestError";
  }
}
