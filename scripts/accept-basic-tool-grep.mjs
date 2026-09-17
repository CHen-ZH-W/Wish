import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { FilesystemSearchError } from
  "../dist/filesystem/search/errors.js";
import {
  DEFAULT_GREP_MATCH_LIMIT,
  createGrepTool,
} from "../dist/filesystem/search/consumers/model-tool.js";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
} from "../dist/tools/presentation/truncate.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

async function executeGrep(definition, input, options = {}) {
  const registry = new ToolRegistry();
  registry.register(definition);
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: `grep-${++callOrdinal}`,
    name: "grep",
    argumentsJson: JSON.stringify(input),
  });
  assert.equal(parsed.ok, true);
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize(authorizationInput) {
        options.onAuthorize?.(authorizationInput);
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "policy-1" };
      },
    },
  });
  return await executor.execute({
    call: parsed.call,
    context: basicToolContext(options.cwd ?? "/workspace"),
    scope,
    snapshot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function searchResult(options = {}) {
  return Object.freeze({
    root: options.root ?? "/workspace",
    rootKind: options.rootKind ?? "directory",
    matches: Object.freeze(options.matches ?? []),
    limitReached: options.limitReached ?? false,
  });
}

function match(path, lineNumber, lineText, options = {}) {
  return Object.freeze({
    path,
    lineNumber,
    lineText,
    before: Object.freeze(options.before ?? []),
    after: Object.freeze(options.after ?? []),
  });
}

test("defines the exact Grep schema, scheduling, recovery, and capability", () => {
  const definition = createGrepTool();
  assert.equal(definition.name, "grep");
  assert.equal(definition.executionMode, "parallel");
  assert.equal(definition.recoveryPolicy, "retry-safe");
  assert.equal(DEFAULT_GREP_MATCH_LIMIT, 100);
  assert.deepEqual(JSON.parse(definition.inputSchemaJson), {
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
        description: "Maximum matches to return, default 100",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  });
  assert.deepEqual(
    definition.resolveCapabilities({ pattern: "needle" }, { cwd: "/workspace" }),
    {
      requirements: [{ capability: "filesystem.read", paths: ["/workspace"] }],
    },
  );
});

test("strictly validates Grep input", () => {
  const definition = createGrepTool();
  assert.deepEqual(definition.parse({ pattern: "" }), {
    ok: true,
    input: { pattern: "" },
  });
  assert.equal(definition.parse({}).ok, false);
  assert.equal(definition.parse({ pattern: "x", ignoreCase: 1 }).ok, false);
  assert.equal(definition.parse({ pattern: "x", context: -1 }).ok, false);
  assert.equal(definition.parse({ pattern: "x", limit: 0 }).ok, false);
  assert.match(
    definition.parse({ pattern: "x", fallback: "node" }).message,
    /unsupported field "fallback"/u,
  );
});

test("fails closed without a Filesystem Search Provider", async () => {
  const result = await executeGrep(createGrepTool(), { pattern: "needle" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not_found");
  assert.equal(result.error.message, "Filesystem Search Provider is unavailable");
});

test("forwards one authorized request and formats stable context lines", async () => {
  const calls = [];
  const controller = new AbortController();
  const search = {
    policy: Object.freeze({
      schemaVersion: 1,
      version: "search-1",
      backend: "local-node",
      filesystemPolicyVersion: "filesystem-1",
    }),
    async search(request) {
      calls.push(request);
      return searchResult({
        root: "/workspace/src",
        matches: [match("/workspace/src/file.ts", 2, "needle", {
          before: [{ lineNumber: 1, text: "before" }],
          after: [{ lineNumber: 3, text: "after" }],
        })],
      });
    },
  };
  const result = await executeGrep(
    createGrepTool({ search }),
    {
      pattern: "Needle",
      path: "src",
      glob: "**/*.ts",
      ignoreCase: true,
      literal: true,
      context: 1,
      limit: 5,
    },
    {
      signal: controller.signal,
      onAuthorize(input) {
        assert.deepEqual(input.capabilities, {
          requirements: [{
            capability: "filesystem.read",
            paths: ["/workspace/src"],
          }],
        });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    path: "src",
    content: [{
      type: "text",
      text: "file.ts-1- before\nfile.ts:2: needle\nfile.ts-3- after",
    }],
    matches: 1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/workspace/src");
  assert.equal(calls[0].grant.subject.name, "grep");
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].contextLines, 1);
  assert.equal(calls[0].limit, 5);
});

test("preserves empty, match-limit, line, and total-output semantics", async () => {
  const empty = await executeGrep(createGrepTool({
    search: { async search() { return searchResult(); } },
  }), { pattern: "missing" });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.output, {
    path: ".",
    content: [{ type: "text", text: "No matches found" }],
    matches: 0,
  });

  const longLine = "🙂".repeat(GREP_MAX_LINE_LENGTH + 100);
  const matches = Array.from({ length: DEFAULT_GREP_MATCH_LIMIT }, (_, index) =>
    match(`/workspace/deep/file-${index}.ts`, index + 1, longLine)
  );
  const limited = await executeGrep(createGrepTool({
    search: {
      async search() {
        return searchResult({ matches, limitReached: true });
      },
    },
  }), { pattern: "." });
  assert.equal(limited.ok, true);
  assert.equal(limited.output.matches, DEFAULT_GREP_MATCH_LIMIT);
  assert.equal(limited.output.matchLimitReached, DEFAULT_GREP_MATCH_LIMIT);
  assert.equal(limited.output.linesTruncated, true);
  assert.equal(limited.output.truncation.truncatedBy, "bytes");
  assert.equal(
    Buffer.byteLength(limited.output.content[0].text, "utf8") <= DEFAULT_MAX_BYTES,
    true,
  );
  assert.equal(limited.output.content[0].text.includes("�"), false);
});

test("maps Provider validation, failure, and abort without fallback execution", async () => {
  const invalid = await executeGrep(createGrepTool({
    search: {
      async search() {
        throw new FilesystemSearchError("invalid_pattern", "invalid regex");
      },
    },
  }), { pattern: "[" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_input");
  assert.equal(invalid.error.message, "invalid regex");

  const failed = await executeGrep(createGrepTool({
    search: { async search() { throw new Error("provider failed"); } },
  }), { pattern: "x" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "execution_failed");
  assert.match(failed.error.message, /provider failed/u);

  const controller = new AbortController();
  const reason = new Error("grep cancelled");
  controller.abort(reason);
  const aborted = await executeGrep(createGrepTool({
    search: { async search() { throw new Error("must not run"); } },
  }), { pattern: "x" }, { signal: controller.signal });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.message, reason.message);
});
