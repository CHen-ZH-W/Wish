import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { createWriteTool } from "../dist/tools/basic/write.js";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

function deferred() {
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function executeWrite(definition, input, options = {}) {
  const registry = new ToolRegistry();
  registry.register(definition);
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: `write-${++callOrdinal}`,
    name: "write",
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

test("defines the exact Write schema, scheduling, recovery, and capability", () => {
  const definition = createWriteTool();
  assert.equal(definition.name, "write");
  assert.equal(definition.executionMode, "sequential");
  assert.equal(definition.recoveryPolicy, "needs-reconciliation");
  assert.deepEqual(JSON.parse(definition.inputSchemaJson), {
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
  assert.deepEqual(
    definition.resolveCapabilities(
      { path: "nested/file.txt", content: "content" },
      { cwd: "/workspace" },
    ),
    {
      requirements: [{
        capability: "filesystem.write",
        paths: ["/workspace/nested/file.txt"],
      }],
    },
  );
});

test("rejects missing, invalid, and unsupported input without adding legacy controls", () => {
  const definition = createWriteTool();
  assert.equal(definition.parse({ path: "file.txt", content: "" }).ok, true);
  assert.equal(definition.parse({ path: "", content: "content" }).ok, false);
  assert.equal(definition.parse({ path: "file.txt" }).ok, false);
  assert.match(
    definition.parse({ path: "file.txt", content: "x", overwrite: true }).message,
    /unsupported field "overwrite"/u,
  );
  assert.match(
    definition.parse({ path: "file.txt", content: "x", expectedSha256: "hash" }).message,
    /unsupported field "expectedSha256"/u,
  );
});

test("creates parents, writes UTF-8 content, and completely overwrites files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-write-tool-"));
  try {
    const relativePath = "nested/file.txt";
    const first = await executeWrite(
      createWriteTool(),
      { path: relativePath, content: "hé🙂" },
      { cwd: directory },
    );
    assert.equal(first.ok, true);
    assert.deepEqual(first.output, { path: relativePath, bytesWritten: 7 });
    assert.equal(await readFile(join(directory, relativePath), "utf8"), "hé🙂");

    const second = await executeWrite(
      createWriteTool(),
      { path: relativePath, content: "" },
      { cwd: directory },
    );
    assert.equal(second.ok, true);
    assert.deepEqual(second.output, { path: relativePath, bytesWritten: 0 });
    assert.equal(await readFile(join(directory, relativePath), "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses injected operations and requests the resolved path capability", async () => {
  const calls = [];
  const controller = new AbortController();
  const path = "/remote/work/file.txt";
  const result = await executeWrite(
    createWriteTool({
      operations: {
        async mkdir(directory, signal) {
          calls.push(["mkdir", directory, signal]);
        },
        async writeFile(absolutePath, content, signal) {
          calls.push(["writeFile", absolutePath, content, signal]);
        },
      },
    }),
    { path: "file.txt", content: "replacement" },
    {
      cwd: "/remote/work",
      signal: controller.signal,
      onAuthorize(input) {
        assert.deepEqual(input.capabilities, {
          requirements: [{ capability: "filesystem.write", paths: [path] }],
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["mkdir", dirname(path), controller.signal],
    ["writeFile", path, "replacement", controller.signal],
  ]);
});

test("reports an in-flight abort and does not claim successful completion", async () => {
  const controller = new AbortController();
  const writeStarted = deferred();
  const execution = executeWrite(
    createWriteTool({
      operations: {
        async mkdir() {},
        writeFile(_absolutePath, _content, signal) {
          writeStarted.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    }),
    { path: "file.txt", content: "content" },
    { cwd: "/workspace", signal: controller.signal },
  );

  await writeStarted.promise;
  controller.abort(new Error("write cancelled"));
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "aborted");
  assert.equal(result.error.message, "write cancelled");
});
