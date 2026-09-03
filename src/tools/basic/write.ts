import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertActiveToolAuthorizationGrant,
  type ToolAuthorizationGrant,
} from "../../core/tools/authorization.js";
import type { ToolDefinition, ToolInputParseResult } from "../../core/tools/tool.js";
import type { BasicToolContext } from "../support/context.js";
import { withFileMutationQueue } from "../support/mutation-queue.js";
import { resolveToCwd } from "../support/path.js";

export interface WriteToolInput {
  readonly path: string;
  readonly content: string;
}

export interface WriteToolOutput {
  readonly path: string;
  readonly bytesWritten: number;
}

export interface WriteOperations {
  mkdir(directory: string, signal?: AbortSignal): Promise<void>;
  writeFile(
    absolutePath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WriteToolOptions {
  readonly operations?: WriteOperations;
}

const WRITE_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file to write, relative to cwd or absolute",
    },
    content: {
      type: "string",
      description: "Complete content that will replace the file",
    },
  },
  required: ["path", "content"],
  additionalProperties: false,
});

const DEFAULT_WRITE_OPERATIONS: WriteOperations = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  async writeFile(absolutePath, content, signal) {
    if (signal === undefined) {
      await writeFile(absolutePath, content, "utf8");
      return;
    }
    await writeFile(absolutePath, content, { encoding: "utf8", signal });
  },
};

export function createWriteTool(
  options: WriteToolOptions = {},
): ToolDefinition<"write", WriteToolInput, WriteToolOutput, BasicToolContext> {
  const operations = options.operations ?? DEFAULT_WRITE_OPERATIONS;
  return {
    name: "write",
    description:
      "Create a file or completely overwrite it, creating parent directories when needed.",
    inputSchemaJson: WRITE_INPUT_SCHEMA,
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse: parseWriteInput,
    resolveCapabilities(input, context) {
      return {
        requirements: [{
          capability: "filesystem.write",
          paths: [resolveToCwd(input.path, context.cwd)],
        }],
      };
    },
    async execute(input, context, grant, signal) {
      const absolutePath = resolveToCwd(input.path, context.cwd);
      return await withFileMutationQueue(
        absolutePath,
        async () => {
          throwIfAborted(signal);
          assertWriteGrant(grant, absolutePath);
          await operations.mkdir(dirname(absolutePath), signal);

          throwIfAborted(signal);
          assertWriteGrant(grant, absolutePath);
          await operations.writeFile(absolutePath, input.content, signal);
          throwIfAborted(signal);
          return {
            path: input.path,
            bytesWritten: Buffer.byteLength(input.content, "utf8"),
          };
        },
        signal,
      );
    },
  };
}

function parseWriteInput(
  input: Readonly<Record<string, unknown>>,
): ToolInputParseResult<WriteToolInput> {
  const unsupported = Object.keys(input).filter(
    (key) => key !== "path" && key !== "content",
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `Write input contains unsupported field "${unsupported[0]}"`,
    };
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    return { ok: false, message: "Write path must be a non-empty string" };
  }
  if (typeof input.content !== "string") {
    return { ok: false, message: "Write content must be a string" };
  }
  return { ok: true, input: { path: input.path, content: input.content } };
}

function assertWriteGrant(
  grant: ToolAuthorizationGrant,
  absolutePath: string,
): void {
  assertActiveToolAuthorizationGrant(grant, { toolName: "write" });
  const authorized = grant.capabilities.requirements.some((requirement) =>
    requirement.capability === "filesystem.write" &&
    requirement.paths.includes(absolutePath)
  );
  if (!authorized) {
    throw new Error(
      `Tool authorization Grant ${grant.grantId} does not allow writing "${absolutePath}"`,
    );
  }
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
