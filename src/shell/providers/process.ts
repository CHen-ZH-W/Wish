import { spawn, type ChildProcess } from "node:child_process";

import { ShellExecutionFailedError } from "../errors.js";
import type { ShellExecutionResult } from "../types.js";

export interface SpawnShellProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutSeconds: number;
  readonly onData: (data: Uint8Array) => void;
  readonly signal?: AbortSignal;
}

const FORCE_KILL_GRACE_MS = 1_000;

/** Shared child-process lifecycle; policy resolution remains Provider-owned. */
export function spawnShellProcess(
  request: SpawnShellProcessRequest,
): Promise<ShellExecutionResult> {
  throwIfAborted(request.signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause: unknown) {
      rejectPromise(new ShellExecutionFailedError(
        `Failed to start Shell process: ${errorMessage(cause)}`,
        { cause },
      ));
      return;
    }

    let settled = false;
    let termination: ShellExecutionResult["termination"];
    let forcedKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => terminate("timeout"),
      request.timeoutSeconds * 1_000);
    timeout.unref();

    const finish = (
      action: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      request.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const terminate = (reason: "timeout" | "aborted"): void => {
      if (termination !== undefined) return;
      termination = reason;
      terminateChild(child, "SIGTERM");
      forcedKill = setTimeout(() => terminateChild(child, "SIGKILL"),
        FORCE_KILL_GRACE_MS);
      forcedKill.unref();
    };
    const onAbort = (): void => terminate("aborted");
    const emit = (data: Buffer): void => {
      try {
        request.onData(new Uint8Array(data));
      } catch (cause: unknown) {
        terminateChild(child, "SIGKILL");
        finish(() => rejectPromise(new ShellExecutionFailedError(
          `Shell output consumer failed: ${errorMessage(cause)}`,
          { cause },
        )));
      }
    };

    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.once("error", (cause) => finish(() => rejectPromise(
      new ShellExecutionFailedError(
        `Shell process failed: ${cause.message}`,
        { cause },
      ),
    )));
    child.once("close", (exitCode) => finish(() => resolvePromise(Object.freeze({
      exitCode,
      ...(termination === undefined ? {} : { termination }),
    }))));

    if (request.signal?.aborted === true) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Shell operation was aborted", { cause: signal.reason });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
