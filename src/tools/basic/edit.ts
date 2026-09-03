import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";

import { diffLines } from "diff";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import { ToolExecutionError } from "../../core/tools/executor.js";
import type { ToolDefinition, ToolInputParseResult } from "../../core/tools/tool.js";
import type { BasicToolContext } from "../support/context.js";
import { withFileMutationQueue } from "../support/mutation-queue.js";
import { resolveToCwd } from "../support/path.js";

export interface EditReplacement {
  readonly oldText: string;
  readonly newText: string;
}

export interface EditToolInput {
  readonly path: string;
  readonly edits: readonly EditReplacement[];
}

export interface EditToolOutput {
  readonly path: string;
  readonly editsApplied: number;
  readonly diff: string;
  readonly firstChangedLine?: number;
}

export interface EditOperations {
  access(absolutePath: string, signal?: AbortSignal): Promise<void>;
  readFile(absolutePath: string, signal?: AbortSignal): Promise<Buffer>;
  writeFile(
    absolutePath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface EditToolOptions {
  readonly operations?: EditOperations;
}

interface MatchedEdit {
  readonly editIndex: number;
  readonly matchIndex: number;
  readonly matchLength: number;
  readonly newText: string;
}

const EDIT_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the UTF-8 file to edit, relative to cwd or absolute",
    },
    edits: {
      type: "array",
      minItems: 1,
      description: "Non-overlapping replacements matched against the original file",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            minLength: 1,
            description: "Unique text to replace",
          },
          newText: {
            type: "string",
            description: "Replacement text",
          },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "edits"],
  additionalProperties: false,
});

const DEFAULT_EDIT_OPERATIONS: EditOperations = {
  async access(absolutePath) {
    await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
  },
  async readFile(absolutePath, signal) {
    return signal === undefined
      ? await fsReadFile(absolutePath)
      : await fsReadFile(absolutePath, { signal });
  },
  async writeFile(absolutePath, content, signal) {
    if (signal === undefined) {
      await fsWriteFile(absolutePath, content, "utf8");
      return;
    }
    await fsWriteFile(absolutePath, content, { encoding: "utf8", signal });
  },
};

export function createEditTool(
  options: EditToolOptions = {},
): ToolDefinition<"edit", EditToolInput, EditToolOutput, BasicToolContext> {
  const operations = options.operations ?? DEFAULT_EDIT_OPERATIONS;
  return {
    name: "edit",
    description:
      "Replace one or more unique, non-overlapping text blocks in a UTF-8 file.",
    inputSchemaJson: EDIT_INPUT_SCHEMA,
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse: parseEditInput,
    resolveCapabilities(input, context) {
      const absolutePath = resolveToCwd(input.path, context.cwd);
      return {
        requirements: [
          { capability: "filesystem.read", paths: [absolutePath] },
          { capability: "filesystem.write", paths: [absolutePath] },
        ],
      };
    },
    async execute(input, context, grant, signal) {
      const absolutePath = resolveToCwd(input.path, context.cwd);
      return await withFileMutationQueue(
        absolutePath,
        async () => {
          throwIfAborted(signal);
          assertEditGrant(grant, absolutePath);
          try {
            await operations.access(absolutePath, signal);
          } catch (error: unknown) {
            throwIfAborted(signal);
            throw fileOperationError("access", input.path, error);
          }

          throwIfAborted(signal);
          assertEditGrant(grant, absolutePath);
          let buffer: Buffer;
          try {
            buffer = await operations.readFile(absolutePath, signal);
          } catch (error: unknown) {
            throwIfAborted(signal);
            throw fileOperationError("read", input.path, error);
          }

          throwIfAborted(signal);
          const { bom, text } = stripBom(buffer.toString("utf8"));
          const lineEnding = detectLineEnding(text);
          const normalizedContent = normalizeToLf(text);
          const { baseContent, newContent } = applyEdits(
            normalizedContent,
            input.edits,
            input.path,
          );
          const diff = generateDiff(baseContent, newContent);
          const finalContent = bom + restoreLineEndings(newContent, lineEnding);

          throwIfAborted(signal);
          assertEditGrant(grant, absolutePath);
          try {
            await operations.writeFile(absolutePath, finalContent, signal);
          } catch (error: unknown) {
            throwIfAborted(signal);
            throw fileOperationError("write", input.path, error);
          }
          throwIfAborted(signal);

          return {
            path: input.path,
            editsApplied: input.edits.length,
            diff: diff.text,
            ...(diff.firstChangedLine === undefined
              ? {}
              : { firstChangedLine: diff.firstChangedLine }),
          };
        },
        signal,
      );
    },
  };
}

function parseEditInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<EditToolInput> {
  const unsupported = Object.keys(input).filter(
    (key) => key !== "path" && key !== "edits",
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `Edit input contains unsupported field "${unsupported[0]}"`,
    };
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    return { ok: false, message: "Edit path must be a non-empty string" };
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return { ok: false, message: "Edit edits must contain at least one replacement" };
  }

  const edits: EditReplacement[] = [];
  for (let index = 0; index < input.edits.length; index += 1) {
    const candidate: unknown = input.edits[index];
    if (!isRecord(candidate)) {
      return { ok: false, message: `Edit edits[${index}] must be an object` };
    }
    const unsupportedEditFields = Object.keys(candidate).filter(
      (key) => key !== "oldText" && key !== "newText",
    );
    if (unsupportedEditFields.length > 0) {
      return {
        ok: false,
        message:
          `Edit edits[${index}] contains unsupported field "${unsupportedEditFields[0]}"`,
      };
    }
    if (typeof candidate.oldText !== "string" || candidate.oldText.length === 0) {
      return {
        ok: false,
        message: `Edit edits[${index}].oldText must be a non-empty string`,
      };
    }
    if (typeof candidate.newText !== "string") {
      return {
        ok: false,
        message: `Edit edits[${index}].newText must be a string`,
      };
    }
    edits.push({ oldText: candidate.oldText, newText: candidate.newText });
  }
  return { ok: true, input: { path: input.path, edits } };
}

function applyEdits(
  originalContent: string,
  edits: readonly EditReplacement[],
  path: string,
): { readonly baseContent: string; readonly newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));
  const initialMatches = normalizedEdits.map((edit) =>
    findText(originalContent, edit.oldText)
  );
  const baseContent = initialMatches.some((match) => match.usedNormalization)
    ? normalizeForMatch(originalContent)
    : originalContent;

  const matched: MatchedEdit[] = [];
  for (let index = 0; index < normalizedEdits.length; index += 1) {
    const edit = normalizedEdits[index];
    if (edit === undefined) continue;
    const match = findText(baseContent, edit.oldText);
    if (!match.found) {
      throw conflict(
        normalizedEdits.length === 1
          ? `Could not find the exact text in ${path}. The old text must match including whitespace and newlines.`
          : `Could not find edits[${index}] in ${path}. oldText must match including whitespace and newlines.`,
      );
    }
    const occurrences = countOccurrences(
      normalizeForMatch(baseContent),
      normalizeForMatch(edit.oldText),
    );
    if (occurrences !== 1) {
      throw conflict(
        normalizedEdits.length === 1
          ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique.`
          : `Found ${occurrences} occurrences of edits[${index}] in ${path}. Each oldText must be unique.`,
      );
    }
    matched.push({
      editIndex: index,
      matchIndex: match.index,
      matchLength: match.length,
      newText: edit.newText,
    });
  }

  matched.sort((left, right) => left.matchIndex - right.matchIndex);
  for (let index = 1; index < matched.length; index += 1) {
    const previous = matched[index - 1];
    const current = matched[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw conflict(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = baseContent;
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const edit = matched[index];
    if (edit === undefined) continue;
    newContent = newContent.slice(0, edit.matchIndex) + edit.newText +
      newContent.slice(edit.matchIndex + edit.matchLength);
  }
  if (newContent === baseContent) {
    throw conflict(
      normalizedEdits.length === 1
        ? `No changes made to ${path}. The replacement produced identical content.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  }
  return { baseContent, newContent };
}

function findText(
  content: string,
  oldText: string,
): {
  readonly found: boolean;
  readonly index: number;
  readonly length: number;
  readonly usedNormalization: boolean;
} {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      length: oldText.length,
      usedNormalization: false,
    };
  }
  const normalizedContent = normalizeForMatch(content);
  const normalizedOldText = normalizeForMatch(oldText);
  const normalizedIndex = normalizedContent.indexOf(normalizedOldText);
  return normalizedIndex === -1
    ? { found: false, index: -1, length: 0, usedNormalization: false }
    : {
        found: true,
        index: normalizedIndex,
        length: normalizedOldText.length,
        usedNormalization: true,
      };
}

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const found = content.indexOf(search, offset);
    if (found === -1) break;
    count += 1;
    offset = found + 1;
  }
  return count;
}

function stripBom(content: string): { readonly bom: string; readonly text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return crlf !== -1 && crlf < lf ? "\r\n" : "\n";
}

function normalizeToLf(content: string): string {
  return content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\r\n" | "\n"): string {
  return lineEnding === "\r\n" ? content.replace(/\n/gu, "\r\n") : content;
}

function generateDiff(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { readonly text: string; readonly firstChangedLine?: number } {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];
  const width = String(
    Math.max(oldContent.split("\n").length, newContent.split("\n").length),
  ).length;
  let oldLine = 1;
  let newLine = 1;
  let previousWasChange = false;
  let firstChangedLine: number | undefined;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    if (part.added === true || part.removed === true) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added === true) {
          output.push(`+${String(newLine).padStart(width, " ")} ${line}`);
          newLine += 1;
        } else {
          output.push(`-${String(oldLine).padStart(width, " ")} ${line}`);
          oldLine += 1;
        }
      }
      previousWasChange = true;
      continue;
    }

    const next = parts[index + 1];
    const nextIsChange = next?.added === true || next?.removed === true;
    if (previousWasChange && nextIsChange) {
      if (lines.length <= contextLines * 2) {
        ({ oldLine, newLine } = appendContext(output, lines, oldLine, newLine, width));
      } else {
        const leading = lines.slice(0, contextLines);
        const trailing = lines.slice(-contextLines);
        ({ oldLine, newLine } = appendContext(output, leading, oldLine, newLine, width));
        const skipped = lines.length - leading.length - trailing.length;
        output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += skipped;
        newLine += skipped;
        ({ oldLine, newLine } = appendContext(output, trailing, oldLine, newLine, width));
      }
    } else if (previousWasChange) {
      const shown = lines.slice(0, contextLines);
      ({ oldLine, newLine } = appendContext(output, shown, oldLine, newLine, width));
      const skipped = lines.length - shown.length;
      if (skipped > 0) {
        output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += skipped;
        newLine += skipped;
      }
    } else if (nextIsChange) {
      const skipped = Math.max(0, lines.length - contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += skipped;
        newLine += skipped;
      }
      ({ oldLine, newLine } = appendContext(
        output,
        lines.slice(skipped),
        oldLine,
        newLine,
        width,
      ));
    } else {
      oldLine += lines.length;
      newLine += lines.length;
    }
    previousWasChange = false;
  }

  return {
    text: output.join("\n"),
    ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
  };
}

function appendContext(
  output: string[],
  lines: readonly string[],
  oldLine: number,
  newLine: number,
  width: number,
): { readonly oldLine: number; readonly newLine: number } {
  for (const line of lines) {
    output.push(` ${String(oldLine).padStart(width, " ")} ${line}`);
    oldLine += 1;
    newLine += 1;
  }
  return { oldLine, newLine };
}

function assertEditGrant(grant: ToolAuthorizationGrant, absolutePath: string): void {
  assertActiveToolAuthorizationGrant(grant, { toolName: "edit" });
  const permits = (capability: "filesystem.read" | "filesystem.write"): boolean =>
    grant.capabilities.requirements.some((requirement) =>
      requirement.capability === capability && requirement.paths.includes(absolutePath)
    );
  if (!permits("filesystem.read") || !permits("filesystem.write")) {
    throw new Error(
      `Tool authorization Grant ${grant.grantId} does not allow editing "${absolutePath}"`,
    );
  }
}

function fileOperationError(
  operation: "access" | "read" | "write",
  path: string,
  error: unknown,
): ToolExecutionError {
  const code = fileErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT") {
    return new ToolExecutionError("not_found", `Could not edit file "${path}": not found`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ToolExecutionError(
      "permission_denied",
      `Could not ${operation} file "${path}": permission denied`,
    );
  }
  return new ToolExecutionError(
    "execution_failed",
    `Could not ${operation} file "${path}": ${message}`,
  );
}

function fileErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

function conflict(message: string): ToolExecutionError {
  return new ToolExecutionError("conflict", message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "Operation aborted",
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
