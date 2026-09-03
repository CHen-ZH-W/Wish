import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import {
  DEFAULT_GREP_MATCH_LIMIT,
  createGrepTool,
} from "../dist/tools/basic/grep.js";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
} from "../dist/tools/support/truncate.js";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

function matchEvent(path, lineNumber, lineText) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: lineText },
      line_number: lineNumber,
    },
  });
}

function fakeChildProcess(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };

  queueMicrotask(() => {
    if (options.hold === true) return;
    if (options.error !== undefined) {
      child.emit("error", options.error);
      return;
    }
    for (const event of options.events ?? []) child.stdout.write(`${event}\n`);
    if (options.stderr !== undefined) child.stderr.write(options.stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", options.code ?? 0, null);
  });
  return child;
}

function createFakeBackend(options = {}) {
  const calls = [];
  let child;
  const operations = {
    async isDirectory(path, signal) {
      calls.push(["isDirectory", path, signal]);
      if (options.statError !== undefined) throw options.statError;
      return options.isDirectory ?? true;
    },
    async readFile(path, signal) {
      calls.push(["readFile", path, signal]);
      if (options.readError !== undefined) throw options.readError;
      return options.files?.get(path) ?? "";
    },
    spawnRipgrep(executable, arguments_) {
      calls.push(["spawnRipgrep", executable, arguments_]);
      child = fakeChildProcess(options.process);
      return child;
    },
  };
  return { operations, calls, get child() { return child; } };
}

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
    context: { cwd: options.cwd ?? "/workspace" },
    scope,
    snapshot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function fixedResolver(path = "/tools/rg", calls = []) {
  return {
    async resolve(signal) {
      calls.push(["resolve", signal]);
      return path;
    },
  };
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
  assert.deepEqual(
    definition.resolveCapabilities(
      { pattern: "needle", path: "src" },
      { cwd: "/workspace" },
    ),
    {
      requirements: [{ capability: "filesystem.read", paths: ["/workspace/src"] }],
    },
  );
});

test("strictly validates Grep input without adding fallback controls", () => {
  const definition = createGrepTool();
  assert.deepEqual(definition.parse({ pattern: "" }), {
    ok: true,
    input: { pattern: "" },
  });
  assert.equal(definition.parse({}).ok, false);
  assert.equal(definition.parse({ pattern: "x", ignoreCase: 1 }).ok, false);
  assert.equal(definition.parse({ pattern: "x", context: -1 }).ok, false);
  assert.equal(definition.parse({ pattern: "x", context: 1.5 }).ok, false);
  assert.equal(definition.parse({ pattern: "x", limit: 0 }).ok, false);
  assert.match(
    definition.parse({ pattern: "x", fallback: "node" }).message,
    /unsupported field "fallback"/u,
  );
});

test("builds fixed ripgrep arguments and returns a stable empty result", async () => {
  const resolverCalls = [];
  const backend = createFakeBackend({ process: { code: 1 } });
  const result = await executeGrep(
    createGrepTool({
      operations: backend.operations,
      resolver: fixedResolver("/tools/rg", resolverCalls),
    }),
    {
      pattern: "Needle",
      path: "src",
      glob: "**/*.ts",
      ignoreCase: true,
      literal: true,
    },
    {
      cwd: "/workspace",
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
    content: [{ type: "text", text: "No matches found" }],
    matches: 0,
  });
  assert.deepEqual(resolverCalls, [["resolve", undefined]]);
  assert.deepEqual(backend.calls, [
    ["isDirectory", "/workspace/src", undefined],
    [
      "spawnRipgrep",
      "/tools/rg",
      [
        "--json",
        "--line-number",
        "--color=never",
        "--hidden",
        "--ignore-case",
        "--fixed-strings",
        "--glob",
        "**/*.ts",
        "--",
        "Needle",
        "/workspace/src",
      ],
    ],
  ]);
});

test("formats matching and surrounding lines with normalized relative paths", async () => {
  const controller = new AbortController();
  const file = "/workspace/src/file.ts";
  const backend = createFakeBackend({
    files: new Map([[file, "before\r\nneedle\r\nafter\r\nlast"]]),
    process: {
      events: [matchEvent(file, 2, "needle\n")],
    },
  });
  const result = await executeGrep(
    createGrepTool({
      operations: backend.operations,
      resolver: fixedResolver(),
    }),
    { pattern: "needle", path: "src", context: 1 },
    { cwd: "/workspace", signal: controller.signal },
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
  assert.deepEqual(backend.calls.at(-1), [
    "readFile",
    file,
    controller.signal,
  ]);
});

test("stops ripgrep at the requested match limit and returns a notice", async () => {
  const backend = createFakeBackend({
    process: {
      events: [
        matchEvent("/workspace/a.ts", 1, "one\n"),
        matchEvent("/workspace/a.ts", 2, "two\n"),
        matchEvent("/workspace/a.ts", 3, "three\n"),
      ],
    },
  });
  const result = await executeGrep(
    createGrepTool({ operations: backend.operations, resolver: fixedResolver() }),
    { pattern: ".", limit: 2 },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.matches, 2);
  assert.equal(result.output.matchLimitReached, 2);
  assert.match(result.output.content[0].text, /2 matches limit reached/u);
  assert.equal(result.output.content[0].text.includes("three"), false);
  assert.equal(backend.child.killCalls >= 1, true);
});

test("limits source lines and complete output without breaking UTF-8", async () => {
  const longLine = "🙂".repeat(GREP_MAX_LINE_LENGTH + 100);
  const events = Array.from({ length: DEFAULT_GREP_MATCH_LIMIT }, (_, index) =>
    matchEvent(`/workspace/deep/file-${index}.ts`, index + 1, `${longLine}\n`)
  );
  const backend = createFakeBackend({ process: { events } });
  const result = await executeGrep(
    createGrepTool({ operations: backend.operations, resolver: fixedResolver() }),
    { pattern: "." },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.matches, DEFAULT_GREP_MATCH_LIMIT);
  assert.equal(result.output.linesTruncated, true);
  assert.equal(result.output.truncation.truncatedBy, "bytes");
  assert.equal(
    Buffer.byteLength(result.output.content[0].text, "utf8") <= DEFAULT_MAX_BYTES,
    true,
  );
  assert.equal(result.output.content[0].text.includes("�"), false);
  assert.match(
    result.output.content[0].text,
    new RegExp(`truncated to ${GREP_MAX_LINE_LENGTH} characters`, "u"),
  );
  assert.match(result.output.content[0].text, /50\.0KB output limit reached/u);
});

test("returns stable errors for a missing resolver, path, and ripgrep failure", async () => {
  const noExecutable = await executeGrep(
    createGrepTool({
      resolver: { async resolve() { return undefined; } },
      operations: createFakeBackend().operations,
    }),
    { pattern: "x" },
  );
  assert.equal(noExecutable.ok, false);
  assert.equal(noExecutable.error.code, "not_found");
  assert.match(noExecutable.error.message, /ripgrep \(rg\) is not available/u);

  const notFound = Object.assign(new Error("missing"), { code: "ENOENT" });
  const missingPath = await executeGrep(
    createGrepTool({
      resolver: fixedResolver(),
      operations: createFakeBackend({ statError: notFound }).operations,
    }),
    { pattern: "x", path: "missing" },
  );
  assert.equal(missingPath.ok, false);
  assert.equal(missingPath.error.code, "not_found");
  assert.match(missingPath.error.message, /Grep path not found/u);

  const failedBackend = createFakeBackend({
    process: { code: 2, stderr: "regex parse error" },
  });
  const failed = await executeGrep(
    createGrepTool({
      resolver: fixedResolver(),
      operations: failedBackend.operations,
    }),
    { pattern: "[" },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "execution_failed");
  assert.equal(failed.error.message, "regex parse error");
});

test("abort terminates the active ripgrep process", async () => {
  const controller = new AbortController();
  const backend = createFakeBackend({ process: { hold: true } });
  const execution = executeGrep(
    createGrepTool({ operations: backend.operations, resolver: fixedResolver() }),
    { pattern: "needle" },
    { signal: controller.signal },
  );

  while (backend.child === undefined) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("grep cancelled"));
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "aborted");
  assert.equal(result.error.message, "grep cancelled");
  assert.equal(backend.child.killCalls, 1);
});
