import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  RunTmuxCommandRequest,
  TmuxCommandResult,
  TmuxCommandRunner,
} from "../command-runner.js";

const execFilePromise = promisify(execFile);
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Node adapter for tmux CLI calls. It never owns background jobs. */
export class NodeTmuxCommandRunner implements TmuxCommandRunner {
  async run(request: RunTmuxCommandRequest): Promise<TmuxCommandResult> {
    validateRequest(request);
    const result = await execFilePromise(request.executable, [...(request.args ?? [])], {
      encoding: "utf8",
      maxBuffer: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.environment === undefined
        ? {}
        : { env: { ...process.env, ...request.environment } }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
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
