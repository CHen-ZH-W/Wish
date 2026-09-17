import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { LocalWorkspace } from "../dist/workspace/providers/local.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-workspace-local-"));
  const workspace = join(directory, "workspace");
  const other = join(directory, "other");
  await mkdir(workspace);
  await mkdir(other);
  await symlink(workspace, join(directory, "workspace-link"), "dir");
  const root = new Context();
  root.provide("launch", { cwd: directory });
  await root.plugin(LocalWorkspace, {
    repositoryMarkers: [".wish-test-git"],
  });
  return {
    directory,
    workspace,
    other,
    service: root.workspace,
    async dispose() {
      await root.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function configuredFixture(config) {
  const directory = await mkdtemp(join(tmpdir(), "wish-workspace-configured-"));
  const root = new Context();
  root.provide("launch", { cwd: directory });
  await root.plugin(LocalWorkspace, {
    repositoryMarkers: [".wish-test-git"],
    ...config,
  });
  return {
    directory,
    service: root.workspace,
    async dispose() {
      await root.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Local Workspace canonicalizes roots and gives aliases one identity", async () => {
  const state = await fixture();
  try {
    const direct = await state.service.resolve({ root: "./workspace" });
    const repeated = await state.service.resolve({ root: "./workspace" });
    const alias = await state.service.resolve({ root: "./workspace-link" });
    const other = await state.service.resolve({ root: "./other" });

    assert.equal(direct.requestedRoot, state.workspace);
    assert.equal(direct.root, await realpath(state.workspace));
    assert.match(direct.fingerprint, /^workspace:sha256:[a-f0-9]{64}$/u);
    assert.match(direct.revision, /^workspace-revision:sha256:[a-f0-9]{64}$/u);
    assert.equal(repeated.fingerprint, direct.fingerprint);
    assert.equal(repeated.revision, direct.revision);
    assert.equal(alias.root, direct.root);
    assert.equal(alias.fingerprint, direct.fingerprint);
    assert.equal(alias.revision, direct.revision);
    assert.notEqual(other.fingerprint, direct.fingerprint);
    assert.equal(Object.isFrozen(direct), true);
    assert.equal(Object.isFrozen(direct.instructions), true);
    assert.deepEqual(direct.instructions, []);
    assert.equal(direct.repository, undefined);
  } finally {
    await state.dispose();
  }
});

test("Local Workspace maps invalid and unavailable roots to stable errors", async () => {
  const state = await fixture();
  try {
    for (const root of ["", " ", " workspace", "workspace ", "bad\0path"]) {
      await assert.rejects(
        () => state.service.resolve({ root }),
        (error) => error?.code === "workspace_invalid_root",
      );
    }
    await assert.rejects(
      () => state.service.resolve({ root: "./missing" }),
      (error) => error?.code === "workspace_root_not_found" &&
        error.requestedRoot === join(state.directory, "missing"),
    );

    const file = join(state.directory, "file.txt");
    await writeFile(file, "fixture");
    await assert.rejects(
      () => state.service.resolve({ root: "./file.txt" }),
      (error) => error?.code === "workspace_root_not_directory" &&
        error.requestedRoot === file,
    );

    await symlink(join(state.directory, "gone"), join(state.directory, "broken"));
    await assert.rejects(
      () => state.service.resolve({ root: "./broken" }),
      (error) => error?.code === "workspace_root_not_found",
    );
  } finally {
    await state.dispose();
  }
});

test("Local Workspace preserves cancellation instead of translating it", async () => {
  const state = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => state.service.resolve({
        root: "./workspace",
        signal: controller.signal,
      }),
      (error) => error?.name === "AbortError" && error?.code === 20,
    );
  } finally {
    await state.dispose();
  }
});

test("Local Workspace resolves Git identity and ordered instruction facts", async () => {
  const state = await fixture();
  try {
    const nested = join(state.workspace, "src");
    await mkdir(join(state.workspace, ".wish-test-git"));
    await mkdir(nested);
    await writeFile(join(state.workspace, "AGENTS.md"), "Root rules\n");
    await writeFile(join(nested, "AGENTS.local.md"), "Nested rules\n");

    const first = await state.service.resolve({ root: "./workspace/src" });
    assert.deepEqual(first.repository, {
      kind: "git",
      root: state.workspace,
      identity: first.repository.identity,
    });
    assert.match(first.repository.identity, /^git-repository:sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(
      first.instructions.map(({ source, content }) => ({ source, content })),
      [
        {
          source: join(state.workspace, "AGENTS.md"),
          content: "Root rules\n",
        },
        {
          source: join(nested, "AGENTS.local.md"),
          content: "Nested rules\n",
        },
      ],
    );
    assert.equal(
      first.instructions.every((instruction) =>
        instruction.authority === "developer" &&
        /^workspace-instruction:[a-f0-9]{64}$/u.test(instruction.id) &&
        /^sha256:[a-f0-9]{64}$/u.test(instruction.digest)
      ),
      true,
    );

    await writeFile(join(nested, "AGENTS.local.md"), "Changed nested rules\n");
    const changed = await state.service.resolve({ root: "./workspace/src" });
    assert.equal(changed.fingerprint, first.fingerprint);
    assert.equal(changed.repository.identity, first.repository.identity);
    assert.notEqual(changed.revision, first.revision);
    assert.notEqual(changed.instructions[1].digest, first.instructions[1].digest);
  } finally {
    await state.dispose();
  }
});

test("Local Workspace fails closed on oversized or escaping instructions", async () => {
  const limited = await configuredFixture({
    maxInstructionBytes: 5,
    maxInstructionFileBytes: 5,
  });
  try {
    await mkdir(join(limited.directory, "workspace"));
    await writeFile(join(limited.directory, "workspace", "AGENTS.md"), "123456");
    await assert.rejects(
      () => limited.service.resolve({ root: "./workspace" }),
      (error) => error?.code === "workspace_instruction_too_large" &&
        error.maxBytes === 5,
    );
  } finally {
    await limited.dispose();
  }

  const escaping = await configuredFixture({});
  try {
    const workspace = join(escaping.directory, "workspace");
    const outside = join(escaping.directory, "outside.md");
    await mkdir(workspace);
    await writeFile(outside, "Outside rules");
    await symlink(outside, join(workspace, "AGENTS.md"));
    await assert.rejects(
      () => escaping.service.resolve({ root: "./workspace" }),
      (error) => error?.code === "workspace_instruction_unavailable",
    );
  } finally {
    await escaping.dispose();
  }
});
