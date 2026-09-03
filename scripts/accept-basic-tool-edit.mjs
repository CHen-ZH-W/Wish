import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { createEditTool } from "../dist/tools/basic/edit.js";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

function deferred() {
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function executeEdit(definition, input, options = {}) {
  const registry = new ToolRegistry();
  registry.register(definition);
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: `edit-${++callOrdinal}`,
    name: "edit",
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

test("defines the exact Edit scheduling, recovery, schema, and capabilities", () => {
  const definition = createEditTool();
  assert.equal(definition.name, "edit");
  assert.equal(definition.executionMode, "sequential");
  assert.equal(definition.recoveryPolicy, "needs-reconciliation");
  const schema = JSON.parse(definition.inputSchemaJson);
  assert.deepEqual(schema.required, ["path", "edits"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.edits.minItems, 1);
  assert.equal(schema.properties.edits.items.additionalProperties, false);
  assert.deepEqual(
    definition.resolveCapabilities(
      { path: "nested/file.txt", edits: [{ oldText: "old", newText: "new" }] },
      { cwd: "/workspace" },
    ),
    {
      requirements: [
        { capability: "filesystem.read", paths: ["/workspace/nested/file.txt"] },
        { capability: "filesystem.write", paths: ["/workspace/nested/file.txt"] },
      ],
    },
  );
});

test("strictly validates path and the multi-edit shape", () => {
  const definition = createEditTool();
  assert.equal(definition.parse({ path: "file.txt", edits: [] }).ok, false);
  assert.equal(definition.parse({ path: "", edits: [{}] }).ok, false);
  assert.equal(
    definition.parse({
      path: "file.txt",
      edits: [{ oldText: "", newText: "new" }],
    }).ok,
    false,
  );
  assert.match(
    definition.parse({
      path: "file.txt",
      edits: [{ oldText: "old", newText: "new", occurrence: 1 }],
    }).message,
    /unsupported field "occurrence"/u,
  );
  assert.match(
    definition.parse({
      path: "file.txt",
      edits: [{ oldText: "old", newText: "new" }],
      expectedSha256: "hash",
    }).message,
    /unsupported field "expectedSha256"/u,
  );
});

test("applies disjoint edits against the original file in reverse position order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-edit-tool-"));
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
    const result = await executeEdit(
      createEditTool(),
      {
        path: "file.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      },
      { cwd: directory },
    );

    assert.equal(result.ok, true);
    assert.equal(await readFile(path, "utf8"), "ALPHA\nbeta\nGAMMA\n");
    assert.equal(result.output.path, "file.txt");
    assert.equal(result.output.editsApplied, 2);
    assert.equal(result.output.firstChangedLine, 1);
    assert.match(result.output.diff, /-1 alpha/u);
    assert.match(result.output.diff, /\+1 ALPHA/u);
    assert.match(result.output.diff, /-3 gamma/u);
    assert.match(result.output.diff, /\+3 GAMMA/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects non-unique and overlapping edits without changing the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-edit-conflict-"));
  try {
    const duplicatePath = join(directory, "duplicate.txt");
    await writeFile(duplicatePath, "aaaa", "utf8");
    const duplicate = await executeEdit(
      createEditTool(),
      { path: "duplicate.txt", edits: [{ oldText: "aa", newText: "x" }] },
      { cwd: directory },
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, "conflict");
    assert.match(duplicate.error.message, /Found 3 occurrences/u);
    assert.equal(await readFile(duplicatePath, "utf8"), "aaaa");

    const overlapPath = join(directory, "overlap.txt");
    await writeFile(overlapPath, "abcdef", "utf8");
    const overlap = await executeEdit(
      createEditTool(),
      {
        path: "overlap.txt",
        edits: [
          { oldText: "abc", newText: "ABC" },
          { oldText: "bcde", newText: "BCDE" },
        ],
      },
      { cwd: directory },
    );
    assert.equal(overlap.ok, false);
    assert.equal(overlap.error.code, "conflict");
    assert.match(overlap.error.message, /overlap/u);
    assert.equal(await readFile(overlapPath, "utf8"), "abcdef");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes matching while preserving UTF-8 BOM and CRLF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-edit-normalize-"));
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, "\uFEFFtitle\u00A0\u2014 \u201cHello\u201d  \r\nsecond\r\n", "utf8");
    const result = await executeEdit(
      createEditTool(),
      {
        path: "file.txt",
        edits: [{ oldText: 'title - "Hello"\n', newText: "changed\n" }],
      },
      { cwd: directory },
    );

    assert.equal(result.ok, true);
    assert.equal(await readFile(path, "utf8"), "\uFEFFchanged\r\nsecond\r\n");
    assert.equal(result.output.editsApplied, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses injected operations and requests both capabilities for one resolved path", async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await executeEdit(
    createEditTool({
      operations: {
        async access(path, signal) {
          calls.push(["access", path, signal]);
        },
        async readFile(path, signal) {
          calls.push(["readFile", path, signal]);
          return Buffer.from("old\n", "utf8");
        },
        async writeFile(path, content, signal) {
          calls.push(["writeFile", path, content, signal]);
        },
      },
    }),
    { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
    {
      cwd: "/remote/work",
      signal: controller.signal,
      onAuthorize(input) {
        assert.deepEqual(input.capabilities.requirements, [
          { capability: "filesystem.read", paths: ["/remote/work/file.txt"] },
          { capability: "filesystem.write", paths: ["/remote/work/file.txt"] },
        ]);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["access", "/remote/work/file.txt", controller.signal],
    ["readFile", "/remote/work/file.txt", controller.signal],
    ["writeFile", "/remote/work/file.txt", "new\n", controller.signal],
  ]);
});

test("serializes concurrent edits to the same file across Executors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-edit-concurrent-"));
  try {
    const path = join(directory, "file.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");
    const [first, second] = await Promise.all([
      executeEdit(
        createEditTool(),
        { path, edits: [{ oldText: "alpha", newText: "ALPHA" }] },
        { cwd: directory },
      ),
      executeEdit(
        createEditTool(),
        { path, edits: [{ oldText: "beta", newText: "BETA" }] },
        { cwd: directory },
      ),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(await readFile(path, "utf8"), "ALPHA\nBETA\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns stable missing-file and in-flight abort failures", async () => {
  const missingDirectory = await mkdtemp(join(tmpdir(), "wish-edit-missing-"));
  try {
    const missing = await executeEdit(
      createEditTool(),
      { path: "missing.txt", edits: [{ oldText: "old", newText: "new" }] },
      { cwd: missingDirectory },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "not_found");
  } finally {
    await rm(missingDirectory, { recursive: true, force: true });
  }

  const controller = new AbortController();
  const writeStarted = deferred();
  const execution = executeEdit(
    createEditTool({
      operations: {
        async access() {},
        async readFile() {
          return Buffer.from("old", "utf8");
        },
        writeFile(_path, _content, signal) {
          writeStarted.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    }),
    { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
    { cwd: "/workspace", signal: controller.signal },
  );
  await writeStarted.promise;
  controller.abort(new Error("edit cancelled"));
  const aborted = await execution;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.message, "edit cancelled");
});
