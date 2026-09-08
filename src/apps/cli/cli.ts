import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ModelEnvironment } from "../../models/types.js";
import type { Session } from "../../sessions/types.js";
import {
  createWishHostApplication,
  loadWishHostConfiguration,
  type CreateWishHostApplicationInput,
  type LoadWishHostConfigurationInput,
  type WishHostConfiguration,
} from "../config.js";
import type {
  WishApplication,
  WishRunCompletion,
} from "../types.js";
import {
  parseWishCliArguments,
  WISH_CLI_HELP,
  WishCliUsageError,
  type WishCliArguments,
} from "./args.js";
import { CliToolApprovalPort } from "./approval.js";
import {
  formatWishCliControlReceipt,
  parseWishCliActiveInput,
} from "./control.js";
import { CliInputCoordinator } from "./input.js";
import { WishCliEventRenderer } from "./renderer.js";
import type { WishCliTerminal } from "./terminal.js";

export const WISH_CLI_VERSION = "0.1.0";
export const WISH_CLI_INTERRUPT_TIMEOUT_MS = 5_000;

export type WishCliInterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export type WishCliApplicationFactory = (
  configuration: WishHostConfiguration,
  input: CreateWishHostApplicationInput,
) => WishApplication;

export interface WishCliDependencies {
  readonly terminal: WishCliTerminal;
  readonly cwd?: () => string;
  readonly homeDirectory?: () => string;
  readonly environment?: ModelEnvironment;
  readonly loadHostConfiguration?: (
    input: LoadWishHostConfigurationInput,
  ) => Promise<WishHostConfiguration>;
  readonly createApplication?: WishCliApplicationFactory;
  readonly forceExit?: (code: number) => void;
  readonly interruptTimeoutMs?: number;
}

export interface WishCli {
  run(argv: readonly string[]): Promise<number>;
  interrupt(signal: WishCliInterruptSignal): void;
}

/** Create one line-oriented CLI host around the shared WishApplication. */
export function createWishCli(dependencies: WishCliDependencies): WishCli {
  return new DefaultWishCli(dependencies);
}

class DefaultWishCli implements WishCli {
  private readonly terminal: WishCliTerminal;
  private readonly cwd: () => string;
  private readonly homeDirectory: () => string;
  private readonly environment: ModelEnvironment;
  private readonly loadConfiguration: NonNullable<
    WishCliDependencies["loadHostConfiguration"]
  >;
  private readonly createApplication: WishCliApplicationFactory;
  private readonly forceExit: (code: number) => void;
  private readonly interruptTimeoutMs: number;
  private readonly input: CliInputCoordinator;
  private application: WishApplication | undefined;
  private activeRunId: string | undefined;
  private interruptPending = false;
  private terminateRequested = false;
  private terminationCode = 0;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(dependencies: WishCliDependencies) {
    this.terminal = dependencies.terminal;
    this.cwd = dependencies.cwd ?? (() => process.cwd());
    this.homeDirectory = dependencies.homeDirectory ?? homedir;
    this.environment = dependencies.environment ?? process.env;
    this.loadConfiguration = dependencies.loadHostConfiguration ??
      loadWishHostConfiguration;
    this.createApplication = dependencies.createApplication ??
      createWishHostApplication;
    this.forceExit = dependencies.forceExit ?? ((code) => process.exit(code));
    this.interruptTimeoutMs = positiveInteger(
      dependencies.interruptTimeoutMs ?? WISH_CLI_INTERRUPT_TIMEOUT_MS,
      "CLI interrupt timeout",
    );
    this.input = new CliInputCoordinator(
      this.terminal,
      new CliToolApprovalPort({ terminal: this.terminal }),
    );
    this.terminal.setInterruptHandler?.(() => this.interrupt("SIGINT"));
  }

  async run(argv: readonly string[]): Promise<number> {
    if (this.running) throw new Error("Wish CLI can run only once");
    this.running = true;
    const args = parseWishCliArguments(argv);
    if (args.command === "help") {
      await this.terminal.writeOutput(WISH_CLI_HELP);
      return 0;
    }
    if (args.command === "version") {
      await this.terminal.writeOutput(`wish ${WISH_CLI_VERSION}\n`);
      return 0;
    }
    if (args.command === "interactive" && !this.terminal.interactive) {
      throw new WishCliUsageError(
        "Interactive mode requires a TTY; use \"wish run\" for piped input",
      );
    }

    const launchDirectory = resolve(this.cwd());
    const configuration = await this.loadConfiguration({
      ...(args.dataDirectory === undefined
        ? {}
        : { dataDirectory: resolve(launchDirectory, args.dataDirectory) }),
      homeDirectory: this.homeDirectory(),
      ...(args.modelsConfigurationPath === undefined
        ? {}
        : {
            modelsConfigurationPath: resolve(
              launchDirectory,
              args.modelsConfigurationPath,
            ),
          }),
      environment: this.environment,
    });
    if (this.terminateRequested) return this.terminationCode;
    this.application = this.createApplication(configuration, {
      approval: this.input.approval,
    });

    return args.command === "run"
      ? this.runOnce(args, launchDirectory)
      : this.runInteractive(args, launchDirectory);
  }

  interrupt(signal: WishCliInterruptSignal): void {
    const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
    if (this.interruptPending) {
      this.clearForceTimer();
      this.forceExit(exitCode);
      return;
    }

    if (this.activeRunId !== undefined && this.application !== undefined) {
      this.interruptPending = true;
      if (signal !== "SIGINT") {
        this.terminateRequested = true;
        this.terminationCode = exitCode;
      }
      try {
        this.application.controlRun(this.activeRunId, {
          type: "abort",
          source: "wish-cli-signal",
          reason: `Wish CLI received ${signal}`,
        });
      } catch {
        this.forceExit(exitCode);
        return;
      }
      void this.terminal.writeError(
        `\n[run] abort requested by ${signal}; send the signal again to force exit\n`,
      ).catch(() => {});
      this.forceTimer = setTimeout(() => this.forceExit(exitCode), this.interruptTimeoutMs);
      this.forceTimer.unref?.();
      return;
    }

    this.terminateRequested = true;
    this.terminationCode = exitCode;
    this.terminal.close();
  }

  private async runOnce(
    args: WishCliArguments,
    launchDirectory: string,
  ): Promise<number> {
    const prompt = await this.resolveOneShotPrompt(args);
    if (this.terminateRequested) return this.terminationCode;
    const session = await this.resolveSession(args, launchDirectory, prompt);
    await this.describeSession(session);
    const exitCode = await this.runMessage(session, prompt, args);
    return this.terminateRequested ? this.terminationCode : exitCode;
  }

  private async runInteractive(
    args: WishCliArguments,
    launchDirectory: string,
  ): Promise<number> {
    let session = args.sessionId === undefined
      ? undefined
      : await this.requireActiveSession(args.sessionId);
    let workspaceRoot = session?.scope;
    if (session === undefined) {
      workspaceRoot = await requireWorkspaceDirectory(
        args.workspaceRoot ?? launchDirectory,
      );
      await this.terminal.writeError(`Workspace: ${workspaceRoot}\n`);
    } else {
      await this.describeSession(session);
    }
    await this.terminal.writeError(
      "Wish interactive CLI. Use /help for commands and Ctrl+D to exit.\n",
    );

    while (!this.terminateRequested) {
      const input = await this.terminal.readLine("wish> ");
      if (input === undefined) break;
      const text = input.trim();
      if (text.length === 0) continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        await this.terminal.writeError(
          "/help shows this message; /exit and /quit close the idle CLI.\n" +
          "During a Run, ordinary input and /steer add the next Step; " +
          "/follow-up queues a UserTurn; /abort cancels the Run.\n",
        );
        continue;
      }
      if (session === undefined) {
        session = await this.requireApplication().createSession({
          workspaceRoot: requireDefined(workspaceRoot, "CLI workspace"),
          title: args.title ?? titleFromPrompt(text),
        });
        await this.describeSession(session);
      }
      await this.runMessage(session, text, args);
    }
    return this.terminateRequested ? this.terminationCode : 0;
  }

  private async runMessage(
    session: Session,
    text: string,
    args: WishCliArguments,
  ): Promise<number> {
    const application = this.requireApplication();
    const handle = await application.startRun({
      sessionId: session.sessionId,
      payload: {
        text,
        ...(args.model === undefined ? {} : { model: args.model }),
      },
      metadata: Object.freeze({ source: "wish-cli" }),
    });
    this.activeRunId = handle.runId;
    const renderer = new WishCliEventRenderer(this.terminal);
    const controlStop = new AbortController();
    let completion: WishRunCompletion;
    try {
      const completionPromise = handle.completion.finally(() => {
        controlStop.abort("Run reached a terminal state");
      });
      [completion] = await Promise.all([
        completionPromise,
        renderer.render(application.observeRun(handle.runId)),
        this.terminal.interactive
          ? this.readActiveRunControls(handle.runId, controlStop.signal)
          : Promise.resolve(),
      ]);
    } catch (error: unknown) {
      try {
        application.controlRun(handle.runId, {
          type: "abort",
          source: "wish-cli-renderer",
          reason: "CLI could not continue observing the Run",
        });
      } catch {
        // Preserve the original observer/rendering error.
      }
      throw error;
    } finally {
      controlStop.abort("CLI stopped observing the active Run");
      await renderer.finish();
      this.activeRunId = undefined;
      this.interruptPending = false;
      this.clearForceTimer();
    }

    if (completion.status === "completed") return 0;
    if (completion.status === "failed") {
      await this.terminal.writeError(
        `[run] failed (${completion.error.code}): ${completion.error.message}\n`,
      );
      return 1;
    }
    await this.terminal.writeError(
      `[run] aborted: ${completion.cancellation.reason}\n`,
    );
    return 130;
  }

  private async readActiveRunControls(
    runId: string,
    stopSignal: AbortSignal,
  ): Promise<void> {
    const application = this.requireApplication();
    while (!stopSignal.aborted) {
      const input = await this.input.readControlLine(
        "wish [running: Enter=steer, /follow-up, /abort]> ",
        stopSignal,
      );
      if (input.type === "stopped" || input.type === "eof") return;
      if (input.type === "approval") continue;
      const parsed = parseWishCliActiveInput(input.line);
      if (parsed.type === "empty") continue;
      if (parsed.type === "help") {
        await this.terminal.writeError(
          "During a Run, ordinary input and /steer add the next Step; " +
          "/follow-up queues a new UserTurn; /abort cancels the Run.\n",
        );
        continue;
      }
      if (parsed.type === "invalid") {
        await this.terminal.writeError(`[control] ${parsed.message}\n`);
        continue;
      }
      try {
        const receipt = application.controlRun(runId, parsed.control);
        await this.terminal.writeError(formatWishCliControlReceipt(receipt));
        if (
          parsed.control.type === "abort" && receipt.accepted
        ) return;
      } catch (error: unknown) {
        await this.terminal.writeError(
          `[control] failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  private async resolveOneShotPrompt(args: WishCliArguments): Promise<string> {
    const prompt = args.prompt ?? (
      this.terminal.interactive ? undefined : await this.terminal.readAll()
    );
    if (prompt === undefined || prompt.trim().length === 0) {
      throw new WishCliUsageError(
        "wish run requires a prompt argument or non-empty piped stdin",
      );
    }
    return prompt.trim();
  }

  private async resolveSession(
    args: WishCliArguments,
    launchDirectory: string,
    prompt: string,
  ): Promise<Session> {
    if (args.sessionId !== undefined) {
      return this.requireActiveSession(args.sessionId);
    }
    const workspaceRoot = await requireWorkspaceDirectory(
      args.workspaceRoot ?? launchDirectory,
    );
    return this.requireApplication().createSession({
      workspaceRoot,
      title: args.title ?? titleFromPrompt(prompt),
    });
  }

  private async requireActiveSession(sessionId: string): Promise<Session> {
    const session = await this.requireApplication().getSession({ sessionId });
    if (session.status !== "active") {
      throw new WishCliUsageError(`Session is not active: ${session.sessionId}`);
    }
    return session;
  }

  private async describeSession(session: Session): Promise<void> {
    await this.terminal.writeError(
      `Session: ${session.sessionId}\nWorkspace: ${session.scope}\n`,
    );
  }

  private requireApplication(): WishApplication {
    if (this.application === undefined) {
      throw new Error("Wish CLI Application is not initialized");
    }
    return this.application;
  }

  private clearForceTimer(): void {
    if (this.forceTimer === undefined) return;
    clearTimeout(this.forceTimer);
    this.forceTimer = undefined;
  }
}

async function requireWorkspaceDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  let info;
  try {
    info = await stat(resolved);
  } catch (error: unknown) {
    throw new WishCliUsageError(`Workspace cannot be read: ${resolved}`, {
      cause: error,
    });
  }
  if (!info.isDirectory()) {
    throw new WishCliUsageError(`Workspace is not a directory: ${resolved}`);
  }
  return realpath(resolved);
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= 60
    ? normalized
    : `${characters.slice(0, 59).join("")}…`;
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is not initialized`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
