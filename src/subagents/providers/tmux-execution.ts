import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../boot/plugin-control/code-reload.js";

import type { Tmux, TmuxSessionSnapshot, TmuxTarget } from "../../tmux/index.js";
import {
  SubagentExecutionService,
  type CaptureSubagentExecutionRequest,
  type SendSubagentExecutionRequest,
  type StartSubagentExecutionRequest,
} from "../execution.js";
import type {
  SubagentExecutionSnapshot,
  SubagentExecutionTarget,
} from "../types.js";

const PROVIDER_ID = "tmux";

/** Thin transport adapter. It owns no child identities, records, or limits. */
export class TmuxSubagentExecution extends SubagentExecutionService {
  static readonly inject = ["tmux"];
  readonly id = PROVIDER_ID;
  private readonly requests = new Set<Promise<unknown>>();
  private closed = false;
  private fenced = false;
  private readonly backend: TmuxSubagentExecutionBackend;

  constructor(ctx: Context) {
    super(ctx);
    this.backend = new TmuxSubagentExecutionBackend(ctx.tmux);
    ctx.effect(() => async () => { this.closed = true; await Promise.allSettled([...this.requests]); }, "execution-adapter.close");
    ctx.root.get("codeReload")?.register(ctx, { prepare: () => {
      if (this.closed || this.fenced) throw Error("Execution adapter is closed");
      this.fenced = true;
      return { drained: Promise.allSettled([...this.requests]).then(() => {}), release: () => { if (!this.closed) this.fenced = false; } };
    } });
  }

  async start(
    request: StartSubagentExecutionRequest,
  ): Promise<SubagentExecutionSnapshot> {
    return this.track(() => this.backend.start(request));
  }

  async inspect(
    target: SubagentExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SubagentExecutionSnapshot | undefined> {
    return this.track(() => this.backend.inspect(target, signal));
  }

  capture(request: CaptureSubagentExecutionRequest): Promise<string> {
    return this.track(() => this.backend.capture(request));
  }

  send(request: SendSubagentExecutionRequest): Promise<void> {
    return this.track(() => this.backend.send(request));
  }

  stop(target: SubagentExecutionTarget, signal?: AbortSignal): Promise<void> {
    return this.track(() => this.backend.stop(target, signal));
  }
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.fenced) throw Error("Execution adapter is closed");
    const work = Promise.resolve().then(operation); this.requests.add(work);
    try { return await work; } finally { this.requests.delete(work); }
  }
}

/** Standalone adapter used by focused and deployment acceptance. */
export class TmuxSubagentExecutionBackend implements
  Pick<TmuxSubagentExecution, "id" | "start" | "inspect" | "capture" | "send" | "stop"> {
  readonly id = PROVIDER_ID;

  constructor(private readonly tmux: Tmux) {}

  async start(request: StartSubagentExecutionRequest): Promise<SubagentExecutionSnapshot> {
    return fromTmuxSnapshot(await this.tmux.start({
      sessionId: request.id,
      windowName: request.role,
      command: request.command,
      metadata: { workspaceRoot: request.workspaceRoot, label: request.role },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }));
  }

  async inspect(target: SubagentExecutionTarget, signal?: AbortSignal) {
    const snapshot = await this.tmux.inspect(toTmuxTarget(target), signal);
    return snapshot === undefined ? undefined : fromTmuxSnapshot(snapshot);
  }

  capture(request: CaptureSubagentExecutionRequest): Promise<string> {
    return this.tmux.capture({
      ...request,
      target: toTmuxTarget(request.target),
    });
  }

  send(request: SendSubagentExecutionRequest): Promise<void> {
    return this.tmux.send({ ...request, target: toTmuxTarget(request.target) });
  }

  stop(target: SubagentExecutionTarget, signal?: AbortSignal): Promise<void> {
    return this.tmux.stop({ target: toTmuxTarget(target), ...(signal === undefined ? {} : { signal }) });
  }
}

function fromTmuxSnapshot(snapshot: TmuxSessionSnapshot): SubagentExecutionSnapshot {
  return Object.freeze({
    target: fromTmuxTarget(snapshot.target),
    active: snapshot.active,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
  });
}

function fromTmuxTarget(target: TmuxTarget): SubagentExecutionTarget {
  return Object.freeze({
    providerId: PROVIDER_ID,
    id: target.sessionId,
    target: target.target,
    attachCommand: target.attachCommand,
    captureCommand: target.captureCommand,
    locator: Object.freeze({
      sessionId: target.sessionId,
      session: target.session,
      window: target.window,
      pane: target.pane,
      target: target.target,
      ...(target.socketPath === undefined ? {} : { socketPath: target.socketPath }),
    }),
  });
}

function toTmuxTarget(target: SubagentExecutionTarget): TmuxTarget {
  if (target.providerId !== PROVIDER_ID) {
    throw new TypeError(`Subagent execution target belongs to ${target.providerId}`);
  }
  return Object.freeze({
    sessionId: required(target.locator.sessionId, "tmux session id"),
    session: required(target.locator.session, "tmux session"),
    window: required(target.locator.window, "tmux window"),
    pane: required(target.locator.pane, "tmux pane"),
    target: required(target.locator.target, "tmux target"),
    ...(target.locator.socketPath === undefined
      ? {}
      : { socketPath: required(target.locator.socketPath, "tmux socket path") }),
    attachCommand: target.attachCommand,
    captureCommand: target.captureCommand,
  });
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${label} is missing`);
  return value;
}

export default TmuxSubagentExecution;
