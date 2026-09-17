import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { createReadTool as createReadToolDefinition } from
  "../dist/filesystem/consumers/model-tools/read.js";
import { LocalFilesystemBackend } from
  "../dist/filesystem/providers/local.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "../dist/tools/presentation/truncate.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

function createReadTool(options = {}) {
  return createReadToolDefinition({
    filesystem: new LocalFilesystemBackend(),
    ...options,
  });
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function executeRead(definition, input, options = {}) {
  const registry = new ToolRegistry();
  registry.register(definition);
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: `read-${++callOrdinal}`,
    name: "read",
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
    context: basicToolContext(options.cwd ?? "/workspace", {
      modelSupportsImages: options.modelSupportsImages,
    }),
    scope,
    snapshot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

test("defines the exact Read schema, scheduling, recovery, and capability", () => {
  const definition = createReadTool();
  assert.equal(definition.name, "read");
  assert.equal(definition.executionMode, "parallel");
  assert.equal(definition.recoveryPolicy, "retry-safe");
  assert.deepEqual(JSON.parse(definition.inputSchemaJson), {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read, relative to cwd or absolute",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "First line to read, using one-based line numbers",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to read",
      },
    },
    required: ["path"],
    additionalProperties: false,
  });
  assert.deepEqual(
    definition.resolveCapabilities({ path: "nested/file.txt" }, { cwd: "/workspace" }),
    {
      requirements: [{
        capability: "filesystem.read",
        paths: ["/workspace/nested/file.txt"],
      }],
    },
  );
});

test("accepts only a path and positive one-based offset and limit", () => {
  const definition = createReadTool();
  assert.deepEqual(definition.parse({ path: "file.txt" }), {
    ok: true,
    input: { path: "file.txt" },
  });
  assert.equal(definition.parse({ path: "", offset: 1 }).ok, false);
  assert.equal(definition.parse({ path: "file.txt", offset: 0 }).ok, false);
  assert.equal(definition.parse({ path: "file.txt", offset: 1.5 }).ok, false);
  assert.equal(definition.parse({ path: "file.txt", limit: -1 }).ok, false);
  assert.match(
    definition.parse({ path: "file.txt", sha256: "hash" }).message,
    /unsupported field "sha256"/u,
  );
});

test("reads UTF-8 text with one-based offset, limit, and continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-read-tool-"));
  try {
    await writeFile(join(directory, "file.txt"), "one\nhé🙂\nthree\nfour", "utf8");
    const result = await executeRead(
      createReadTool(),
      { path: "file.txt", offset: 2, limit: 2 },
      { cwd: directory },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, {
      path: "file.txt",
      content: [{
        type: "text",
        text: "hé🙂\nthree\n\n[1 more lines in file. Use offset=4 to continue.]",
      }],
      nextOffset: 4,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies the shared line limit when no input limit is provided", async () => {
  const lines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) =>
    `line-${index + 1}`
  );
  const result = await executeRead(
    createReadTool({
      operations: {
        async access() {},
        async readFile() {
          return Buffer.from(lines.join("\n"));
        },
      },
    }),
    { path: "large.txt" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.truncation.truncatedBy, "lines");
  assert.equal(result.output.truncation.outputLines, DEFAULT_MAX_LINES);
  assert.equal(result.output.nextOffset, DEFAULT_MAX_LINES + 1);
  assert.match(
    result.output.content[0].text,
    new RegExp(`Use offset=${DEFAULT_MAX_LINES + 1} to continue\\.\\]$`, "u"),
  );
});

test("applies the shared byte limit without splitting UTF-8", async () => {
  const content = Array.from({ length: 100 }, () => "🙂".repeat(150)).join("\n");
  assert.equal(Buffer.byteLength(content, "utf8") > DEFAULT_MAX_BYTES, true);
  const result = await executeRead(
    createReadTool({
      operations: {
        async access() {},
        async readFile() {
          return Buffer.from(content);
        },
      },
    }),
    { path: "unicode.txt" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.truncation.truncatedBy, "bytes");
  assert.equal(result.output.truncation.outputBytes <= DEFAULT_MAX_BYTES, true);
  assert.equal(result.output.content[0].text.includes("�"), false);
  assert.equal(result.output.nextOffset, result.output.truncation.outputLines + 1);
});

test("returns an actionable note when the first line alone exceeds the byte limit", async () => {
  const result = await executeRead(
    createReadTool({
      operations: {
        async access() {},
        async readFile() {
          return Buffer.from("x".repeat(DEFAULT_MAX_BYTES + 1));
        },
      },
    }),
    { path: "one-line.txt" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.truncation.firstLineExceedsLimit, true);
  assert.equal(result.output.nextOffset, undefined);
  assert.match(result.output.content[0].text, /Use bash to inspect this line/u);
});

test("detects supported image signatures and omits images for text-only models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-read-image-"));
  try {
    const fixtures = [
      ["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
      [
        "image.png",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/png",
      ],
      ["image.gif", Buffer.from("GIF89a", "ascii"), "image/gif"],
      ["image.webp", Buffer.from("RIFF0000WEBP", "ascii"), "image/webp"],
    ];
    for (const [name, buffer, mimeType] of fixtures) {
      await writeFile(join(directory, name), buffer);
      const result = await executeRead(
        createReadTool(),
        { path: name },
        { cwd: directory, modelSupportsImages: true },
      );
      assert.equal(result.ok, true);
      assert.equal(result.output.content[1].type, "image");
      assert.equal(result.output.content[1].mimeType, mimeType);
      assert.equal(result.output.content[1].data, buffer.toString("base64"));
    }

    const omitted = await executeRead(
      createReadTool(),
      { path: "image.png" },
      { cwd: directory, modelSupportsImages: false },
    );
    assert.equal(omitted.ok, true);
    assert.equal(omitted.output.content.length, 1);
    assert.match(omitted.output.content[0].text, /does not support images/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses injected operations and image processor with the authorized path", async () => {
  const calls = [];
  const controller = new AbortController();
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const definition = createReadTool({
    operations: {
      async access(path, signal) {
        calls.push(["access", path, signal]);
      },
      async detectImageMimeType(path, signal) {
        calls.push(["detect", path, signal]);
        return "image/png";
      },
      async readFile(path, signal) {
        calls.push(["read", path, signal]);
        return raw;
      },
    },
    imageProcessor: {
      async process(image, signal) {
        calls.push(["process", image, signal]);
        return { type: "image", data: "resized", mimeType: "image/jpeg" };
      },
    },
  });
  const result = await executeRead(
    definition,
    { path: "image.bin" },
    {
      cwd: "/remote/work",
      modelSupportsImages: true,
      signal: controller.signal,
      onAuthorize(input) {
        assert.deepEqual(input.capabilities, {
          requirements: [{
            capability: "filesystem.read",
            paths: ["/remote/work/image.bin"],
          }],
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output.content, [
    { type: "text", text: "Read image file [image/jpeg]" },
    { type: "image", data: "resized", mimeType: "image/jpeg" },
  ]);
  assert.deepEqual(calls, [
    ["access", "/remote/work/image.bin", controller.signal],
    ["detect", "/remote/work/image.bin", controller.signal],
    ["read", "/remote/work/image.bin", controller.signal],
    [
      "process",
      { type: "image", data: raw.toString("base64"), mimeType: "image/png" },
      controller.signal,
    ],
  ]);
});

test("returns stable missing-file and out-of-range errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-read-errors-"));
  try {
    const missing = await executeRead(
      createReadTool(),
      { path: "missing.txt" },
      { cwd: directory },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "not_found");
    assert.match(missing.error.message, /file not found/u);

    await writeFile(join(directory, "short.txt"), "one\ntwo", "utf8");
    const beyond = await executeRead(
      createReadTool(),
      { path: "short.txt", offset: 3 },
      { cwd: directory },
    );
    assert.equal(beyond.ok, false);
    assert.equal(beyond.error.code, "invalid_input");
    assert.match(beyond.error.message, /beyond end of file \(2 lines total\)/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports an in-flight abort instead of successful completion", async () => {
  const controller = new AbortController();
  const readStarted = deferred();
  const execution = executeRead(
    createReadTool({
      operations: {
        async access() {},
        async detectImageMimeType() {
          return null;
        },
        readFile(_path, signal) {
          readStarted.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    }),
    { path: "file.txt" },
    { signal: controller.signal },
  );

  await readStarted.promise;
  controller.abort(new Error("read cancelled"));
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "aborted");
  assert.equal(result.error.message, "read cancelled");
});
