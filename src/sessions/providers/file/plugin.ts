import { join, resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";

import {
  type OpenSessionPersistenceRequest,
  type SessionPersistenceHandle,
  SessionPersistence,
  SessionPersistenceClosedError,
} from "../../persistence.js";
import { FileSessionStore } from "./store.js";

/** SessionPersistence Provider retaining the existing sessions directory layout. */
export class FileSessionPersistence extends SessionPersistence {
  private readonly handles = new Set<SessionPersistenceHandle>();
  private state: "open" | "retiring" | "closed" = "open";
  private releaseDrain: (() => void) | undefined;

  constructor(ctx: Context) {
    super(ctx);
    ctx.effect(() => async () => {
      this.state = "retiring";
      if (this.handles.size > 0) {
        await new Promise<void>((resolve) => {
          this.releaseDrain = resolve;
          if (this.handles.size === 0) resolve();
        });
      }
      this.releaseDrain = undefined;
      this.state = "closed";
    }, "session-file.close");
  }

  open(request: OpenSessionPersistenceRequest): SessionPersistenceHandle {
    if (this.state !== "open") {
      throw new SessionPersistenceClosedError(
        "File Session persistence Provider is retiring",
      );
    }
    if (request === null || typeof request !== "object") {
      throw new TypeError("SessionPersistence request must be an object");
    }
    if (
      typeof request.dataDirectory !== "string" ||
      request.dataDirectory.length === 0 ||
      request.dataDirectory !== request.dataDirectory.trim()
    ) throw new TypeError("SessionPersistence dataDirectory is invalid");
    const store = new FileSessionStore({
      rootDirectory: join(resolve(request.dataDirectory), "sessions"),
    });
    let closing: Promise<void> | undefined;
    const handle: SessionPersistenceHandle = Object.freeze({
      store,
      close: async (): Promise<void> => {
        if (closing !== undefined) return closing;
        closing = (async () => {
          try {
            await store.close();
          } finally {
            this.handles.delete(handle);
            if (this.handles.size === 0) this.releaseDrain?.();
          }
        })();
        return closing;
      },
    });
    this.handles.add(handle);
    return handle;
  }
}

export default FileSessionPersistence;
