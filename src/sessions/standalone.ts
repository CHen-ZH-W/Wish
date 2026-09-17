import { join, resolve } from "node:path";

import { FileSessionStore } from
  "./providers/file/store.js";
import { SessionHistoryAdapter } from "./adapters/history.js";
import { SessionManager } from "./session.js";
import type { SessionResources } from "./service.js";

/** Explicit file composition helper for tests and standalone embedding. */
export function createFileSessionResources(
  dataDirectory: string,
): SessionResources {
  const manager = new SessionManager(new FileSessionStore({
    rootDirectory: join(resolve(dataDirectory), "sessions"),
  }));
  return Object.freeze({
    manager,
    history: new SessionHistoryAdapter({ sessions: manager }),
  });
}
