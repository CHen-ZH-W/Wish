import { basename, relative } from "node:path";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../../core/tools/authorization.js";
import { ToolExecutionError } from "../../../core/tools/executor.js";
import type { ToolDefinition, ToolInputParseResult } from "../../../core/tools/tool.js";
import { FilesystemError } from "../../errors.js";
import { FilesystemSearchError } from "../errors.js";
import type {
  FilesystemSearch,
  SearchTextMatch,
  SearchTextResult,
} from "../types.js";
import type { WishToolExecutionContext } from "../../../composition/tool-context.js";
import { filesystemToolError } from "../../consumers/model-tools/filesystem.js";
import { resolveToCwd } from "../../consumers/model-tools/path.js";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "../../../tools/presentation/truncate.js";

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

export interface GrepToolOptions {
  /** Required execution capability; Cordis consumers bind one Provider generation. */
  readonly search?: FilesystemSearch;
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

/** Model-facing consumer of the replaceable Filesystem Search capability. */
export function createGrepTool(
  options: GrepToolOptions = {},
): ToolDefinition<"grep", GrepToolInput, GrepToolOutput, WishToolExecutionContext> {
  return {
    name: "grep",
    description:
      `Search file contents. Results are limited to ${DEFAULT_GREP_MATCH_LIMIT} matches by default, ${GREP_MAX_LINE_LENGTH} characters per source line, and ${formatSize(DEFAULT_MAX_BYTES)} total output.`,
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
      if (options.search === undefined) {
        throw new ToolExecutionError(
          "not_found",
          "Filesystem Search Provider is unavailable",
        );
      }

      let result: SearchTextResult;
      try {
        result = await options.search.search({
          pattern: input.pattern,
          path: searchPath,
          ...(input.glob === undefined ? {} : { glob: input.glob }),
          ...(input.ignoreCase === undefined ? {} : {
            ignoreCase: input.ignoreCase,
          }),
          ...(input.literal === undefined ? {} : { literal: input.literal }),
          contextLines: input.context ?? 0,
          limit: effectiveLimit,
          context,
          grant,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error: unknown) {
        throwIfAborted(signal);
        throw searchFailure(displayPath, error);
      }
      throwIfAborted(signal);
      assertReadGrant(grant, searchPath);

      if (result.matches.length === 0) {
        return {
          path: displayPath,
          content: [{ type: "text", text: "No matches found" }],
          matches: 0,
        };
      }

      const formatted = formatMatches(result);
      return buildOutput({
        path: displayPath,
        lines: formatted.lines,
        matchCount: result.matches.length,
        matchLimit: result.limitReached ? effectiveLimit : undefined,
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

function formatMatches(result: SearchTextResult): {
  readonly lines: readonly string[];
  readonly linesTruncated: boolean;
} {
  const output: string[] = [];
  let linesTruncated = false;
  for (const match of result.matches) {
    const displayedPath = formatMatchPath(match, result);
    for (const line of match.before) {
      const truncated = truncateLine(line.text);
      linesTruncated ||= truncated.wasTruncated;
      output.push(`${displayedPath}-${line.lineNumber}- ${truncated.text}`);
    }
    const matched = truncateLine(match.lineText);
    linesTruncated ||= matched.wasTruncated;
    output.push(`${displayedPath}:${match.lineNumber}: ${matched.text}`);
    for (const line of match.after) {
      const truncated = truncateLine(line.text);
      linesTruncated ||= truncated.wasTruncated;
      output.push(`${displayedPath}-${line.lineNumber}- ${truncated.text}`);
    }
  }
  return Object.freeze({ lines: Object.freeze(output), linesTruncated });
}

function formatMatchPath(match: SearchTextMatch, result: SearchTextResult): string {
  if (result.rootKind === "file") return basename(match.path);
  const value = relative(result.root, match.path);
  return value.length === 0 ? "." : value.replace(/\\/gu, "/");
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

function searchFailure(path: string, error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  if (error instanceof FilesystemError) {
    return filesystemToolError("search", path, error);
  }
  if (error instanceof FilesystemSearchError) {
    const code = error.code === "invalid_pattern" || error.code === "invalid_request"
      ? "invalid_input"
      : error.code === "unavailable"
        ? "not_found"
        : "execution_failed";
    return new ToolExecutionError(code, error.message);
  }
  return new ToolExecutionError(
    "execution_failed",
    `Could not search ${path}: ${errorMessage(error)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
