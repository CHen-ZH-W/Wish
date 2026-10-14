import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { UserTerminalError } from "../errors.js";
import type { UserTerminalShellChoice } from "../types.js";

const DEFAULT_SHELLS = ["/bin/bash", "/bin/zsh", "/bin/fish", "/bin/sh"] as const;

export interface PreparedUserTerminal {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly runtimeDirectory?: string;
}

export interface HostUserTerminalRuntimeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly shellCandidates?: readonly string[];
}

/** Host-user Shell preparation owned by User Terminal, never by the Agent Shell sandbox. */
export class HostUserTerminalRuntime {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly shellCandidates: readonly string[];

  constructor(options: HostUserTerminalRuntimeOptions = {}) {
    this.environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.shellCandidates = Object.freeze(uniqueShells([
      this.environment.SHELL,
      ...(options.shellCandidates ?? DEFAULT_SHELLS),
    ]));
  }

  async listShells(signal?: AbortSignal): Promise<readonly UserTerminalShellChoice[]> {
    throwIfAborted(signal);
    const choices: UserTerminalShellChoice[] = [];
    for (const path of this.shellCandidates) {
      throwIfAborted(signal);
      try {
        await access(path, constants.X_OK);
        choices.push(Object.freeze({ path, name: basename(path) }));
      } catch { /* Only executable host Shells are exposed. */ }
    }
    if (choices.length === 0) throw new UserTerminalError("unavailable", "No interactive Shell is installed in the host environment");
    return Object.freeze(choices);
  }

  async prepare(workspaceRoot: string, shellPath: string | undefined, sessionId: string, signal?: AbortSignal): Promise<PreparedUserTerminal> {
    throwIfAborted(signal);
    const shells = await this.listShells(signal);
    const selected = shellPath === undefined ? shells[0] : shells.find(shell => shell.path === shellPath);
    if (selected === undefined) throw new UserTerminalError("invalid_input", "Selected interactive Shell is unavailable");
    const environment = Object.freeze({
      ...definedEnvironment(this.environment),
      SHELL: selected.path,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      WISH_SESSION_ID: sessionId,
    });
    if (selected.name !== "bash") {
      return Object.freeze({ executable: selected.path, args: Object.freeze(["-i"]), cwd: workspaceRoot, environment });
    }

    const runtimeDirectory = await mkdtemp(join(tmpdir(), "wish-user-terminal-"));
    try {
      const bashRc = join(runtimeDirectory, "bashrc");
      await writeFile(bashRc, [
        "# Wish host User Terminal: preserve the system user's ordinary Bash startup.",
        "[[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc",
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
      throwIfAborted(signal);
      return Object.freeze({
        executable: selected.path,
        args: Object.freeze(["--rcfile", bashRc, "-i"]),
        cwd: workspaceRoot,
        environment,
        runtimeDirectory,
      });
    } catch (error) {
      await rm(runtimeDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

function uniqueShells(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && isAbsolute(value) && value.length > 1))];
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function throwIfAborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
