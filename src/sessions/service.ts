import { registerPluginOwner } from "../boot/plugin-control/owner-registry.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { SessionHistoryAdapter } from "./adapters/history.js";
import {
  type SessionPersistenceHandle,
  SessionPersistenceClosedError,
} from "./persistence.js";
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

/** One Application generation's ownership of a shared Session graph. */
export interface SessionResourcesHandle extends SessionResources {
  readonly released: boolean;
  release(): boolean;
}

interface SessionResourceEntry {
  readonly public: SessionResources;
  readonly persistence: SessionPersistenceHandle;
}

/** Cordis owner of the Session facade and its shared Context/Compaction views. */
export class Sessions extends Service {
  static readonly inject = ["launch", "sessionPersistence"];
  static readonly Config = Config;

  readonly dataDirectory: string;
  readonly manager: SessionManager;
  readonly history: SessionHistoryAdapter;
  private readonly resources = new Map<string, SessionResourceEntry>();
  private leases = 0;
  private state: "open" | "retiring" | "closed" = "open";
  private releaseDrain: (() => void) | undefined;
  private suspended = false;
  private closing: Promise<void> | undefined;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "sessions");
    this.dataDirectory = resolveDataDirectory(ctx, config.dataDirectory);
    const primary = this.createResources(this.dataDirectory);
    this.resources.set(this.dataDirectory, primary);
    this.manager = primary.public.manager;
    this.history = primary.public.history;
    ctx.effect(() => () => this.close(), "sessions.close");
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: () => ({ disposition: this.closing ? "blocked" : this.leases > 0 ? "drain" : "direct",
        code: this.closing ? "sessions_closed" : this.leases > 0 ? "sessions_leases_outstanding" : "sessions_idle",
        counts: { leases: this.leases } }),
      prepare: () => {
        if (this.suspended || this.closing) throw new SessionPersistenceClosedError("sessions is unavailable");
        this.suspended = true;
        return { drained: Promise.resolve(), deactivate: () => this.close(), release: () => { if (!this.closing) this.suspended = false; } };
      },
    });
  }

  private close(): Promise<void> {
    return this.closing ??= (async () => {
      this.state = "retiring";
      if (this.leases > 0) {
        await new Promise<void>((resolve) => {
          this.releaseDrain = resolve;
          if (this.leases === 0) resolve();
        });
      }
      this.releaseDrain = undefined;
      try {
        await closeSessionResources(this.resources.values());
      } finally {
        this.resources.clear();
        this.state = "closed";
      }
    })();
  }

  /** Resolve a non-owning view within the current service generation. */
  open(dataDirectory: string = this.dataDirectory): SessionResources {
    this.assertOpen();
    const normalized = resolveDataDirectory(this.ctx, dataDirectory);
    let entry = this.resources.get(normalized);
    if (entry === undefined) {
      entry = this.createResources(normalized);
      this.resources.set(normalized, entry);
    }
    return entry.public;
  }

  /** Pin a Session graph until its Application generation has drained. */
  acquire(dataDirectory: string = this.dataDirectory): SessionResourcesHandle {
    const resources = this.open(dataDirectory);
    this.leases += 1;
    let released = false;
    const handle: SessionResourcesHandle = {
      manager: resources.manager,
      history: resources.history,
      get released(): boolean {
        return released;
      },
      release: (): boolean => {
        if (released) return false;
        released = true;
        this.leases -= 1;
        if (this.leases === 0) this.releaseDrain?.();
        return true;
      },
    };
    return Object.freeze(handle);
  }

  private createResources(dataDirectory: string): SessionResourceEntry {
    const persistence = this.ctx.sessionPersistence.open({ dataDirectory });
    const manager = new SessionManager(persistence.store);
    return Object.freeze({
      persistence,
      public: Object.freeze({
        manager,
        history: new SessionHistoryAdapter({ sessions: manager }),
      }),
    });
  }

  private assertOpen(): void {
    if (this.state === "open" && !this.suspended) return;
    throw new SessionPersistenceClosedError(
      `Sessions service is ${this.state}`,
    );
  }
}

async function closeSessionResources(
  entries: Iterable<SessionResourceEntry>,
): Promise<void> {
  const settled = await Promise.allSettled(
    [...entries].map((entry) => entry.persistence.close()),
  );
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more Session persistence handles failed to close",
    );
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
