import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Session } from "../../sessions/types.js";
import type { RunGenerationRetireOptions } from "../../core/runtime/generation.js";
import type { ToolApprovalPort } from "../../tools/index.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { ApplicationOpenInput } from "../service.js";
import type {
  WishApplication,
  WishRunCompletion,
} from "../types.js";
import { FileSubagentExchange, type SubagentResult } from "../../subagents/index.js";
import {
  parseWishCliArguments,
  WISH_CLI_HELP,
  WishCliUsageError,
  type WishCliArguments,
} from "./args.js";
import { CliToolApprovalPort } from "./approval.js";
import { reviewCommand } from "./session-features.js";
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

export type WishCliApplicationOpener = (
  input: WishCliApplicationOpenInput,
) => Promise<WishApplication>;

/** Standalone compatibility input; Cordis product hosts omit approval. */
export interface WishCliApplicationOpenInput extends ApplicationOpenInput {
  readonly approval?: ToolApprovalPort<WishToolExecutionContext>;
}

export interface WishCliDependencies {
  readonly terminal: WishCliTerminal;
  readonly cwd?: () => string;
  /** Application capability supplied by the process plugin or an embedder. */
  readonly openApplication: WishCliApplicationOpener;
  /** Product Cordis graphs register the CLI answerer with Approval Hub. */
  readonly registerApproval?: (
    approval: ToolApprovalPort<WishToolExecutionContext>,
  ) => void;
  readonly forceExit?: (code: number) => void;
  readonly interruptTimeoutMs?: number;
}

export interface WishCli {
  run(argv: readonly string[]): Promise<number>;
  interrupt(signal: WishCliInterruptSignal): void;
  /** Retire the Loader-managed Run generation, if one was created. */
  retire(options?: RunGenerationRetireOptions): Promise<void>;
}

/** Create one line-oriented CLI host around the shared WishApplication. */
export function createWishCli(dependencies: WishCliDependencies): WishCli {
  return new DefaultWishCli(dependencies);
}

class DefaultWishCli implements WishCli {
  private readonly terminal: WishCliTerminal;
  private readonly cwd: () => string;
  private readonly openApplication: WishCliApplicationOpener;
  private readonly forceExit: (code: number) => void;
  private readonly interruptTimeoutMs: number;
  private readonly input: CliInputCoordinator;
  private readonly approvalRegistered: boolean;
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
    this.openApplication = dependencies.openApplication;
    this.forceExit = dependencies.forceExit ?? ((code) => process.exit(code));
    this.interruptTimeoutMs = positiveInteger(
      dependencies.interruptTimeoutMs ?? WISH_CLI_INTERRUPT_TIMEOUT_MS,
      "CLI interrupt timeout",
    );
    this.input = new CliInputCoordinator(
      this.terminal,
      new CliToolApprovalPort({ terminal: this.terminal }),
    );
    this.approvalRegistered = dependencies.registerApproval !== undefined;
    dependencies.registerApproval?.(this.input.approval);
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
    if ((args.command === "interactive" || args.command === "child") && !this.terminal.interactive) {
      throw new WishCliUsageError(
        `${args.command === "child" ? "Subagent child mode" : "Interactive mode"} requires a TTY; use \"wish run\" for piped input`,
      );
    }

    const launchDirectory = resolve(this.cwd());
    this.application = await this.openApplication({
      ...(args.dataDirectory === undefined
        ? {}
        : { dataDirectory: resolve(launchDirectory, args.dataDirectory) }),
      ...(args.modelsConfigurationPath === undefined
        ? {}
        : {
            modelsConfigurationPath: resolve(
              launchDirectory,
              args.modelsConfigurationPath,
            ),
          }),
      ...(this.approvalRegistered ? {} : { approval: this.input.approval }),
    });
    if (
      args.command === "recovery-list" ||
      args.command === "recovery-resolve"
    ) {
      return this.manageRuntimeRecovery(this.application, args);
    }
    await this.describeRuntimeRecovery(this.application);
    if (this.terminateRequested) return this.terminationCode;

    if (args.command === "run") return this.runOnce(args, launchDirectory);
    if (args.command === "child") return this.runChild(args, launchDirectory);
    return this.runInteractive(args, launchDirectory);
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
      const retirementReason = `Wish CLI received ${signal}`;
      if (
        signal !== "SIGINT" &&
        this.application.runGeneration !== undefined
      ) {
        void this.application.runGeneration.retire({
          reason: retirementReason,
        });
      } else {
        try {
          this.application.controlRun(this.activeRunId, {
            type: "abort",
            source: "wish-cli-signal",
            reason: retirementReason,
          });
        } catch {
          this.forceExit(exitCode);
          return;
        }
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

  retire(options: RunGenerationRetireOptions = {}): Promise<void> {
    return this.application?.runGeneration?.retire(options) ??
      Promise.resolve();
  }

  private async describeRuntimeRecovery(
    application: WishApplication,
  ): Promise<void> {
    if (application.runtimeRecovery === undefined) return;
    const startup = await application.runtimeRecovery.snapshot();
    const recovered = startup.recovery.runs.length;
    if (recovered > 0) {
      await this.terminal.writeError(
        `[recovery] sealed ${recovered} interrupted Run${recovered === 1 ? "" : "s"}; no Tool was replayed automatically\n`,
      );
    }
    const reconciliation = startup.reconciliationRequiredRuns;
    if (reconciliation.length === 0) return;
    const runIds = reconciliation.map((run) => run.runId).join(", ");
    await this.terminal.writeError(
      `[recovery] reconciliation required for ${reconciliation.length} Run${reconciliation.length === 1 ? "" : "s"}: ${runIds}\n`,
    );
  }

  private async manageRuntimeRecovery(
    application: WishApplication,
    args: WishCliArguments,
  ): Promise<number> {
    const recovery = application.runtimeRecovery;
    if (recovery === undefined) {
      throw new WishCliUsageError("Runtime recovery management is unavailable");
    }
    if (args.command === "recovery-list") {
      await this.terminal.writeOutput(
        `${JSON.stringify(await recovery.snapshot(), null, 2)}\n`,
      );
      return 0;
    }
    if (
      args.command !== "recovery-resolve" ||
      args.reconciliation === undefined
    ) {
      throw new WishCliUsageError("Recovery resolution arguments are missing");
    }
    const commit = await recovery.resolve(args.reconciliation);
    const snapshot = await recovery.snapshot();
    await this.terminal.writeOutput(
      `${JSON.stringify({ commit, recovery: snapshot }, null, 2)}\n`,
    );
    return 0;
  }

  private async runOnce(
    args: WishCliArguments,
    launchDirectory: string,
  ): Promise<number> {
    const prompt = await this.resolveOneShotPrompt(args);
    if (this.terminateRequested) return this.terminationCode;
    const session = await this.resolveSession(args, launchDirectory, prompt);
    await this.describeSession(session);
    const result = await this.runMessage(session, prompt, args);
    return this.terminateRequested ? this.terminationCode : result.exitCode;
  }

  private async runChild(
    args: WishCliArguments,
    launchDirectory: string,
  ): Promise<number> {
    const childId = requireDefined(args.childId, "Subagent child id");
    const childSessionId = requireDefined(args.childSessionId, "Subagent Session id");
    const childRunId = requireDefined(args.childRunId, "Subagent Run id");
    const dataDirectory = resolve(
      launchDirectory,
      requireDefined(args.dataDirectory, "Subagent data directory"),
    );
    const exchange = new FileSubagentExchange(resolve(
      launchDirectory,
      requireDefined(args.exchangeDataDirectory, "Subagent exchange data directory"),
    ));
    const prompt = await exchange.consumeTask(
      requireDefined(args.promptFile, "Subagent prompt file"),
    );
    const workspaceRoot = await requireWorkspaceDirectory(
      requireDefined(args.workspaceRoot, "Subagent workspace"),
    );
    const session = await this.requireApplication().createSession({
      sessionId: childSessionId,
      workspaceRoot,
      title: titleFromPrompt(prompt),
    });
    await this.describeSession(session);
    const outcome = await this.runMessage(session, prompt, args, childRunId);
    await exchange.writeResult(subagentResult(
      childId,
      childSessionId,
      childRunId,
      outcome.completion,
    ));
    return this.terminateRequested ? this.terminationCode : outcome.exitCode;
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
          "/review inspects saved plans, task graphs and workflow reconciliation controls.\n" +
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
      try {
        const review = await reviewCommand(this.requireApplication().sessionFeatures, session.sessionId, text, this.terminal);
        if (review.handled && review.message === undefined) continue;
        await this.runMessage(session, review.message ?? text, args);
      } catch (error) { await this.terminal.writeError(`${error instanceof Error ? error.message : String(error)}\n`); }
    }
    return this.terminateRequested ? this.terminationCode : 0;
  }

  private async runMessage(
    session: Session,
    text: string,
    args: WishCliArguments,
    runId?: string,
  ): Promise<{ readonly exitCode: number; readonly completion: WishRunCompletion }> {
    const application = this.requireApplication();
    const handle = await application.startRun({
      sessionId: session.sessionId,
      inputSource: args.command === "child" ? "unknown" : "user",
      payload: {
        text,
        ...(args.model === undefined ? {} : { model: args.model }),
      },
      metadata: Object.freeze({ source: "wish-cli" }),
      ...(runId === undefined ? {} : { runId }),
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
          ? this.readActiveRunControls(handle.runId, session.sessionId, controlStop.signal)
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

    if (completion.status === "completed") return Object.freeze({ exitCode: 0, completion });
    if (completion.status === "failed") {
      await this.terminal.writeError(
        `[run] failed (${completion.error.code}): ${completion.error.message}\n`,
      );
      return Object.freeze({ exitCode: 1, completion });
    }
    await this.terminal.writeError(
      `[run] aborted: ${completion.cancellation.reason}\n`,
    );
    return Object.freeze({ exitCode: 130, completion });
  }

  private async readActiveRunControls(
    runId: string,
    sessionId: string,
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
      let line = input.line;
      try {
        const review = await reviewCommand(application.sessionFeatures, sessionId, line, this.terminal);
        if (review.handled && review.message === undefined) continue;
        line = review.message ?? line;
      } catch (error) { await this.terminal.writeError(`${error instanceof Error ? error.message : String(error)}\n`); continue; }
      const parsed = parseWishCliActiveInput(line);
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
        if (parsed.control.type !== "abort") await application.sessionFeatures?.beforeInput(sessionId,
          parsed.control.type === "follow_up" ? parsed.control.payload.text : parsed.control.text);
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

function subagentResult(
  id: string,
  childSessionId: string,
  childRunId: string,
  completion: WishRunCompletion,
): SubagentResult {
  const completedAt = new Date().toISOString();
  if (completion.status === "completed") {
    return Object.freeze({
      schemaVersion: 1 as const,
      id,
      childSessionId,
      childRunId,
      status: "completed" as const,
      text: completion.result.output.text,
      completedAt,
    });
  }
  if (completion.status === "failed") {
    return Object.freeze({
      schemaVersion: 1 as const,
      id,
      childSessionId,
      childRunId,
      status: "failed" as const,
      error: `${completion.error.code}: ${completion.error.message}`,
      completedAt,
    });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    id,
    childSessionId,
    childRunId,
    status: "aborted" as const,
    error: completion.cancellation.reason,
    completedAt,
  });
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
