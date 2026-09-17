import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { LocalFilesystemBackend } from
  "../dist/filesystem/providers/local.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import {
  LocalFilesystemSearchBackend,
} from "../dist/filesystem/search/providers/local.js";
import { FilesystemAuthorityMismatchError } from
  "../dist/filesystem/errors.js";
import LocalFilesystemSearch from
  "../dist/filesystem/search/providers/local.js";
import { createGrepTool } from "../dist/filesystem/search/consumers/model-tool.js";
import { Grep as GrepToolPlugin } from "../dist/filesystem/search/consumers/plugin.js";
import Tools from "../dist/tools/service.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

async function executeLocal(root, filesystem, search, input, signal) {
  const registry = new ToolRegistry();
  registry.register(createGrepTool({ search }));
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: `local-search-${++callOrdinal}`,
    name: "grep",
    argumentsJson: JSON.stringify(input),
  });
  assert.equal(parsed.ok, true);
  return await new ToolExecutor({
    registry,
    authorization: {
      authorize() {
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "policy-1" };
      },
    },
  }).execute({
    call: parsed.call,
    context: basicToolContext(root, { filesystem }),
    scope,
    snapshot,
    ...(signal === undefined ? {} : { signal }),
  });
}

test("Local Filesystem Search is deterministic and bound to Filesystem generation", () => {
  const filesystem = new LocalFilesystemBackend();
  const first = new LocalFilesystemSearchBackend(filesystem);
  const second = new LocalFilesystemSearchBackend(filesystem);
  const changed = new LocalFilesystemSearchBackend(
    new LocalFilesystemBackend({ maxFileBytes: 1024 }),
  );
  assert.deepEqual(first.policy, second.policy);
  assert.notEqual(first.policy.version, changed.policy.version);
  assert.equal(first.policy.filesystemPolicyVersion, filesystem.policy.version);
  assert.equal(first.policy.maxFiles, 50_000);
  assert.equal(first.policy.maxDirectories, 10_000);
  assert.equal(Object.isFrozen(first.policy), true);
});

test("Local Filesystem Search handles regex, literal, glob, context, and protected files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-filesystem-search-"));
  const outside = await mkdtemp(join(tmpdir(), "wish-filesystem-search-outside-"));
  const filesystem = new LocalFilesystemBackend();
  const search = new LocalFilesystemSearchBackend(filesystem);
  try {
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "a.ts"), "before\nNeedle.value\nafter\n", "utf8");
    await writeFile(join(root, "nested", "b.ts"), "needle value\n", "utf8");
    await writeFile(join(root, "nested", "skip.js"), "needle value\n", "utf8");
    await writeFile(join(root, ".env"), "needle=secret\n", "utf8");
    await writeFile(join(root, ".git", "config"), "needle=secret\n", "utf8");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
    await writeFile(join(outside, "secret.ts"), "needle outside\n", "utf8");
    await symlink(outside, join(root, "linked"));

    const regex = await executeLocal(root, filesystem, search, {
      pattern: "needle[.]value",
      glob: "**/*.ts",
      ignoreCase: true,
      context: 1,
    });
    assert.equal(regex.ok, true);
    assert.equal(regex.output.matches, 1);
    assert.equal(
      regex.output.content[0].text,
      "a.ts-1- before\na.ts:2: Needle.value\na.ts-3- after",
    );
    assert.doesNotMatch(regex.output.content[0].text, /secret|outside/u);

    const literal = await executeLocal(root, filesystem, search, {
      pattern: "needle value",
      path: "nested",
      glob: "*.ts",
      literal: true,
    });
    assert.equal(literal.ok, true);
    assert.equal(literal.output.matches, 1);
    assert.equal(literal.output.content[0].text, "b.ts:1: needle value");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Local Filesystem Search fails clearly for invalid patterns and abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-filesystem-search-errors-"));
  const filesystem = new LocalFilesystemBackend();
  const search = new LocalFilesystemSearchBackend(filesystem);
  try {
    await writeFile(join(root, "a.txt"), "text\n", "utf8");
    const invalid = await executeLocal(root, filesystem, search, { pattern: "[" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "invalid_input");
    assert.match(invalid.error.message, /pattern is invalid/u);

    const controller = new AbortController();
    const reason = new Error("stop local search");
    controller.abort(reason);
    const aborted = await executeLocal(
      root,
      filesystem,
      search,
      { pattern: "text" },
      controller.signal,
    );
    assert.equal(aborted.ok, false);
    assert.equal(aborted.error.code, "aborted");
    assert.equal(aborted.error.message, reason.message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Filesystem Search bounds traversal and preserves authority failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-filesystem-search-bounds-"));
  const filesystem = new LocalFilesystemBackend();
  try {
    await writeFile(join(root, "a.txt"), "text\n", "utf8");
    await writeFile(join(root, "b.txt"), "text\n", "utf8");
    const bounded = new LocalFilesystemSearchBackend(filesystem, { maxFiles: 1 });
    const limited = await executeLocal(root, filesystem, bounded, { pattern: "text" });
    assert.equal(limited.ok, false);
    assert.equal(limited.error.code, "execution_failed");
    assert.match(limited.error.message, /1 files traversal limit/u);

    const context = basicToolContext(root, { filesystem });
    const authorityFailure = new FilesystemAuthorityMismatchError(
      join(root, "a.txt"),
      "test generation mismatch",
    );
    const failingFilesystem = {
      policy: filesystem.policy,
      async resolve(request) {
        return Object.freeze({
          requestedPath: request.path,
          path: request.path,
          relativePath: "a.txt",
          exists: true,
          kind: "file",
        });
      },
      async readFile() {
        throw authorityFailure;
      },
    };
    const failing = new LocalFilesystemSearchBackend(failingFilesystem);
    await assert.rejects(
      failing.search({
        pattern: "text",
        path: join(root, "a.txt"),
        contextLines: 0,
        limit: 1,
        context,
        grant: {},
      }),
      (error) => error === authorityFailure,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Grep Consumer follows Filesystem Search Provider lifecycle", async () => {
  const root = new Context();
  const states = Object.freeze({ pending: 0, active: 2 });
  const tool = root.plugin(GrepToolPlugin);
  assert.equal(tool.state, states.pending);
  try {
    await root.plugin(Tools);
    await root.plugin(LocalFilesystem);
    assert.equal(tool.state, states.pending);

    const search = await root.plugin(LocalFilesystemSearch);
    await tool.await();
    assert.equal(tool.state, states.active);
    assert.equal(root.tools.registry.has("grep"), true);

    await search.dispose();
    assert.equal(tool.state, states.pending);
    assert.equal(root.tools.registry.has("grep"), false);
  } finally {
    await root.fiber.dispose();
  }
});
