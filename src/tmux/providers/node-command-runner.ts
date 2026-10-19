import { spawn } from "node:child_process";

import type {
  RunTmuxCommandRequest,
  TmuxCommandResult,
  TmuxCommandRunner,
} from "../command-runner.js";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PIPE_CLOSE_GRACE_MS = 100;

/** A tmux server may inherit the CLI's pipes. The CLI exit, not pipe EOF, ends a command. */
export class NodeTmuxCommandRunner implements TmuxCommandRunner {
  async run(request: RunTmuxCommandRequest): Promise<TmuxCommandResult> {
    validateRequest(request);
    const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...(request.args ?? [])], {
        stdio: ["ignore", "pipe", "pipe"],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.environment === undefined
          ? {}
          : { env: { ...process.env, ...request.environment } }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (error !== undefined) { reject(error); return; }
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (exited?.code !== 0) {
          reject(Object.assign(new Error(`${request.executable} exited with ${exited?.signal ?? exited?.code}: ${err.trim()}`), {
            code: exited?.code,
            signal: exited?.signal,
            stdout: out,
            stderr: err,
          }));
          return;
        }
        resolve(Object.freeze({ stdout: out, stderr: err }));
      };
      const collect = (chunks: Buffer[], chunk: Buffer, bytes: number): number => {
        const next = bytes + chunk.length;
        if (next > limit) {
          child.kill();
          finish(Object.assign(new Error("tmux command output exceeded maxOutputBytes"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }));
        } else chunks.push(chunk);
        return next;
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
      child.stderr?.on("data", (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
      child.once("error", finish);
      child.once("exit", (code, signal) => {
        if (settled) return;
        exited = { code, signal };
        // Normal children close their pipes immediately. A detached tmux server
        // can retain them indefinitely, so bound the wait for the final bytes.
        timer = setTimeout(() => finish(), PIPE_CLOSE_GRACE_MS);
      });
      child.once("close", () => { if (exited !== undefined) finish(); });
    });
  }
}

function validateRequest(request: RunTmuxCommandRequest): void {
  if (request === null || typeof request !== "object") {
    throw new TypeError("Tmux command request must be an object");
  }
  if (
    typeof request.executable !== "string" ||
    request.executable.trim().length === 0 ||
    request.executable.includes("\0")
  ) {
    throw new TypeError("Tmux executable must be non-empty text without null bytes");
  }
  for (const argument of request.args ?? []) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new TypeError("Tmux arguments must be text without null bytes");
    }
  }
  if (
    request.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1)
  ) {
    throw new TypeError("Tmux maxOutputBytes must be a positive safe integer");
  }
}

export default NodeTmuxCommandRunner;
