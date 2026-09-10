import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { FileSessionStore } from "../storage/sessions/file-session-store.js";
import { SessionHistoryAdapter } from "./adapters/history.js";
import { SessionManager } from "./session.js";

/** Loader-owned persistence settings for the Sessions capability. */
export interface Config {
  readonly dataDirectory?: string;
}

export const Config: s<Config> = s.object({
  dataDirectory: s.string(),
});

export interface SessionResources {
  readonly manager: SessionManager;
  readonly history: SessionHistoryAdapter;
}

/** Explicit standalone composition helper; product processes use the service. */
export function createFileSessionResources(
  dataDirectory: string,
): SessionResources {
  const manager = new SessionManager(new FileSessionStore({
    rootDirectory: join(dataDirectory, "sessions"),
  }));
  return Object.freeze({
    manager,
    history: new SessionHistoryAdapter({ sessions: manager }),
  });
}

/** Cordis owner of the Session facade and its shared Context/Compaction views. */
export class Sessions extends Service {
  static readonly inject = ["launch"];
  static readonly Config = Config;

  readonly dataDirectory: string;
  readonly manager: SessionManager;
  readonly history: SessionHistoryAdapter;
  private readonly resources = new Map<string, SessionResources>();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "sessions");
    this.dataDirectory = resolveDataDirectory(ctx, config.dataDirectory);
    const primary = createFileSessionResources(this.dataDirectory);
    this.resources.set(this.dataDirectory, primary);
    this.manager = primary.manager;
    this.history = primary.history;
  }

  /** Resolve one Session graph without moving construction back into Apps. */
  open(dataDirectory: string = this.dataDirectory): SessionResources {
    const normalized = resolveDataDirectory(this.ctx, dataDirectory);
    let resources = this.resources.get(normalized);
    if (resources === undefined) {
      resources = createFileSessionResources(normalized);
      this.resources.set(normalized, resources);
    }
    return resources;
  }
}

function resolveDataDirectory(
  ctx: Context,
  configured: string | undefined,
): string {
  if (configured === undefined) {
    return join(ctx.launch.homeDirectory ?? homedir(), ".wish");
  }
  if (
    configured.length === 0 ||
    configured !== configured.trim()
  ) {
    throw new Error("Sessions dataDirectory must be a non-empty trimmed path");
  }
  return resolve(ctx.launch.cwd, configured);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessions: Sessions;
  }
}

export default Sessions;
