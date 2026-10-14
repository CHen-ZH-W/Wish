import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { UserTerminalError } from "../errors.js";
import { UserTerminalService } from "../service.js";
import type { CreateUserTerminalRequest, UserTerminalFrame, UserTerminalShellChoice, UserTerminalView } from "../types.js";
import { HostUserTerminalRuntime, type PreparedUserTerminal } from "./host-runtime.js";

const MAX_LABEL_LENGTH = 80;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_TERMINALS_PER_SESSION = 4;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_SCROLLBACK = 1_000;
const DEFAULT_MAX_FOLLOWER_BYTES = 2 * 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const localRequire = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = localRequire("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = localRequire("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

export interface Config {
  readonly maxTerminalsPerSession?: number;
  readonly scrollback?: number;
  readonly maxFollowerBytes?: number;
  readonly closeGraceMs?: number;
}

export const Config: s<Config> = s.object({
  maxTerminalsPerSession: s.number().step(1).min(1),
  scrollback: s.number().step(1).min(0),
  maxFollowerBytes: s.number().step(1).min(1024),
  closeGraceMs: s.number().step(1).min(0),
});

interface SessionTerminals {
  readonly workspaceRoot: string;
  readonly terminals: Map<string, DirectUserTerminal>;
}

/** Direct PTY Provider. Browser attachment lifetime never owns process lifetime. */
export class LocalUserTerminal extends UserTerminalService {
  static readonly inject = ["workspace"];
  static readonly Config = Config;
  private readonly work: PluginWorkOwner;
  private readonly sessions = new Map<string, SessionTerminals>();
  private readonly maxTerminalsPerSession: number;
  private readonly scrollback: number;
  private readonly maxFollowerBytes: number;
  private readonly closeGraceMs: number;
  private readonly runtime: HostUserTerminalRuntime;
  private creationTail = Promise.resolve();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.maxTerminalsPerSession = positiveInteger(config.maxTerminalsPerSession ?? DEFAULT_MAX_TERMINALS_PER_SESSION, "User Terminal maxTerminalsPerSession");
    this.scrollback = nonNegativeInteger(config.scrollback ?? DEFAULT_SCROLLBACK, "User Terminal scrollback");
    this.maxFollowerBytes = positiveInteger(config.maxFollowerBytes ?? DEFAULT_MAX_FOLLOWER_BYTES, "User Terminal maxFollowerBytes");
    this.closeGraceMs = nonNegativeInteger(config.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, "User Terminal closeGraceMs");
    this.runtime = new HostUserTerminalRuntime();
    this.work = new PluginWorkOwner(ctx, {
      code: "user_terminal",
      codeReload: true,
      blocked: () => this.count() > 0 ? "user_terminal_active" : undefined,
      beforeDrain: () => this.detachAll(),
      close: () => this.closeAll(),
    });
  }

  listShells(signal?: AbortSignal): Promise<readonly UserTerminalShellChoice[]> {
    return this.work.run(() => this.runtime.listShells(signal));
  }

  list(ownerSessionId: string, workspaceRoot: string, signal?: AbortSignal): Promise<readonly UserTerminalView[]> {
    return this.work.run(() => {
      throwIfAborted(signal);
      const session = this.sessions.get(ownerSessionId);
      if (session === undefined) return Object.freeze([]);
      assertWorkspace(session, workspaceRoot);
      return Object.freeze([...session.terminals.values()].map(terminal => terminal.view));
    });
  }

  create(request: CreateUserTerminalRequest): Promise<UserTerminalView> {
    return this.work.run(() => this.serializeCreation(async () => {
      const workspace = await this.ctx.workspace.resolve({ root: request.workspaceRoot, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      let session = this.sessions.get(request.ownerSessionId);
      if (session !== undefined) assertWorkspace(session, workspace.root);
      if ((session?.terminals.size ?? 0) >= this.maxTerminalsPerSession) {
        throw new UserTerminalError("limit_reached", `A Session may retain at most ${this.maxTerminalsPerSession} user terminals`);
      }
      const prepared = await this.runtime.prepare(workspace.root, request.shellPath, request.ownerSessionId, request.signal);
      try {
        throwIfAborted(request.signal);
        const columns = dimension(request.columns ?? DEFAULT_COLUMNS, "columns");
        const rows = dimension(request.rows ?? DEFAULT_ROWS, "rows");
        const id = `user-${randomUUID()}`;
        const shell = shellName(prepared);
        const terminal = DirectUserTerminal.spawn(prepared, Object.freeze({
          id,
          label: terminalLabel(request.label, shell),
          createdAt: new Date().toISOString(),
          active: true,
          authority: "host-user",
          shell,
          columns,
          rows,
        }), this.scrollback, this.maxFollowerBytes, this.closeGraceMs);
        if (session === undefined) {
          session = { workspaceRoot: workspace.root, terminals: new Map() };
          this.sessions.set(request.ownerSessionId, session);
        }
        session.terminals.set(id, terminal);
        return terminal.view;
      } catch (error) {
        await cleanupRuntimeDirectory(prepared.runtimeDirectory);
        throw error;
      }
    }));
  }

  follow(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, signal: AbortSignal): AsyncIterable<UserTerminalFrame> {
    return this.work.stream(() => {
      if (!/^[\w-]{1,128}$/u.test(attachmentId)) throw new UserTerminalError("invalid_input", "Terminal attachment id is invalid");
      return this.requireTerminal(ownerSessionId, workspaceRoot, terminalId).follow(attachmentId, signal);
    });
  }

  write(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.work.run(() => {
      if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
        throw new UserTerminalError("invalid_input", "Terminal input is invalid or too large");
      }
      throwIfAborted(signal);
      return this.requireTerminal(ownerSessionId, workspaceRoot, terminalId).write(attachmentId, text);
    });
  }

  resize(ownerSessionId: string, workspaceRoot: string, terminalId: string, attachmentId: string, columns: number, rows: number, signal?: AbortSignal): Promise<void> {
    return this.work.run(() => {
      throwIfAborted(signal);
      return this.requireTerminal(ownerSessionId, workspaceRoot, terminalId).resize(attachmentId, dimension(columns, "columns"), dimension(rows, "rows"));
    });
  }

  close(ownerSessionId: string, workspaceRoot: string, terminalId: string, signal?: AbortSignal): Promise<void> {
    return this.work.run(async () => {
      throwIfAborted(signal);
      const session = this.requireSession(ownerSessionId, workspaceRoot);
      const terminal = session.terminals.get(terminalId);
      if (terminal === undefined) throw new UserTerminalError("not_found", "User Terminal was not found in this Session");
      await terminal.close();
      session.terminals.delete(terminalId);
      if (session.terminals.size === 0) this.sessions.delete(ownerSessionId);
    });
  }

  private requireSession(ownerSessionId: string, workspaceRoot: string): SessionTerminals {
    const session = this.sessions.get(ownerSessionId);
    if (session === undefined) throw new UserTerminalError("not_found", "User Terminal was not found in this Session");
    assertWorkspace(session, workspaceRoot);
    return session;
  }

  private requireTerminal(ownerSessionId: string, workspaceRoot: string, terminalId: string): DirectUserTerminal {
    const terminal = this.requireSession(ownerSessionId, workspaceRoot).terminals.get(terminalId);
    if (terminal === undefined) throw new UserTerminalError("not_found", "User Terminal was not found in this Session");
    return terminal;
  }

  private count(): number { let total = 0; for (const session of this.sessions.values()) total += session.terminals.size; return total; }
  private detachAll(): void { for (const session of this.sessions.values()) for (const terminal of session.terminals.values()) terminal.detachFollowers(); }
  private async closeAll(): Promise<void> {
    const terminals = [...this.sessions.values()].flatMap(session => [...session.terminals.values()]);
    await Promise.allSettled(terminals.map(terminal => terminal.close()));
    this.sessions.clear();
  }
  private serializeCreation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.creationTail.then(action);
    this.creationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** One direct process, recovery screen, and set of detachable browser followers. */
export class DirectUserTerminal {
  private readonly screen: HeadlessTerminalType;
  private readonly serializer: SerializeAddonType = new SerializeAddon();
  private readonly followers = new Set<TerminalFollower>();
  private readonly dataSubscription: IDisposable;
  private readonly exitSubscription: IDisposable;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private sequence = 0;
  private operations: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private controller: { readonly id: string; readonly follower: TerminalFollower } | undefined;
  private exitSettled = false;

  static spawn(prepared: PreparedUserTerminal, view: UserTerminalView, scrollback: number, maxFollowerBytes: number, closeGraceMs: number): DirectUserTerminal {
    const terminal = spawnPty(prepared.executable, [...prepared.args], {
      name: "xterm-256color",
      cols: view.columns,
      rows: view.rows,
      cwd: prepared.cwd,
      env: { ...(prepared.environment ?? process.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    return new DirectUserTerminal(terminal, view, prepared.runtimeDirectory, scrollback, maxFollowerBytes, closeGraceMs);
  }

  constructor(
    private readonly terminal: IPty,
    public view: UserTerminalView,
    private readonly runtimeDirectory: string | undefined,
    scrollback: number,
    private readonly maxFollowerBytes: number,
    private readonly closeGraceMs: number,
  ) {
    this.screen = new HeadlessTerminal({ cols: view.columns, rows: view.rows, scrollback, allowProposedApi: true });
    this.screen.loadAddon(this.serializer);
    this.exited = new Promise(resolve => { this.resolveExited = resolve; });
    this.dataSubscription = terminal.onData(data => { void this.output(data); });
    this.exitSubscription = terminal.onExit(event => { void this.recordExit(event.exitCode); });
  }

  async *follow(id: string, signal: AbortSignal): AsyncIterable<UserTerminalFrame> {
    signal.throwIfAborted();
    const follower = new TerminalFollower(this.maxFollowerBytes);
    const baseline = await this.enqueue(() => {
      signal.throwIfAborted();
      this.controller = { id, follower };
      this.broadcastState();
      const snapshot: UserTerminalFrame = Object.freeze({
        type: "snapshot",
        sequence: this.sequence,
        screen: this.serializer.serialize(),
        terminal: this.view,
        writable: this.view.active,
      });
      this.followers.add(follower);
      return snapshot;
    });
    try {
      yield baseline;
      yield* follower.read(signal);
    } finally {
      this.followers.delete(follower);
      follower.close();
      if (this.controller?.follower === follower) {
        this.controller = undefined;
        this.broadcastState();
      }
    }
  }

  write(id: string, data: string): Promise<void> {
    return this.enqueue(() => { this.requireController(id); this.terminal.write(data); });
  }

  resize(id: string, columns: number, rows: number): Promise<void> {
    return this.enqueue(() => {
      this.requireController(id);
      if (this.view.columns === columns && this.view.rows === rows) return;
      this.terminal.resize(columns, rows);
      this.screen.resize(columns, rows);
      this.view = Object.freeze({ ...this.view, columns, rows });
      this.broadcastState();
    });
  }

  detachFollowers(): void {
    this.controller = undefined;
    for (const follower of this.followers) follower.close();
    this.followers.clear();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (this.view.active) {
        try { this.terminal.kill("SIGTERM"); } catch { /* Process may already have exited. */ }
        await Promise.race([this.exited, delay(this.closeGraceMs)]);
      }
      if (this.view.active) {
        try { this.terminal.kill("SIGKILL"); } catch { /* Process may already have exited. */ }
        await Promise.race([this.exited, delay(this.closeGraceMs)]);
      }
      if (this.view.active) await this.recordExit(undefined);
      await this.operations;
      for (const follower of this.followers) follower.finish();
      this.followers.clear();
      this.dataSubscription.dispose();
      this.exitSubscription.dispose();
      this.screen.dispose();
      await cleanupRuntimeDirectory(this.runtimeDirectory);
    })();
  }

  private requireController(id: string): void {
    if (this.closing !== undefined || !this.view.active) throw new UserTerminalError("not_active", "Terminal has already exited");
    if (this.controller?.id !== id) throw new UserTerminalError("control_unavailable", "Terminal input is controlled by another attachment");
  }

  private async output(data: string): Promise<void> {
    if (!data) return;
    await this.enqueue(async () => {
      await new Promise<void>(resolve => { this.screen.write(data, resolve); });
      const frame: UserTerminalFrame = Object.freeze({ type: "output", sequence: ++this.sequence, data });
      for (const follower of this.followers) follower.push(frame);
    });
  }

  private recordExit(exitCode: number | undefined): Promise<void> {
    if (!this.exitSettled) { this.exitSettled = true; this.resolveExited(); }
    return this.enqueue(() => {
      if (!this.view.active) return;
      this.view = Object.freeze({ ...this.view, active: false, ...(exitCode === undefined ? {} : { exitCode }) });
      this.broadcastState();
    });
  }

  private broadcastState(): void {
    for (const follower of this.followers) follower.push(Object.freeze({
      type: "state",
      terminal: this.view,
      writable: this.view.active && this.controller?.follower === follower,
    }));
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch(() => { /* The caller owns this operation's failure. */ });
    return pending;
  }
}

class TerminalFollower {
  private readonly queue: { readonly frame: UserTerminalFrame; readonly bytes: number }[] = [];
  private bytes = 0;
  private wake: (() => void) | undefined;
  private closed = false;
  private finished = false;
  private failure: Error | undefined;
  constructor(private readonly maxBytes: number) {}
  push(frame: UserTerminalFrame): void {
    if (this.closed || this.finished) return;
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (this.bytes + bytes > this.maxBytes) {
      this.failure = new Error("Terminal output consumer exceeded its buffer; reconnect to recover the current screen");
      this.closed = true; this.wake?.(); return;
    }
    this.queue.push({ frame, bytes }); this.bytes += bytes; this.wake?.();
  }
  finish(): void { this.finished = true; this.wake?.(); }
  close(): void { this.closed = true; this.queue.length = 0; this.bytes = 0; this.wake?.(); }
  async *read(signal: AbortSignal): AsyncIterable<UserTerminalFrame> {
    const abort = (): void => { this.close(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      while (!this.closed) {
        const next = this.queue.shift();
        if (next !== undefined) { this.bytes -= next.bytes; yield next.frame; continue; }
        if (this.finished) break;
        await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
      }
      if (this.failure !== undefined) throw this.failure;
    } finally { signal.removeEventListener("abort", abort); this.close(); }
  }
}

function assertWorkspace(session: SessionTerminals, workspaceRoot: string): void {
  if (session.workspaceRoot !== workspaceRoot) throw new UserTerminalError("not_found", "User Terminal was not found in this workspace");
}
function terminalLabel(value: string | undefined, shell: string): string {
  const label = value?.trim() || shell;
  if (label.length > MAX_LABEL_LENGTH) throw new UserTerminalError("invalid_input", "Terminal label is too long");
  return label;
}
function shellName(prepared: PreparedUserTerminal): string {
  const marker = prepared.args.lastIndexOf("--");
  const executable = marker >= 0 ? prepared.args[marker + 1] : prepared.executable;
  return basename(executable || prepared.executable) || "shell";
}
function dimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 1_000) throw new UserTerminalError("invalid_input", `Terminal ${label} must be between 10 and 1000`);
  return value;
}
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function nonNegativeInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`); return value; }
function throwIfAborted(signal: AbortSignal | undefined): void { signal?.throwIfAborted(); }
function delay(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function cleanupRuntimeDirectory(path: string | undefined): Promise<void> { if (path !== undefined) await rm(path, { recursive: true, force: true }); }

export default LocalUserTerminal;
