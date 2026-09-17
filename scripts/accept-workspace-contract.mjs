import assert from "node:assert/strict";
import test from "node:test";

import "./accept-workspace-local.mjs";

import { Context } from "@deepseek-ai/cordis";

import {
  snapshotWorkspace,
  WorkspaceInstructionTooLargeError,
  WorkspaceInstructionUnavailableError,
  WorkspaceInvalidRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotFoundError,
  WorkspaceRootUnavailableError,
  WorkspaceService,
} from "../dist/workspace/index.js";

const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("Workspace service definition activates replaceable providers", async () => {
  const resolved = [];
  class FixtureWorkspace extends WorkspaceService {
    constructor(ctx, label) {
      super(ctx);
      this.label = label;
    }

    async resolve(request) {
      const snapshot = Object.freeze({
        requestedRoot: request.root,
        root: request.root,
        fingerprint: `fixture:${this.label}:${request.root}`,
        revision: `fixture:${this.label}:1`,
        instructions: Object.freeze([]),
      });
      resolved.push(snapshot);
      return snapshot;
    }
  }

  const root = new Context();
  const providers = [];
  const consumer = root.plugin({
    inject: ["workspace"],
    apply(ctx) {
      providers.push(ctx.workspace);
    },
  });

  assert.equal(consumer.state, fiberState.pending);
  const first = await root.plugin(FixtureWorkspace, "first");
  await consumer.await();
  assert.equal(consumer.state, fiberState.active);
  assert.equal(providers.length, 1);
  assert.equal((await providers[0].resolve({ root: "/workspace" })).root, "/workspace");

  await first.dispose();
  assert.equal(root.get("workspace"), undefined);
  assert.equal(consumer.state, fiberState.pending);

  await root.plugin(FixtureWorkspace, "second");
  await consumer.await();
  assert.equal(providers.length, 2);
  assert.match(
    (await providers[1].resolve({ root: "/workspace" })).fingerprint,
    /^fixture:second:/u,
  );
  assert.equal(resolved.length, 2);

  await root.fiber.dispose();
  assert.equal(consumer.state, fiberState.disposed);
});

test("Workspace errors expose stable codes and requested roots", () => {
  const cause = new Error("fixture");
  const cases = [
    [new WorkspaceInvalidRootError(""), "workspace_invalid_root", ""],
    [
      new WorkspaceRootNotFoundError("/missing", { cause }),
      "workspace_root_not_found",
      "/missing",
    ],
    [
      new WorkspaceRootNotDirectoryError("/file"),
      "workspace_root_not_directory",
      "/file",
    ],
    [
      new WorkspaceRootUnavailableError("/denied", { cause }),
      "workspace_root_unavailable",
      "/denied",
    ],
    [
      new WorkspaceInstructionUnavailableError(
        "/workspace",
        "/workspace/AGENTS.md",
        { cause },
      ),
      "workspace_instruction_unavailable",
      "/workspace",
    ],
    [
      new WorkspaceInstructionTooLargeError(
        "/workspace",
        "/workspace/AGENTS.md",
        1024,
      ),
      "workspace_instruction_too_large",
      "/workspace",
    ],
  ];

  for (const [error, code, requestedRoot] of cases) {
    assert.equal(error.code, code);
    assert.equal(error.requestedRoot, requestedRoot);
    assert.equal(error.name.endsWith("Error"), true);
  }
  assert.equal(cases[1][0].cause, cause);
  assert.equal(cases[3][0].cause, cause);
  assert.equal(cases[4][0].cause, cause);
});

test("Workspace Snapshot validation takes immutable ownership", () => {
  const source = {
    requestedRoot: "/workspace",
    root: "/workspace",
    fingerprint: "workspace:fixture",
    revision: "workspace-revision:fixture",
    instructions: [{
      id: "root-rules",
      authority: "developer",
      source: "/workspace/AGENTS.md",
      content: "Follow the rules.",
      digest: "sha256:fixture",
    }],
    repository: {
      kind: "git",
      root: "/workspace",
      identity: "git-repository:fixture",
    },
  };
  const snapshot = snapshotWorkspace(source);
  source.instructions[0].content = "mutated";
  source.repository.root = "/mutated";

  assert.equal(snapshot.instructions[0].content, "Follow the rules.");
  assert.equal(snapshot.repository.root, "/workspace");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.instructions), true);
  assert.equal(Object.isFrozen(snapshot.instructions[0]), true);
  assert.equal(Object.isFrozen(snapshot.repository), true);
  assert.throws(() => snapshotWorkspace({
    ...source,
    instructions: [source.instructions[0], source.instructions[0]],
  }), /Duplicate Workspace instruction id/u);
});
