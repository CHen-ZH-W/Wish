import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import {
  LocalFilesystem,
  LocalFilesystemBackend,
} from "../dist/filesystem/providers/local.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

async function executeFilesystem(input) {
  const registry = new ToolRegistry();
  registry.register({
    name: "filesystem-probe",
    description: "filesystem probe",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse(value) {
      return { ok: true, input: value };
    },
    resolveCapabilities() {
      return {
        requirements: [{
          capability: input.capability,
          paths: [input.grantPath ?? input.path],
        }],
      };
    },
    execute(_value, context, grant, signal) {
      return input.operation(context, grant, signal);
    },
  });
  const authorityVersion = input.authorityVersion ?? "authority-1";
  const snapshot = registry.captureSnapshot({ authorityVersion });
  const parsed = registry.parseCall({
    id: `filesystem-${++callOrdinal}`,
    name: "filesystem-probe",
    argumentsJson: "{}",
  });
  assert.equal(parsed.ok, true);
  const context = input.context ?? basicToolContext(input.root, {
    filesystem: input.filesystem,
    authorityVersion,
  });
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
    context,
    scope,
    snapshot,
  });
}

test("Local Filesystem policy is deterministic and deeply immutable", () => {
  const first = new LocalFilesystemBackend();
  const second = new LocalFilesystemBackend();
  const changed = new LocalFilesystemBackend({ maxFileBytes: 1024 });
  assert.equal(first.policy.version, second.policy.version);
  assert.notEqual(first.policy.version, changed.policy.version);
  assert.equal(Object.isFrozen(first.policy), true);
  assert.equal(Object.isFrozen(first.policy.protectedDirectoryNames), true);
  assert.deepEqual(first.policy.protectedDirectoryNames, [".git", ".wish"]);
  assert.equal(first.policy.protectedNameExceptions.includes(".env.example"), true);
});

test("authorized reads, writes, parent creation, stat, and durability succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-filesystem-local-"));
  const filesystem = new LocalFilesystemBackend();
  try {
    const source = join(root, "source.txt");
    await writeFile(source, "hello", "utf8");
    const read = await executeFilesystem({
      root,
      filesystem,
      capability: "filesystem.read",
      path: source,
      operation: async (context, grant, signal) =>
        Buffer.from(await filesystem.readFile({
          path: source,
          context,
          grant,
          signal,
        })).toString("utf8"),
    });
    assert.equal(read.ok, true);
    assert.equal(read.output, "hello");

    const target = join(root, "nested", "result.txt");
    const write = await executeFilesystem({
      root,
      filesystem,
      capability: "filesystem.write",
      path: target,
      operation: async (context, grant, signal) => {
        await filesystem.writeFile({
          path: target,
          data: Buffer.from("durable", "utf8"),
          createParents: true,
          context,
          grant,
          signal,
        });
        return "written";
      },
    });
    assert.equal(write.ok, true);
    assert.equal(await readFile(target, "utf8"), "durable");

    const stat = await executeFilesystem({
      root,
      filesystem,
      capability: "filesystem.read",
      path: join(root, "nested"),
      operation: (context, grant, signal) => filesystem.stat({
        path: "nested",
        access: "read",
        allowWorkspaceRoot: true,
        context,
        grant,
        signal,
      }),
    });
    assert.equal(stat.ok, true);
    assert.equal(stat.output.kind, "directory");
    assert.equal(stat.output.relativePath, "nested");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace escapes, protected names, and symbolic links fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-filesystem-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "wish-filesystem-outside-"));
  const filesystem = new LocalFilesystemBackend();
  try {
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    await writeFile(join(root, ".env"), "TOKEN=secret", "utf8");
    await symlink(outsideFile, join(root, "link.txt"));
    await symlink(outside, join(root, "linked-parent"));

    for (const path of [outsideFile, join(root, ".env"), join(root, "link.txt")]) {
      const result = await executeFilesystem({
        root,
        filesystem,
        capability: "filesystem.read",
        path,
        operation: (context, grant, signal) => filesystem.readFile({
          path,
          context,
          grant,
          signal,
        }),
      });
      assert.equal(result.ok, false);
      assert.match(
        result.error.message,
        /outside the Workspace|protected|Symbolic links/u,
      );
    }

    const linkedWrite = join(root, "linked-parent", "new.txt");
    const result = await executeFilesystem({
      root,
      filesystem,
      capability: "filesystem.write",
      path: linkedWrite,
      operation: (context, grant, signal) => filesystem.writeFile({
        path: linkedWrite,
        data: Buffer.from("blocked"),
        createParents: true,
        context,
        grant,
        signal,
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Symbolic links/u);
    await assert.rejects(readFile(join(outside, "new.txt")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("exact Grants, ceilings, policy generations, and AbortSignal are enforced", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-filesystem-authority-"));
  const filesystem = new LocalFilesystemBackend();
  try {
    const target = join(root, "target.txt");
    await writeFile(target, "target", "utf8");
    const wrongGrant = await executeFilesystem({
      root,
      filesystem,
      capability: "filesystem.read",
      path: target,
      grantPath: join(root, "other.txt"),
      operation: (context, grant, signal) => filesystem.readFile({
        path: target,
        context,
        grant,
        signal,
      }),
    });
    assert.equal(wrongGrant.ok, false);
    assert.match(wrongGrant.error.message, /Grant does not include filesystem.read/u);

    const baseContext = basicToolContext(root, { filesystem });
    const staleContext = Object.freeze({
      ...baseContext,
      permissions: Object.freeze({
        ...baseContext.permissions,
        filesystemPolicyVersion: "stale-filesystem-policy",
      }),
    });
    const stale = await executeFilesystem({
      root,
      filesystem,
      context: staleContext,
      capability: "filesystem.read",
      path: target,
      operation: (context, grant, signal) => filesystem.readFile({
        path: target,
        context,
        grant,
        signal,
      }),
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error.message, /another Filesystem policy generation/u);

    const controller = new AbortController();
    const reason = new Error("stop filesystem");
    controller.abort(reason);
    await assert.rejects(
      filesystem.resolve({
        path: target,
        access: "read",
        context: baseContext,
        grant: Object.freeze({}),
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cordis installs, replaces, and removes the Filesystem Provider", async () => {
  const root = new Context();
  const states = Object.freeze({ pending: 0, active: 2 });
  const generations = [];
  const consumer = root.plugin({
    inject: ["filesystem"],
    apply(ctx) {
      generations.push(ctx.filesystem);
    },
  });
  assert.equal(consumer.state, states.pending);

  try {
    const provider = root.plugin(LocalFilesystem, { maxFileBytes: 1024 });
    await provider.await();
    await consumer.await();
    assert.equal(consumer.state, states.active);
    assert.equal(root.filesystem.policy.maxFileBytes, 1024);

    const first = root.filesystem;
    await provider.update({ maxFileBytes: 2048 });
    await new Promise((resolve) => setImmediate(resolve));
    await consumer.await();
    assert.notEqual(root.filesystem, first);
    assert.equal(root.filesystem.policy.maxFileBytes, 2048);
    assert.equal(generations.length, 2);

    await provider.dispose();
    assert.equal(root.get("filesystem"), undefined);
    assert.equal(consumer.state, states.pending);
  } finally {
    await root.fiber.dispose();
  }
});
