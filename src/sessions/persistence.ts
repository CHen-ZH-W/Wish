import { Service, type Context } from "@deepseek-ai/cordis";

import type { SessionStore } from "./types.js";

export interface OpenSessionPersistenceRequest {
  /** Absolute Application data directory; Provider owns its layout below it. */
  readonly dataDirectory: string;
}

export interface SessionPersistenceHandle {
  readonly store: SessionStore;
  close(): Promise<void>;
}

/** A persistence generation is retiring or has already been closed. */
export class SessionPersistenceClosedError extends Error {
  readonly code = "session_persistence_closed";

  constructor(message = "Session persistence is closed") {
    super(message);
    this.name = "SessionPersistenceClosedError";
  }
}

/** Replaceable persistence factory for the Sessions business capability. */
export abstract class SessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, "sessionPersistence");
  }

  abstract open(
    request: OpenSessionPersistenceRequest,
  ): SessionPersistenceHandle;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionPersistence: SessionPersistence;
  }
}

export default SessionPersistence;
