import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  stat as fsStat,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition, ToolInputParseResult } from "../../core/tools/tool.js";
import type { BasicToolContext } from "../support/context.js";
import { resolveToCwd } from "../support/path.js";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "../support/truncate.js";

export interface GrepToolInput {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly literal?: boolean;
  readonly context?: number;
  readonly limit?: number;
}

export interface GrepToolOutput {
  readonly path: string;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly matches: number;
  readonly matchLimitReached?: number;
  readonly linesTruncated?: boolean;
  readonly truncation?: TruncationResult;
}

export interface GrepOperations {
  isDirectory(absolutePath: string, signal?: AbortSignal): Promise<boolean>;
  readFile(absolutePath: string, signal?: AbortSignal): Promise<string>;
  spawnRipgrep(
    executable: string,
    arguments_: readonly string[],
  ): ChildProcessWithoutNullStreams;
}

export interface RipgrepResolver {
  resolve(signal?: AbortSignal): Promise<string | undefined>;
}

export interface GrepToolOptions {
  readonly operations?: GrepOperations;
  readonly resolver?: RipgrepResolver;
}

interface GrepMatch {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly lineText?: string;
}

interface CollectedMatches {
  readonly matches: readonly GrepMatch[];
  readonly limitReached: boolean;
}

export const DEFAULT_GREP_MATCH_LIMIT = 100;

const GREP_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Search pattern, interpreted as a regular expression by default",
    },
    path: {
      type: "string",
      description: "Directory or file to search, relative to cwd or absolute",
    },
    glob: {
      type: "string",
      description: "Optional file glob such as *.ts or **/*.spec.ts",
    },
    ignoreCase: {
      type: "boolean",
      description: "Use case-insensitive matching",
    },
    literal: {
      type: "boolean",
      description: "Treat pattern as literal text instead of a regular expression",
    },
    context: {
      type: "integer",
      minimum: 0,
      description: "Number of lines to show before and after each match",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: `Maximum matches to return, default ${DEFAULT_GREP_MATCH_LIMIT}`,
    },
  },
  required: ["pattern"],
  additionalProperties: false,
});

const DEFAULT_GREP_OPERATIONS: GrepOperations = {
  async isDirectory(absolutePath, signal) {
    throwIfAborted(signal);
    const result = await fsStat(absolutePath);
    throwIfAborted(signal);
    return result.isDirectory();
  },
  async readFile(absolutePath, signal) {
    return signal === undefined
      ? await fsReadFile(absolutePath, "utf8")
      : await fsReadFile(absolutePath, { encoding: "utf8", signal });
  },
  spawnRipgrep(executable, arguments_) {
    const child = spawn(executable, [...arguments_], {
      stdio: "pipe",
      windowsHide: true,
    });
    child.stdin.end();
    return child;
  },
};

const DEFAULT_RIPGREP_RESOLVER: RipgrepResolver = {
  async resolve(signal) {
    const pathValue = process.env.PATH;
    if (pathValue === undefined || pathValue.length === 0) return undefined;
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    for (const directory of pathValue.split(delimiter)) {
      if (directory.length === 0) continue;
      for (const extension of extensions) {
        throwIfAborted(signal);
        const candidate = join(directory, `rg${extension.toLowerCase()}`);
        try {
          await fsAccess(candidate, constants.X_OK);
          throwIfAborted(signal);
          return candidate;
        } catch {
          // Continue searching PATH. Installation belongs to an injected resolver.
        }
      }
    }
    return undefined;
  },
};

export function createGrepTool(
  options: GrepToolOptions = {},
): ToolDefinition<"grep", GrepToolInput, GrepToolOutput, BasicToolContext> {
  const operations = options.operations ?? DEFAULT_GREP_OPERATIONS;
  const resolver = options.resolver ?? DEFAULT_RIPGREP_RESOLVER;
  return {
    name: "grep",
    description:
      `Search file contents with ripgrep. Results are limited to ${DEFAULT_GREP_MATCH_LIMIT} matches by default, ${GREP_MAX_LINE_LENGTH} characters per source line, and ${formatSize(DEFAULT_MAX_BYTES)} total output.`,
    inputSchemaJson: GREP_INPUT_SCHEMA,
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse: parseGrepInput,
    resolveCapabilities(input, context) {
      return {
        requirements: [{
          capability: "filesystem.read",
          paths: [resolveToCwd(input.path ?? ".", context.cwd)],
        }],
      };
    },
    async execute(input, context, grant, signal) {
      const searchPath = resolveToCwd(input.path ?? ".", context.cwd);
      const displayPath = input.path ?? ".";
      const effectiveLimit = input.limit ?? DEFAULT_GREP_MATCH_LIMIT;
      throwIfAborted(signal);
      assertReadGrant(grant, searchPath);

      let executable: string | undefined;
      try {
        executable = await resolver.resolve(signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        throw new ToolExecutionError(
          "execution_failed",
          `Could not resolve ripgrep (rg): ${errorMessage(error)}`,
        );
      }
      throwIfAborted(signal);
      if (executable === undefined || executable.length === 0) {
        throw new ToolExecutionError(
          "not_found",
          "ripgrep (rg) is not available; configure a Grep resolver before using this Tool",
        );
      }

      assertReadGrant(grant, searchPath);
      let isDirectory: boolean;
      try {
        isDirectory = await operations.isDirectory(searchPath, signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        throw pathOperationError(searchPath, error);
      }
      throwIfAborted(signal);

      const arguments_ = buildRipgrepArguments(input, searchPath);
      assertReadGrant(grant, searchPath);
      const collected = await collectMatches({
        operations,
        executable,
        arguments_,
        limit: effectiveLimit,
        signal,
      });
      throwIfAborted(signal);

      if (collected.matches.length === 0) {
        return {
          path: displayPath,
          content: [{ type: "text", text: "No matches found" }],
          matches: 0,
        };
      }

      const formatted = await formatMatches({
        operations,
        matches: collected.matches,
        searchPath,
        isDirectory,
        contextLines: input.context ?? 0,
        grant,
        signal,
      });
      return buildOutput({
        path: displayPath,
        lines: formatted.lines,
        matchCount: collected.matches.length,
        matchLimit: collected.limitReached ? effectiveLimit : undefined,
        linesTruncated: formatted.linesTruncated,
      });
    },
  };
}

function parseGrepInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<GrepToolInput> {
  const supported = new Set([
    "pattern",
    "path",
    "glob",
    "ignoreCase",
    "literal",
    "context",
    "limit",
  ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported !== undefined) {
    return {
      ok: false,
      message: `Grep input contains unsupported field "${unsupported}"`,
    };
  }
  if (typeof input.pattern !== "string") {
    return { ok: false, message: "Grep pattern must be a string" };
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return { ok: false, message: "Grep path must be a string" };
  }
  if (input.glob !== undefined && typeof input.glob !== "string") {
    return { ok: false, message: "Grep glob must be a string" };
  }
  if (input.ignoreCase !== undefined && typeof input.ignoreCase !== "boolean") {
    return { ok: false, message: "Grep ignoreCase must be a boolean" };
  }
  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    return { ok: false, message: "Grep literal must be a boolean" };
  }
  if (input.context !== undefined && !isNonNegativeInteger(input.context)) {
    return { ok: false, message: "Grep context must be a non-negative integer" };
  }
  if (input.limit !== undefined && !isPositiveInteger(input.limit)) {
    return { ok: false, message: "Grep limit must be a positive integer" };
  }
  return {
    ok: true,
    input: {
      pattern: input.pattern,
      ...(input.path === undefined ? {} : { path: input.path as string }),
      ...(input.glob === undefined ? {} : { glob: input.glob as string }),
      ...(input.ignoreCase === undefined
        ? {}
        : { ignoreCase: input.ignoreCase as boolean }),
      ...(input.literal === undefined ? {} : { literal: input.literal as boolean }),
      ...(input.context === undefined ? {} : { context: input.context as number }),
      ...(input.limit === undefined ? {} : { limit: input.limit as number }),
    },
  };
}

function buildRipgrepArguments(
  input: GrepToolInput,
  searchPath: string,
): readonly string[] {
  const arguments_: string[] = [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
  ];
  if (input.ignoreCase === true) arguments_.push("--ignore-case");
  if (input.literal === true) arguments_.push("--fixed-strings");
  if (input.glob !== undefined) arguments_.push("--glob", input.glob);
  arguments_.push("--", input.pattern, searchPath);
  return arguments_;
}

async function collectMatches(input: {
  readonly operations: GrepOperations;
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly limit: number;
  readonly signal: AbortSignal | undefined;
}): Promise<CollectedMatches> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = input.operations.spawnRipgrep(input.executable, input.arguments_);
  } catch (error: unknown) {
    throw processStartError(error);
  }

  return await new Promise<CollectedMatches>((resolvePromise, rejectPromise) => {
    const matches: GrepMatch[] = [];
    let stderr = "";
    let settled = false;
    let stoppedForLimit = false;
    const reader = createInterface({ input: child.stdout });

    const cleanup = (): void => {
      reader.close();
      input.signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: CollectedMatches): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const stopChild = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The terminal event still decides whether the process stopped.
      }
    };
    const onAbort = (): void => {
      stopChild();
      rejectOnce(abortReason(input.signal));
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    reader.on("line", (line) => {
      if (settled || matches.length >= input.limit) return;
      const match = parseRipgrepMatch(line);
      if (match === undefined) return;
      matches.push(match);
      if (matches.length >= input.limit) {
        stoppedForLimit = true;
        stopChild();
      }
    });
    child.once("error", (error) => {
      rejectOnce(processStartError(error));
    });
    child.once("close", (code) => {
      if (settled) return;
      if (input.signal?.aborted === true) {
        rejectOnce(abortReason(input.signal));
        return;
      }
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        rejectOnce(new ToolExecutionError(
          "execution_failed",
          stderr.trim() || `ripgrep exited with code ${String(code)}`,
        ));
        return;
      }
      resolveOnce({ matches, limitReached: stoppedForLimit });
    });

    if (input.signal?.aborted === true) onAbort();
  });
}

function parseRipgrepMatch(line: string): GrepMatch | undefined {
  if (line.trim().length === 0) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event) || event.type !== "match" || !isRecord(event.data)) {
    return undefined;
  }
  const path = event.data.path;
  const lines = event.data.lines;
  const lineNumber = event.data.line_number;
  if (
    !isRecord(path) ||
    typeof path.text !== "string" ||
    !Number.isSafeInteger(lineNumber) ||
    (lineNumber as number) < 1
  ) {
    return undefined;
  }
  const lineText = isRecord(lines) && typeof lines.text === "string"
    ? lines.text
    : undefined;
  return {
    filePath: path.text,
    lineNumber: lineNumber as number,
    ...(lineText === undefined ? {} : { lineText }),
  };
}

async function formatMatches(input: {
  readonly operations: GrepOperations;
  readonly matches: readonly GrepMatch[];
  readonly searchPath: string;
  readonly isDirectory: boolean;
  readonly contextLines: number;
  readonly grant: ToolAuthorizationGrant;
  readonly signal: AbortSignal | undefined;
}): Promise<{ readonly lines: readonly string[]; readonly linesTruncated: boolean }> {
  const output: string[] = [];
  const fileCache = new Map<string, readonly string[]>();
  let linesTruncated = false;

  for (const match of input.matches) {
    throwIfAborted(input.signal);
    const absoluteFilePath = normalizeMatchPath(
      match.filePath,
      input.searchPath,
      input.isDirectory,
    );
    const displayedPath = formatMatchPath(
      absoluteFilePath,
      input.searchPath,
      input.isDirectory,
    );
    if (input.contextLines === 0 && match.lineText !== undefined) {
      const sanitized = normalizeMatchLine(match.lineText);
      const truncated = truncateLine(sanitized);
      linesTruncated ||= truncated.wasTruncated;
      output.push(`${displayedPath}:${match.lineNumber}: ${truncated.text}`);
      continue;
    }

    if (!isInsideSearchPath(absoluteFilePath, input.searchPath, input.isDirectory)) {
      output.push(`${displayedPath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }
    let lines = fileCache.get(absoluteFilePath);
    if (lines === undefined) {
      assertReadGrant(input.grant, input.searchPath);
      try {
        const content = await input.operations.readFile(
          absoluteFilePath,
          input.signal,
        );
        throwIfAborted(input.signal);
        if (typeof content !== "string") {
          throw new Error("Grep readFile operation did not return text");
        }
        lines = content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
      } catch {
        throwIfAborted(input.signal);
        lines = [];
      }
      fileCache.set(absoluteFilePath, lines);
    }
    if (lines.length === 0) {
      output.push(`${displayedPath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }

    const firstLine = Math.max(1, match.lineNumber - input.contextLines);
    const lastLine = Math.min(lines.length, match.lineNumber + input.contextLines);
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const sourceLine = lines[lineNumber - 1] ?? "";
      const truncated = truncateLine(sourceLine);
      linesTruncated ||= truncated.wasTruncated;
      output.push(
        lineNumber === match.lineNumber
          ? `${displayedPath}:${lineNumber}: ${truncated.text}`
          : `${displayedPath}-${lineNumber}- ${truncated.text}`,
      );
    }
  }
  return { lines: output, linesTruncated };
}

function buildOutput(input: {
  readonly path: string;
  readonly lines: readonly string[];
  readonly matchCount: number;
  readonly matchLimit: number | undefined;
  readonly linesTruncated: boolean;
}): GrepToolOutput {
  const rawOutput = input.lines.join("\n");
  const baseNotices: string[] = [];
  if (input.matchLimit !== undefined) {
    baseNotices.push(
      `${input.matchLimit} matches limit reached. Increase limit or refine the pattern`,
    );
  }
  if (input.linesTruncated) {
    baseNotices.push(
      `Some lines were truncated to ${GREP_MAX_LINE_LENGTH} characters. Use read to inspect full lines`,
    );
  }

  const baseSuffix = noticeSuffix(baseNotices);
  const exceedsTotalLimit =
    Buffer.byteLength(rawOutput + baseSuffix, "utf8") > DEFAULT_MAX_BYTES;
  const notices = exceedsTotalLimit
    ? [...baseNotices, `${formatSize(DEFAULT_MAX_BYTES)} output limit reached`]
    : baseNotices;
  const suffix = noticeSuffix(notices);
  const availableBytes = Math.max(
    1,
    DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8"),
  );
  const truncation = truncateHead(rawOutput, {
    maxLines: Number.MAX_SAFE_INTEGER,
    maxBytes: availableBytes,
  });
  const outputText = truncation.content + suffix;
  if (Buffer.byteLength(outputText, "utf8") > DEFAULT_MAX_BYTES) {
    throw new Error("Grep output exceeded its byte limit");
  }

  return {
    path: input.path,
    content: [{ type: "text", text: outputText }],
    matches: input.matchCount,
    ...(input.matchLimit === undefined
      ? {}
      : { matchLimitReached: input.matchLimit }),
    ...(input.linesTruncated ? { linesTruncated: true } : {}),
    ...(truncation.truncated ? { truncation } : {}),
  };
}

function noticeSuffix(notices: readonly string[]): string {
  return notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`;
}

function normalizeMatchPath(
  filePath: string,
  searchPath: string,
  isDirectory: boolean,
): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return isDirectory
    ? resolve(searchPath, filePath)
    : resolve(dirname(searchPath), filePath);
}

function formatMatchPath(
  filePath: string,
  searchPath: string,
  isDirectory: boolean,
): string {
  if (!isDirectory) {
    const pieces = filePath.replace(/\\/gu, "/").split("/");
    return pieces.at(-1) ?? filePath;
  }
  const relativePath = relative(searchPath, filePath);
  return relativePath.length === 0 ? "." : relativePath.replace(/\\/gu, "/");
}

function isInsideSearchPath(
  filePath: string,
  searchPath: string,
  isDirectory: boolean,
): boolean {
  if (!isDirectory) return resolve(filePath) === resolve(searchPath);
  const relativePath = relative(searchPath, filePath);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeMatchLine(line: string): string {
  return line.replace(/\r\n/gu, "\n").replace(/\r/gu, "").replace(/\n$/u, "");
}

function assertReadGrant(
  grant: ToolAuthorizationGrant,
  searchPath: string,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName: "grep" });
  const authorized = grant.capabilities.requirements.some((requirement) =>
    requirement.capability === "filesystem.read" &&
    requirement.paths.includes(searchPath)
  );
  if (!authorized) {
    throw new Error(
      `Tool authorization Grant ${grant.grantId} does not allow reading "${searchPath}"`,
    );
  }
}

function pathOperationError(path: string, error: unknown): ToolExecutionError {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ToolExecutionError("not_found", `Grep path not found: ${path}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ToolExecutionError(
      "permission_denied",
      `Grep path is not readable: ${path}`,
    );
  }
  return new ToolExecutionError(
    "execution_failed",
    `Could not inspect Grep path ${path}: ${errorMessage(error)}`,
  );
}

function processStartError(error: unknown): ToolExecutionError {
  return errorCode(error) === "ENOENT"
    ? new ToolExecutionError("not_found", "ripgrep (rg) executable was not found")
    : new ToolExecutionError(
        "execution_failed",
        `Failed to run ripgrep: ${errorMessage(error)}`,
      );
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(
    typeof signal?.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Operation aborted",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}
