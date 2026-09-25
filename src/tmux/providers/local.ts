import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { registerPluginOwner } from "../../boot/plugin-control/owner-registry.js";
import s from "@deepseek-ai/schemastery";

import type {
  TmuxCommandResult,
  TmuxCommandRunner,
} from "../command-runner.js";
import { NodeTmuxCommandRunner } from "./node-command-runner.js";

import {
  TmuxConflictError,
  type TmuxError,
  TmuxExecutionFailedError,
  TmuxInvalidInputError,
  TmuxNotFoundError,
  TmuxUnavailableError,
} from "../errors.js";
import { TmuxService } from "../service.js";
import type {
  CaptureTmuxPaneRequest,
  ListTmuxSessionsRequest,
  SendTmuxKeysRequest,
  StartTmuxSessionRequest,
  StopTmuxSessionRequest,
  Tmux,
  TmuxSessionMetadata,
  TmuxSessionSnapshot,
  TmuxTarget,
} from "../types.js";

const FIELD_SEPARATOR = "\u001f";
const DEFAULT_CAPTURE_LINES = 200;
const DEFAULT_CAPTURE_MAX_CHARS = 40_000;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const MAX_TEXT_BYTES = 64 * 1024;

export interface LocalTmuxOptions {
  readonly executable?: string;
  readonly socketPath?: string;
  readonly sessionPrefix?: string;
  readonly captureLines?: number;
  readonly captureMaxChars?: number;
  readonly now?: () => string;
}

export interface LocalTmuxBackendOptions extends LocalTmuxOptions {
  readonly runner?: TmuxCommandRunner;
}

/** Loader configuration for the local tmux Provider. */
export interface Config extends Omit<LocalTmuxOptions, "now"> {}

export const Config: s<Config> = s.object({
  executable: s.string(),
  socketPath: s.string(),
  sessionPrefix: s.string(),
  captureLines: s.number().step(1).min(1),
  captureMaxChars: s.number().step(1).min(1),
});

interface ResolvedOptions {
  readonly executable: string;
  readonly socketPath?: string;
  readonly sessionPrefix: string;
  readonly captureLines: number;
  readonly captureMaxChars: number;
}

/** Local CLI implementation with tmux itself as the live-session index. */
export class LocalTmuxBackend implements Tmux {
  private readonly options: ResolvedOptions;
  private readonly runner: TmuxCommandRunner;
  private readonly now: () => string;

  constructor(options: LocalTmuxBackendOptions) {
    this.options = Object.freeze({
      executable: nonEmpty(options.executable ?? "tmux", "tmux executable"),
      ...(options.socketPath === undefined
        ? {}
        : { socketPath: nonEmpty(options.socketPath, "tmux socket path") }),
      sessionPrefix: safeName(options.sessionPrefix ?? "wish", "tmux session prefix"),
      captureLines: positiveInteger(
        options.captureLines ?? DEFAULT_CAPTURE_LINES,
        "tmux capture lines",
      ),
      captureMaxChars: positiveInteger(
        options.captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
        "tmux capture max chars",
      ),
    });
    this.runner = options.runner ?? new NodeTmuxCommandRunner();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(request: StartTmuxSessionRequest): Promise<TmuxSessionSnapshot> {
    validateStart(request);
    throwIfAborted(request.signal);
    const session = `${this.options.sessionPrefix}-${safeName(request.sessionId, "tmux session id")}`;
    const window = safeName(request.windowName, "tmux window name");
    const target = createTarget(session, window, "%0", request.sessionId, this.options);
    const command = request.command;
    const args = [
      ...this.connectionArgs(),
      "new-session",
      "-d",
      "-s",
      session,
      "-n",
      window,
      "-x",
      String(positiveInteger(request.columns ?? DEFAULT_COLUMNS, "tmux columns")),
      "-y",
      String(positiveInteger(request.rows ?? DEFAULT_ROWS, "tmux rows")),
      "-c",
      nonEmpty(command.cwd, "tmux command cwd"),
      ...environmentArgs(command.environment),
      "--",
      command.executable,
      ...(command.args ?? []),
    ];
    let started = false;
    try {
      if (this.options.socketPath !== undefined) {
        await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
      }
      await this.run(args, request.signal);
      started = true;
      await this.run([
        ...this.connectionArgs(),
        "set-option",
        "-p",
        "-t",
        `${session}:${window}.0`,
        "remain-on-exit",
        "on",
      ], request.signal);
      for (const [name, value] of metadataOptions(
        request.sessionId,
        request.metadata,
        this.now(),
      )) {
        await this.run([
          ...this.connectionArgs(),
          "set-option",
          "-t",
          session,
          name,
          value,
        ], request.signal);
      }
      const snapshot = await this.inspect(target, request.signal);
      if (snapshot === undefined) {
        throw new TmuxExecutionFailedError(
          `tmux session ${session} disappeared during startup`,
        );
      }
      return snapshot;
    } catch (cause: unknown) {
      if (started) {
        await this.run([
          ...this.connectionArgs(),
          "kill-session",
          "-t",
          session,
        ]).catch(() => undefined);
      }
      if (cause instanceof TmuxExecutionFailedError) throw cause;
      if (isDuplicateSession(cause)) {
        throw new TmuxConflictError(`tmux session ${session} already exists`, {
          cause,
        });
      }
      throw mapExecutionError(cause, `Failed to start tmux session ${session}`);
    }
  }

  async list(
    request: ListTmuxSessionsRequest = {},
  ): Promise<readonly TmuxSessionSnapshot[]> {
    throwIfAborted(request.signal);
    let output: TmuxCommandResult;
    try {
      output = await this.run([
        ...this.connectionArgs(),
        "list-panes",
        "-a",
        "-F",
        listFormat(),
      ], request.signal);
    } catch (cause: unknown) {
      if (isNoServer(cause)) return Object.freeze([]);
      throw mapExecutionError(cause, "Failed to list tmux sessions");
    }
    const snapshots = output.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseSnapshot(line, this.options))
      .filter((snapshot) =>
        snapshot.target.session.startsWith(`${this.options.sessionPrefix}-`) &&
        (request.workspaceRoot === undefined ||
          snapshot.metadata.workspaceRoot === request.workspaceRoot)
      );
    return Object.freeze(snapshots);
  }

  async inspect(
    target: TmuxTarget,
    signal?: AbortSignal,
  ): Promise<TmuxSessionSnapshot | undefined> {
    validateTarget(target);
    throwIfAborted(signal);
    let output: TmuxCommandResult;
    try {
      output = await this.run([
        ...this.connectionArgs(),
        "list-panes",
        "-t",
        target.target,
        "-F",
        listFormat(),
      ], signal);
    } catch (cause: unknown) {
      if (isMissingTarget(cause) || isNoServer(cause)) return undefined;
      throw mapExecutionError(cause, `Failed to inspect tmux target ${target.target}`);
    }
    const line = output.stdout.split("\n").find((item) => item.length > 0);
    return line === undefined ? undefined : parseSnapshot(line, this.options);
  }

  async capture(request: CaptureTmuxPaneRequest): Promise<string> {
    validateTarget(request.target);
    const lines = positiveInteger(
      request.lines ?? this.options.captureLines,
      "tmux capture lines",
    );
    const maxChars = positiveInteger(
      request.maxChars ?? this.options.captureMaxChars,
      "tmux capture max chars",
    );
    try {
      const output = await this.run([
        ...this.connectionArgs(),
        "capture-pane",
        "-p",
        "-J",
        "-t",
        request.target.target,
        "-S",
        `-${lines}`,
      ], request.signal);
      return output.stdout.length <= maxChars
        ? output.stdout
        : `${output.stdout.slice(-maxChars)}\n[truncated]`;
    } catch (cause: unknown) {
      throw targetError(cause, request.target, "capture");
    }
  }

  async send(request: SendTmuxKeysRequest): Promise<void> {
    validateTarget(request.target);
    if (Buffer.byteLength(request.text, "utf8") > MAX_TEXT_BYTES) {
      throw new TmuxInvalidInputError(
        `tmux input exceeds ${MAX_TEXT_BYTES} bytes`,
      );
    }
    try {
      await this.run([
        ...this.connectionArgs(),
        "send-keys",
        "-t",
        request.target.target,
        "-l",
        request.text,
      ], request.signal);
      if (request.enter !== false) {
        await this.run([
          ...this.connectionArgs(),
          "send-keys",
          "-t",
          request.target.target,
          "Enter",
        ], request.signal);
      }
    } catch (cause: unknown) {
      throw targetError(cause, request.target, "send input to");
    }
  }

  async stop(request: StopTmuxSessionRequest): Promise<void> {
    validateTarget(request.target);
    try {
      await this.run([
        ...this.connectionArgs(),
        "kill-session",
        "-t",
        request.target.session,
      ], request.signal);
    } catch (cause: unknown) {
      if (isMissingTarget(cause) || isNoServer(cause)) return;
      throw mapExecutionError(
        cause,
        `Failed to stop tmux session ${request.target.session}`,
      );
    }
  }

  private connectionArgs(): readonly string[] {
    return this.options.socketPath === undefined
      ? []
      : ["-S", this.options.socketPath];
  }

  private run(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<TmuxCommandResult> {
    return this.runner.run({
      executable: this.options.executable,
      args,
      maxOutputBytes: 2 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

/** Cordis Provider for a local tmux server. */
export class LocalTmux extends TmuxService {
  static readonly Config = Config;
  private readonly backend: LocalTmuxBackend;
  private readonly requests = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private suspended = false;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.backend = new LocalTmuxBackend(config);
    ctx.effect(() => () => this.close(), "tmux.command-admission.close");
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: () => ({
        // Admitted CLI calls are bounded Provider work: a managed change can
        // fence this generation, let those calls finish, and then deactivate it.
        // Only an already-closing generation is unsafe to prepare again.
        disposition: this.closing ? "blocked" : this.requests.size ? "drain" : "direct",
        code: this.closing ? "tmux_closing" : this.requests.size ? "tmux_commands_active" : "tmux_idle",
        counts: { active_requests: this.requests.size },
      }),
      prepare: () => {
        if (this.suspended || this.closing) throw new TmuxUnavailableError("tmux Provider is closed");
        this.suspended = true;
        return {
          drained: Promise.allSettled([...this.requests]).then(() => {}),
          deactivate: () => this.close(),
          release: () => { if (!this.closing) this.suspended = false; },
        };
      },
    });
  }

  start(request: StartTmuxSessionRequest): Promise<TmuxSessionSnapshot> {
    return this.track(() => this.backend.start(request));
  }

  list(request?: ListTmuxSessionsRequest): Promise<readonly TmuxSessionSnapshot[]> {
    return this.track(() => this.backend.list(request));
  }

  inspect(target: TmuxTarget, signal?: AbortSignal): Promise<TmuxSessionSnapshot | undefined> {
    return this.track(() => this.backend.inspect(target, signal));
  }

  capture(request: CaptureTmuxPaneRequest): Promise<string> {
    return this.track(() => this.backend.capture(request));
  }

  send(request: SendTmuxKeysRequest): Promise<void> {
    return this.track(() => this.backend.send(request));
  }

  stop(request: StopTmuxSessionRequest): Promise<void> {
    return this.track(() => this.backend.stop(request));
  }

  private async track<T>(command: () => Promise<T>): Promise<T> {
    if (this.suspended || this.closing) throw new TmuxUnavailableError("tmux Provider is closed");
    const request = Promise.resolve().then(command); this.requests.add(request);
    try { return await request; } finally { this.requests.delete(request); }
  }

  private close(): Promise<void> {
    this.suspended = true;
    // tmux, not this Provider, owns the persistent sessions. Never kill them here.
    return this.closing ??= Promise.allSettled([...this.requests]).then(() => {});
  }
}

function listFormat(): string {
  return [
    "#{session_name}",
    "#{window_name}",
    "#{pane_id}",
    "#{pane_dead}",
    "#{pane_dead_status}",
    "#{pane_current_command}",
    "#{pane_pid}",
    "#{@wish_session_id}",
    "#{@wish_workspace_root}",
    "#{@wish_label}",
    "#{@wish_created_at}",
  ].join(FIELD_SEPARATOR);
}

function metadataOptions(
  sessionId: string,
  metadata: TmuxSessionMetadata,
  createdAt: string,
): readonly (readonly [string, string])[] {
  return Object.freeze([
    ["@wish_session_id", sessionId],
    ["@wish_workspace_root", metadata.workspaceRoot],
    ["@wish_label", metadata.label ?? ""],
    ["@wish_created_at", createdAt],
  ]);
}

function environmentArgs(
  environment: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (environment === undefined) return Object.freeze([]);
  const args: string[] = [];
  for (const name of Object.keys(environment).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new TmuxInvalidInputError(`tmux environment name ${JSON.stringify(name)} is invalid`);
    }
    const value = environment[name];
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TmuxInvalidInputError(`tmux environment value for ${name} is invalid`);
    }
    args.push("-e", `${name}=${value}`);
  }
  return Object.freeze(args);
}

function parseSnapshot(line: string, options: ResolvedOptions): TmuxSessionSnapshot {
  const fields = line.split(FIELD_SEPARATOR);
  if (fields.length !== 11) {
    throw new TmuxExecutionFailedError("tmux returned malformed session metadata");
  }
  const [
    session,
    window,
    pane,
    dead,
    deadStatus,
    currentCommand,
    panePid,
    sessionId,
    workspaceRoot,
    label,
    createdAt,
  ] = fields as [string, string, string, string, string, string, string, string, string, string, string];
  if (sessionId.length === 0 || workspaceRoot.length === 0) {
    throw new TmuxExecutionFailedError("tmux session is missing Wish metadata");
  }
  const target = createTarget(session, window, pane, sessionId, options);
  return Object.freeze({
    target,
    metadata: Object.freeze({
      workspaceRoot,
      ...(label.length === 0 ? {} : { label }),
    }),
    createdAt,
    active: dead !== "1",
    ...(dead !== "1" || deadStatus.length === 0
      ? {}
      : { exitCode: Number.parseInt(deadStatus, 10) }),
    ...(currentCommand.length === 0 ? {} : { currentCommand }),
    ...(panePid.length === 0 ? {} : { panePid: Number.parseInt(panePid, 10) }),
  });
}

function createTarget(
  session: string,
  window: string,
  pane: string,
  sessionId: string,
  options: ResolvedOptions,
): TmuxTarget {
  const target = `${session}:${window}.${pane.startsWith("%") ? "0" : pane}`;
  const prefix = options.socketPath === undefined
    ? shellQuote(options.executable)
    : `${shellQuote(options.executable)} -S ${shellQuote(options.socketPath)}`;
  return Object.freeze({
    sessionId,
    session,
    window,
    pane,
    target,
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    attachCommand: `${prefix} attach-session -t ${shellQuote(session)}`,
    captureCommand: `${prefix} capture-pane -p -J -t ${shellQuote(target)}`,
  });
}

function validateStart(request: StartTmuxSessionRequest): void {
  if (request === null || typeof request !== "object") {
    throw new TmuxInvalidInputError("tmux start request must be an object");
  }
  nonEmpty(request.sessionId, "tmux session id");
  safeName(request.windowName, "tmux window name");
  nonEmpty(request.command.executable, "tmux command executable");
  nonEmpty(request.command.cwd, "tmux command cwd");
  nonEmpty(request.metadata.workspaceRoot, "tmux workspace root");
}

function validateTarget(target: TmuxTarget): void {
  if (target === null || typeof target !== "object") {
    throw new TmuxInvalidInputError("tmux target must be an object");
  }
  safeName(target.session, "tmux target session");
  safeName(target.window, "tmux target window");
  nonEmpty(target.target, "tmux target");
}

function safeName(value: string, label: string): string {
  const normalized = nonEmpty(value, label).replace(/[^A-Za-z0-9_-]+/gu, "-");
  const trimmed = normalized.replace(/^-+|-+$/gu, "");
  if (trimmed.length === 0 || trimmed.length > 96) {
    throw new TmuxInvalidInputError(`${label} must produce 1-96 safe characters`);
  }
  return trimmed;
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TmuxInvalidInputError(`${label} must not be empty`);
  }
  return value.trim();
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TmuxInvalidInputError(`${label} must be a positive integer`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("tmux operation aborted");
}

function targetError(cause: unknown, target: TmuxTarget, operation: string): TmuxError {
  if (isMissingTarget(cause) || isNoServer(cause)) {
    return new TmuxNotFoundError(`tmux target ${target.target} was not found`, { cause });
  }
  return mapExecutionError(cause, `Failed to ${operation} tmux target ${target.target}`);
}

function mapExecutionError(cause: unknown, message: string): TmuxError {
  if (isCommandNotFound(cause)) return new TmuxUnavailableError(message, { cause });
  return new TmuxExecutionFailedError(`${message}: ${errorMessage(cause)}`, { cause });
}

function isCommandNotFound(cause: unknown): boolean {
  return errorCode(cause) === "ENOENT";
}

function isDuplicateSession(cause: unknown): boolean {
  return errorMessage(cause).includes("duplicate session");
}

function isNoServer(cause: unknown): boolean {
  const message = errorMessage(cause);
  return message.includes("no server running") || message.includes("failed to connect to server");
}

function isMissingTarget(cause: unknown): boolean {
  const message = errorMessage(cause);
  return message.includes("can't find") || message.includes("can't find pane") || message.includes("can't find session");
}

function errorCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const stderr = "stderr" in cause && typeof cause.stderr === "string"
      ? cause.stderr.trim()
      : "";
    return stderr.length === 0 ? cause.message : stderr;
  }
  return String(cause);
}

export default LocalTmux;
