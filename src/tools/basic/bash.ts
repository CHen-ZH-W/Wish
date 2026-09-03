import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { stat as fsStat, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type {
  ToolDefinition,
  ToolInputParseResult,
  ToolResultArtifact,
} from "../../core/tools/tool.js";
import type { BasicToolContext } from "../support/context.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "../support/truncate.js";

export interface BashToolInput {
  readonly command: string;
  /** Timeout in seconds. Omitted means no Tool-level timeout. */
  readonly timeout?: number;
}

export interface BashToolOutput {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly exitCode: number | null;
  readonly truncation?: TruncationResult;
  readonly artifact?: ToolResultArtifact;
}

export interface BashExecutionResult {
  readonly exitCode: number | null;
  readonly termination?: "timeout" | "aborted";
}

export interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      readonly onData: (data: Buffer) => void;
      readonly signal?: AbortSignal;
      readonly timeout?: number;
      readonly env?: NodeJS.ProcessEnv;
    },
  ): Promise<BashExecutionResult>;
}

export interface LocalBashOperationsOptions {
  readonly shellPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BashToolOptions {
  readonly operations?: BashOperations;
}

interface RenderedBashOutput {
  readonly text: string;
  readonly truncation?: TruncationResult;
  readonly artifact?: ToolResultArtifact;
}

const BASH_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "Shell command to execute",
    },
    timeout: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Optional timeout in seconds; omitted means no timeout",
    },
  },
  required: ["command"],
  additionalProperties: false,
});

const PROCESS_EXIT_GRACE_MS = 100;
const ROLLING_OUTPUT_BYTES = DEFAULT_MAX_BYTES * 2;

export function createBashTool(
  options: BashToolOptions = {},
): ToolDefinition<"bash", BashToolInput, BashToolOutput, BasicToolContext> {
  const operations = options.operations ?? createLocalBashOperations();
  return {
    name: "bash",
    description:
      `Execute a shell command in the current working directory. Combined stdout and stderr are limited to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; truncated output is stored as a temporary artifact.`,
    inputSchemaJson: BASH_INPUT_SCHEMA,
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse: parseBashInput,
    resolveCapabilities() {
      return {
        requirements: [{ capability: "process.exec" }],
      };
    },
    async execute(input, context, grant, signal) {
      throwIfAborted(signal);
      assertExecGrant(grant);
      const collector = new BashOutputCollector();
      let execution: BashExecutionResult;
      try {
        execution = await operations.exec(input.command, context.cwd, {
          onData: (data) => collector.append(data),
          ...(signal === undefined ? {} : { signal }),
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        });
      } catch (error: unknown) {
        if (signal?.aborted === true) {
          await collector.discardArtifact();
          throw abortReason(signal);
        }
        const rendered = await collector.render(
          `Command failed: ${errorMessage(error)}`,
        );
        throw bashFailure("execution_failed", rendered, {
          cause: errorMessage(error),
        });
      }

      if (signal?.aborted === true) {
        await collector.discardArtifact();
        throw abortReason(signal);
      }
      try {
        validateExecutionResult(execution);
      } catch (error: unknown) {
        const rendered = await collector.render(errorMessage(error));
        throw bashFailure("execution_failed", rendered, {
          cause: errorMessage(error),
        });
      }
      if (execution.termination === "aborted") {
        const rendered = await collector.render("Command aborted");
        throw bashFailure("aborted", rendered);
      }
      if (execution.termination === "timeout") {
        const timeoutText = input.timeout === undefined
          ? "Command timed out"
          : `Command timed out after ${input.timeout} seconds`;
        const rendered = await collector.render(timeoutText);
        throw bashFailure("timeout", rendered, {
          ...(input.timeout === undefined ? {} : { timeoutSeconds: input.timeout }),
        });
      }
      if (execution.exitCode !== null && execution.exitCode !== 0) {
        const rendered = await collector.render(
          `Command exited with code ${execution.exitCode}`,
        );
        throw bashFailure("execution_failed", rendered, {
          exitCode: execution.exitCode,
        });
      }

      const rendered = await collector.render();
      return {
        content: [{ type: "text", text: rendered.text }],
        exitCode: execution.exitCode,
        ...(rendered.truncation === undefined
          ? {}
          : { truncation: rendered.truncation }),
        ...(rendered.artifact === undefined ? {} : { artifact: rendered.artifact }),
      };
    },
  };
}

export function createLocalBashOperations(
  options: LocalBashOperationsOptions = {},
): BashOperations {
  return {
    async exec(command, cwd, executionOptions) {
      throwIfAborted(executionOptions.signal);
      const cwdStat = await fsStat(cwd);
      if (!cwdStat.isDirectory()) {
        throw Object.assign(new Error(`Working directory is not a directory: ${cwd}`), {
          code: "ENOTDIR",
        });
      }
      throwIfAborted(executionOptions.signal);

      const shell = resolveShell(options.shellPath);
      const child = spawn(shell, ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        env: executionOptions.env ?? options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", executionOptions.onData);
      child.stderr.on("data", executionOptions.onData);

      let termination: BashExecutionResult["termination"];
      let cancelTimeout: (() => void) | undefined;
      const terminate = (reason: "timeout" | "aborted"): void => {
        if (termination !== undefined) return;
        termination = reason;
        if (child.pid !== undefined) killProcessTree(child.pid);
      };
      const onAbort = (): void => terminate("aborted");
      if (executionOptions.signal !== undefined) {
        executionOptions.signal.addEventListener("abort", onAbort, { once: true });
        if (executionOptions.signal.aborted) onAbort();
      }
      if (executionOptions.timeout !== undefined) {
        cancelTimeout = scheduleLongTimeout(
          executionOptions.timeout,
          () => terminate("timeout"),
        );
      }

      try {
        const exitCode = await waitForChildProcess(child);
        return {
          exitCode,
          ...(termination === undefined ? {} : { termination }),
        };
      } finally {
        cancelTimeout?.();
        executionOptions.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function parseBashInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<BashToolInput> {
  const unsupported = Object.keys(input).find(
    (key) => key !== "command" && key !== "timeout",
  );
  if (unsupported !== undefined) {
    return {
      ok: false,
      message: `Bash input contains unsupported field "${unsupported}"`,
    };
  }
  if (typeof input.command !== "string") {
    return { ok: false, message: "Bash command must be a string" };
  }
  if (
    input.timeout !== undefined &&
    (typeof input.timeout !== "number" ||
      !Number.isFinite(input.timeout) ||
      input.timeout <= 0)
  ) {
    return { ok: false, message: "Bash timeout must be a positive number" };
  }
  return {
    ok: true,
    input: {
      command: input.command,
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    },
  };
}

class BashOutputCollector {
  private readonly chunks: Buffer[] = [];
  private chunksBytes = 0;
  private totalBytes = 0;
  private totalNewlines = 0;
  private artifactPath: string | undefined;
  private artifactStream: WriteStream | undefined;
  private artifactError: Error | undefined;
  private finalized = false;

  append(data: Buffer): void {
    if (this.finalized || data.length === 0) return;
    const chunk = Buffer.from(data);
    this.totalBytes += chunk.length;
    this.totalNewlines += countNewlines(chunk);

    if (this.artifactStream === undefined) {
      this.chunks.push(chunk);
      this.chunksBytes += chunk.length;
      if (this.totalBytes > DEFAULT_MAX_BYTES) this.startArtifact();
    } else {
      this.artifactStream.write(chunk);
      this.chunks.push(chunk);
      this.chunksBytes += chunk.length;
    }
    this.trimRollingChunks();
  }

  async render(terminalLine?: string): Promise<RenderedBashOutput> {
    if (this.finalized) throw new Error("Bash output was already finalized");
    this.finalized = true;
    const rollingText = Buffer.concat(this.chunks).toString("utf8");
    const totalLines = this.totalNewlines + 1;
    const noOutputText = this.totalBytes === 0 ? "(no output)" : rollingText;
    const terminalSuffix = terminalLine === undefined ? "" : `\n\n${terminalLine}`;
    const completeText = noOutputText + terminalSuffix;
    const needsTruncation = totalLines > DEFAULT_MAX_LINES ||
      Buffer.byteLength(completeText, "utf8") > DEFAULT_MAX_BYTES;

    if (!needsTruncation) {
      await this.finishArtifact(false);
      return { text: completeText };
    }

    const artifact = await this.finishArtifact(true);
    const truncationNotice = artifact === undefined
      ? `[Output truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Full output artifact unavailable.]`
      : `[Output truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${artifact.locator}]`;
    const suffix = `\n\n${truncationNotice}${terminalSuffix}`;
    const availableBytes = Math.max(
      1,
      DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"),
    );
    const visibleTail = truncateTail(rollingText, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: availableBytes,
    });
    const truncation: TruncationResult = {
      ...visibleTail,
      truncated: true,
      truncatedBy: visibleTail.truncated
        ? visibleTail.truncatedBy
        : totalLines > DEFAULT_MAX_LINES
          ? "lines"
          : "bytes",
      totalLines,
      totalBytes: this.totalBytes,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };
    const text = visibleTail.content + suffix;
    if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES) {
      throw new Error("Bash output exceeded its byte limit");
    }
    return {
      text,
      truncation,
      ...(artifact === undefined ? {} : { artifact }),
    };
  }

  async discardArtifact(): Promise<void> {
    this.finalized = true;
    await this.finishArtifact(false);
    if (this.artifactPath === undefined) return;
    try {
      await fsUnlink(this.artifactPath);
    } catch {
      // Best effort: an aborted Tool must not fail while discarding diagnostics.
    }
  }

  private startArtifact(): void {
    if (this.artifactStream !== undefined) return;
    this.artifactPath = join(
      tmpdir(),
      `wish-bash-${randomBytes(8).toString("hex")}.log`,
    );
    const stream = createWriteStream(this.artifactPath, {
      flags: "wx",
      mode: 0o600,
    });
    this.artifactStream = stream;
    stream.on("error", (error) => {
      this.artifactError = error;
    });
    for (const chunk of this.chunks) stream.write(chunk);
  }

  private trimRollingChunks(): void {
    while (
      this.chunksBytes > ROLLING_OUTPUT_BYTES &&
      this.chunks.length > 1
    ) {
      const removed = this.chunks.shift();
      if (removed === undefined) break;
      this.chunksBytes -= removed.length;
    }
  }

  private async finishArtifact(
    required: boolean,
  ): Promise<ToolResultArtifact | undefined> {
    if (required && this.artifactStream === undefined) this.startArtifact();
    const stream = this.artifactStream;
    const path = this.artifactPath;
    if (stream === undefined || path === undefined) return undefined;

    await finishWriteStream(stream);
    if (this.artifactError !== undefined) {
      try {
        await fsUnlink(path);
      } catch {
        // The failed stream may never have created a file.
      }
      return undefined;
    }
    return {
      kind: "file",
      locator: path,
      metadata: {
        mediaType: "text/plain;charset=utf-8",
        bytes: this.totalBytes,
      },
    };
  }
}

function bashFailure(
  code: "aborted" | "timeout" | "execution_failed",
  rendered: RenderedBashOutput,
  details: Readonly<Record<string, unknown>> = {},
): ToolExecutionError {
  return new ToolExecutionError(code, rendered.text, false, {
    ...details,
    output: rendered.text,
    ...(rendered.truncation === undefined
      ? {}
      : { truncation: rendered.truncation }),
    ...(rendered.artifact === undefined ? {} : { artifact: rendered.artifact }),
  });
}

function validateExecutionResult(result: BashExecutionResult): void {
  if (
    result === null ||
    typeof result !== "object" ||
    (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) ||
    (result.termination !== undefined &&
      result.termination !== "timeout" &&
      result.termination !== "aborted")
  ) {
    throw new ToolExecutionError(
      "execution_failed",
      "Bash operations returned an invalid execution result",
    );
  }
}

function assertExecGrant(
  grant: ToolAuthorizationGrant,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName: "bash" });
  const authorized = grant.capabilities.requirements.some((requirement) =>
    requirement.capability === "process.exec"
  );
  if (!authorized) {
    throw new Error(
      `Tool authorization Grant ${grant.grantId} does not allow executing this command`,
    );
  }
}

function resolveShell(shellPath: string | undefined): string {
  if (shellPath !== undefined && shellPath.length > 0) return shellPath;
  if (process.platform === "win32") return "bash.exe";
  if (existsSync("/bin/bash")) return "/bin/bash";
  return process.env.SHELL || "sh";
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    } catch {
      // The process may already have exited.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;
    let graceHandle: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (graceHandle !== undefined) clearTimeout(graceHandle);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise(code);
    };
    const maybeFinish = (): void => {
      if (exited && stdoutEnded && stderrEnded) finish(exitCode);
    };
    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = (): void => {
      stderrEnded = true;
      maybeFinish();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      maybeFinish();
      if (!settled) {
        graceHandle = setTimeout(
          () => finish(code),
          PROCESS_EXIT_GRACE_MS,
        );
      }
    };
    const onClose = (code: number | null): void => finish(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/** Avoids Node's timer-overflow behavior for timeouts longer than about 24 days. */
function scheduleLongTimeout(
  seconds: number,
  onTimeout: () => void,
): () => void {
  const maximumDelaySeconds = 2_147_483_647 / 1000;
  let remainingSeconds = seconds;
  let handle: NodeJS.Timeout | undefined;
  let cancelled = false;
  const schedule = (): void => {
    const delaySeconds = Math.min(remainingSeconds, maximumDelaySeconds);
    handle = setTimeout(() => {
      remainingSeconds -= delaySeconds;
      if (remainingSeconds <= 0) onTimeout();
      else if (!cancelled) schedule();
    }, delaySeconds * 1000);
  };
  schedule();
  return () => {
    cancelled = true;
    if (handle !== undefined) clearTimeout(handle);
  };
}

function finishWriteStream(stream: WriteStream): Promise<void> {
  if (stream.writableFinished || stream.destroyed) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("finish", finish);
      stream.removeListener("error", finish);
      resolvePromise();
    };
    stream.once("finish", finish);
    stream.once("error", finish);
    stream.end();
  });
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Operation aborted",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}
