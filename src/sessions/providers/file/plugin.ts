import { registerPluginOwner } from "../../../boot/plugin-control/owner-registry.js";
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
  private suspended = false;
  private closing: Promise<void> | undefined;

  constructor(ctx: Context) {
    super(ctx);
    ctx.effect(() => () => this.close(), "session_file.close");
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: () => ({ disposition: this.closing ? "blocked" : this.handles.size > 0 ? "drain" : "direct",
        code: this.closing ? "session_file_closed" : this.handles.size > 0 ? "session_file_leases_outstanding" : "session_file_idle",
        counts: { leases: this.handles.size } }),
      prepare: () => {
        if (this.suspended || this.closing) throw new SessionPersistenceClosedError("session_file is unavailable");
        this.suspended = true;
        return { drained: Promise.resolve(), deactivate: () => this.close(), release: () => { if (!this.closing) this.suspended = false; } };
      },
    });
  }

  private close(): Promise<void> {
    return this.closing ??= (async () => {
      this.state = "retiring";
      if (this.handles.size > 0) {
        await new Promise<void>((resolve) => {
          this.releaseDrain = resolve;
          if (this.handles.size === 0) resolve();
        });
      }
      this.releaseDrain = undefined;
      this.state = "closed";
    })();
  }

  open(request: OpenSessionPersistenceRequest): SessionPersistenceHandle {
    if (this.state !== "open" || this.suspended) {
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
