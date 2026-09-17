import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import { ShellError } from "../errors.js";
import type { Shell } from "../types.js";
import type {
  ToolDefinition,
  ToolInputParseResult,
  ToolResultArtifact,
} from "../../core/tools/tool.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { ToolOutputArtifactStore } from
  "../../tools/results/artifacts/types.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "../../tools/presentation/truncate.js";

export interface BashToolInput {
  readonly command: string;
  /** Timeout in seconds. Omitted means no Tool-level timeout. */
  readonly timeout?: number;
  /** Least authority required by this command. */
  readonly permissions?: BashToolPermissions;
}

export interface BashToolPermissions {
  readonly filesystem: "read" | "write" | {
    readonly read: readonly string[];
    readonly write: readonly string[];
  };
  readonly network: boolean;
  readonly externalSideEffect: boolean;
  readonly destructive: boolean;
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

export interface BashToolOptions {
  /** Cordis consumers bind the active Shell Provider here. */
  readonly shell?: Shell;
  /** Stable storage for complete output when the model-visible tail is truncated. */
  readonly artifacts?: ToolOutputArtifactStore;
  /** Hard memory bound before complete-output artifact capture is abandoned. */
  readonly maxArtifactBytes?: number;
  /** Explicit compatibility adapter for isolated tests. */
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
    permissions: {
      type: "object",
      description:
        "Least authority required. Omitted defaults to workspace write with no network or external side effect.",
      properties: {
        filesystem: {
          oneOf: [
            { type: "string", enum: ["read", "write"] },
            {
              type: "object",
              properties: {
                read: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 128,
                },
                write: {
                  type: "array",
                  items: { type: "string" },
                  maxItems: 128,
                },
              },
              required: ["read", "write"],
              additionalProperties: false,
            },
          ],
        },
        network: { type: "boolean" },
        externalSideEffect: { type: "boolean" },
        destructive: { type: "boolean" },
      },
      required: [
        "filesystem",
        "network",
        "externalSideEffect",
        "destructive",
      ],
      additionalProperties: false,
    },
  },
  required: ["command"],
  additionalProperties: false,
});

const ROLLING_OUTPUT_BYTES = DEFAULT_MAX_BYTES * 2;
export const DEFAULT_BASH_ARTIFACT_MAX_BYTES = 8_000_000;

export function createBashTool(
  options: BashToolOptions = {},
): ToolDefinition<"bash", BashToolInput, BashToolOutput, WishToolExecutionContext> {
  const maxArtifactBytes = positiveSafeInteger(
    options.maxArtifactBytes ?? DEFAULT_BASH_ARTIFACT_MAX_BYTES,
    "Bash maxArtifactBytes",
  );
  return {
    name: "bash",
    description:
      `Execute a shell command synchronously in the current working directory. There is no managed background mode; use tmux for long-lived servers, watchers, debuggers, and REPLs so they remain listable, observable, and attachable. Combined stdout and stderr are limited to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; complete truncated output is stored through the configured artifact Provider when available.`,
    inputSchemaJson: BASH_INPUT_SCHEMA,
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse: parseBashInput,
    resolveCapabilities(input, context) {
      const permissions = resolveBashPermissions(input);
      return {
        requirements: [
          {
            capability: "process.exec",
            commands: [input.command],
            cwd: context.cwd,
            ...(input.timeout === undefined
              ? {}
              : { timeoutSeconds: input.timeout }),
          },
          ...(permissions.readPaths.length === 0
            ? []
            : [{
                capability: "filesystem.read" as const,
                paths: permissions.readPaths,
              }]),
          ...(permissions.writePaths.length === 0
            ? []
            : [{
                capability: "filesystem.write" as const,
                paths: permissions.writePaths,
              }]),
          ...(permissions.network
            ? [{ capability: "network.connect" as const, hosts: ["*"] }]
            : []),
          ...(permissions.externalSideEffect
            ? [{
                capability: "external.side_effect" as const,
                resources: ["*"],
              }]
            : []),
        ],
        effects: {
          destructive: permissions.destructive,
          openWorld: permissions.network || permissions.externalSideEffect,
        },
      };
    },
    async execute(input, context, grant, signal) {
      throwIfAborted(signal);
      assertExecGrant(grant, input.command);
      const collector = new BashOutputCollector({
        artifacts: options.artifacts,
        maxArtifactBytes,
        context,
        grant,
        signal,
      });
      let execution: BashExecutionResult;
      try {
        if (options.operations !== undefined) {
          execution = await options.operations.exec(input.command, context.cwd, {
            onData: (data) => collector.append(data),
            ...(signal === undefined ? {} : { signal }),
            ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
          });
        } else {
          const shell = options.shell;
          if (shell === undefined) {
            throw new ToolExecutionError(
              "not_found",
              "Shell Provider is unavailable for bash",
            );
          }
          const spec = await shell.resolve({
            command: input.command,
            cwd: context.cwd,
            ...(input.timeout === undefined ? {} : {
              timeoutSeconds: input.timeout,
            }),
            context,
            grant,
            ...(signal === undefined ? {} : { signal }),
          });
          execution = await shell.run({
            spec,
            onData: (data) => collector.append(Buffer.from(data)),
            ...(signal === undefined ? {} : { signal }),
          });
        }
      } catch (error: unknown) {
        if (signal?.aborted === true) {
          await collector.discardArtifact();
          throw abortReason(signal);
        }
        const rendered = await collector.render(
          `Command failed: ${errorMessage(error)}`,
        );
        throw bashFailure(shellToolErrorCode(error), rendered, {
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

function parseBashInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<BashToolInput> {
  const unsupported = Object.keys(input).find(
    (key) => key !== "command" && key !== "timeout" && key !== "permissions",
  );
  if (unsupported !== undefined) {
    return {
      ok: false,
      message: `Bash input contains unsupported field "${unsupported}"`,
    };
  }
  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    return { ok: false, message: "Bash command must be a non-empty string" };
  }
  if (
    input.timeout !== undefined &&
    (typeof input.timeout !== "number" ||
      !Number.isFinite(input.timeout) ||
      input.timeout <= 0)
  ) {
    return { ok: false, message: "Bash timeout must be a positive number" };
  }
  const permissions = parseBashPermissions(input.permissions);
  if (permissions === null) {
    return {
      ok: false,
      message:
        "Bash permissions must contain filesystem, network, externalSideEffect, and destructive",
    };
  }
  return {
    ok: true,
    input: {
      command: input.command,
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      ...(permissions === undefined ? {} : { permissions }),
    },
  };
}

export interface ResolvedBashPermissions {
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly network: boolean;
  readonly externalSideEffect: boolean;
  readonly destructive: boolean;
}

/** Explicit default resolution shared by capability declaration and execution. */
export function resolveBashPermissions(
  input: BashToolInput,
): ResolvedBashPermissions {
  const permissions = input.permissions ?? {
    filesystem: "write" as const,
    network: false,
    externalSideEffect: false,
    destructive: false,
  };
  const filesystem = permissions.filesystem;
  return Object.freeze({
    readPaths: Object.freeze(
      typeof filesystem === "string" ? ["."] : [...filesystem.read],
    ),
    writePaths: Object.freeze(
      filesystem === "write"
        ? ["."]
        : typeof filesystem === "string"
          ? []
          : [...filesystem.write],
    ),
    network: permissions.network,
    externalSideEffect: permissions.externalSideEffect,
    destructive: permissions.destructive,
  });
}

function parseBashPermissions(value: unknown): BashToolPermissions | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "filesystem",
    "network",
    "externalSideEffect",
    "destructive",
  ])) return null;
  const filesystem = parseFilesystemPermissions(value.filesystem);
  if (
    filesystem === null ||
    typeof value.network !== "boolean" ||
    typeof value.externalSideEffect !== "boolean" ||
    typeof value.destructive !== "boolean"
  ) return null;
  return Object.freeze({
    filesystem,
    network: value.network,
    externalSideEffect: value.externalSideEffect,
    destructive: value.destructive,
  });
}

function parseFilesystemPermissions(
  value: unknown,
): BashToolPermissions["filesystem"] | null {
  if (value === "read" || value === "write") return value;
  if (!isRecord(value) || !hasOnlyKeys(value, ["read", "write"])) return null;
  const read = parsePathList(value.read);
  const write = parsePathList(value.write);
  if (read === null || write === null) return null;
  return Object.freeze({ read, write });
}

function parsePathList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  if (value.some((path) =>
    typeof path !== "string" || path.trim().length === 0 || path.includes("\0")
  )) return null;
  return Object.freeze([...value] as string[]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) =>
    expected.includes(key)
  );
}

interface BashOutputCollectorOptions {
  readonly artifacts: ToolOutputArtifactStore | undefined;
  readonly maxArtifactBytes: number;
  readonly context: WishToolExecutionContext;
  readonly grant: ToolAuthorizationGrant;
  readonly signal: AbortSignal | undefined;
}

class BashOutputCollector {
  private readonly chunks: Buffer[] = [];
  private readonly artifactChunks: Buffer[] = [];
  private chunksBytes = 0;
  private artifactBytes = 0;
  private totalBytes = 0;
  private totalNewlines = 0;
  private artifactOverflow = false;
  private finalized = false;

  constructor(private readonly options: BashOutputCollectorOptions) {}

  append(data: Buffer): void {
    if (this.finalized || data.length === 0) return;
    const chunk = Buffer.from(data);
    this.totalBytes += chunk.length;
    this.totalNewlines += countNewlines(chunk);

    this.chunks.push(chunk);
    this.chunksBytes += chunk.length;
    if (!this.artifactOverflow) {
      if (this.artifactBytes + chunk.length <= this.options.maxArtifactBytes) {
        this.artifactChunks.push(chunk);
        this.artifactBytes += chunk.length;
      } else {
        this.artifactOverflow = true;
        this.artifactChunks.length = 0;
        this.artifactBytes = 0;
      }
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
    this.artifactChunks.length = 0;
    this.artifactBytes = 0;
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
    if (
      !required || this.options.artifacts === undefined ||
      this.artifactOverflow
    ) {
      return undefined;
    }
    const permissions = this.options.context.permissions;
    try {
      return await this.options.artifacts.put({
        sessionId: permissions.subject.sessionId,
        runId: permissions.subject.runId,
        userTurnId: permissions.subject.userTurnId,
        stepId: permissions.subject.stepId,
        toolCallId: this.options.grant.subject.id,
        toolName: this.options.grant.subject.name,
        mediaType: "text/plain;charset=utf-8",
        value: Buffer.concat(this.artifactChunks, this.artifactBytes),
        ...(this.options.signal === undefined
          ? {}
          : { signal: this.options.signal }),
      });
    } catch {
      throwIfAborted(this.options.signal);
      return undefined;
    } finally {
      this.artifactChunks.length = 0;
      this.artifactBytes = 0;
    }
  }
}

function bashFailure(
  code:
    | "aborted"
    | "timeout"
    | "execution_failed"
    | "invalid_input"
    | "permission_denied",
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
  command: string,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName: "bash" });
  const authorized = grant.capabilities.requirements.some((requirement) =>
    requirement.capability === "process.exec" &&
    requirement.commands?.includes(command) === true
  );
  if (!authorized) {
    throw new Error(
      `Tool authorization Grant ${grant.grantId} does not allow executing this command`,
    );
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
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

function shellToolErrorCode(
  error: unknown,
): "invalid_input" | "permission_denied" | "execution_failed" {
  if (!(error instanceof ShellError)) return "execution_failed";
  if (error.code === "shell_invalid_input") return "invalid_input";
  if (
    error.code === "shell_permission_denied" ||
    error.code === "shell_policy_mismatch"
  ) return "permission_denied";
  return "execution_failed";
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
