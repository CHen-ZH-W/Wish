import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Service } from "@deepseek-ai/cordis";

import { LocalFilesystemBackend } from "../dist/filesystem/providers/local.js";
import LocalWorkspaceFiles from "../dist/workspace-files/providers/local.js";
import LocalUserTerminal from "../dist/terminal/providers/local.js";
import { HostUserTerminalRuntime } from "../dist/terminal/providers/host-runtime.js";

const filesystemPolicy = new LocalFilesystemBackend().policy;

class FixtureFilesystem extends Service {
  constructor(ctx) { super(ctx, "filesystem"); this.policy = filesystemPolicy; }
}
class FixtureWorkspace extends Service {
  constructor(ctx, root) { super(ctx, "workspace"); this.root = root; }
  async resolve(request) { return workspaceSnapshot(this.root, request.root); }
}

test("Workspace Files lists and previews bounded workspace data without following protected paths or symlinks", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "wish-workspace-files-"));
  const outside = await mkdtemp(join(tmpdir(), "wish-workspace-files-outside-"));
  const root = new Context();
  try {
    await Promise.all([
      writeFile(join(rootDirectory, "hello.txt"), "hello\n", "utf8"),
      writeFile(join(rootDirectory, "second.txt"), "second\n", "utf8"),
      writeFile(join(rootDirectory, "third.txt"), "third\n", "utf8"),
      writeFile(join(outside, "secret.txt"), "secret\n", "utf8"),
      writeFile(join(rootDirectory, "zz-pixel.bin"), Buffer.from([0, 1, 2, 255])),
      mkdir(join(rootDirectory, ".git")),
    ]);
    await symlink(join(outside, "secret.txt"), join(rootDirectory, "escape.txt"));
    await root.plugin(FixtureFilesystem);
    await root.plugin(class extends FixtureWorkspace { constructor(ctx) { super(ctx, rootDirectory); } });
    await root.plugin(LocalWorkspaceFiles, { maxEntries: 2, maxPreviewBytes: 5, maxBinaryBytes: 16 });
    const listing = await root.workspaceFiles.list(rootDirectory, ".");
    assert.equal(listing.root, rootDirectory);
    assert.deepEqual(listing.entries.map(item => item.name), ["hello.txt", "second.txt"]);
    assert.equal(listing.truncated, true);
    const preview = await root.workspaceFiles.read(rootDirectory, "hello.txt");
    assert.equal(preview.content, "hello");
    assert.equal(preview.truncated, true);
    const binary = await root.workspaceFiles.readBytes(rootDirectory, "zz-pixel.bin");
    assert.equal(binary.contentBase64, Buffer.from([0, 1, 2, 255]).toString("base64"));
    assert.equal(binary.size, 4);
    await assert.rejects(root.workspaceFiles.read(rootDirectory, "escape.txt"), error => error.code === "symbolic_link");
    await assert.rejects(root.workspaceFiles.readBytes(rootDirectory, "escape.txt"), error => error.code === "symbolic_link");
    await assert.rejects(root.workspaceFiles.list(rootDirectory, ".git"), error => error.code === "protected_path");
  } finally {
    await root.fiber.dispose();
    await Promise.all([rm(rootDirectory, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("Host User Terminal runtime preserves the real user startup contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-host-terminal-runtime-"));
  const home = join(root, "home");
  let prepared;
  try {
    await mkdir(home);
    await writeFile(join(home, ".bashrc"), "export WISH_HOST_RC_LOADED=yes\n", "utf8");
    const runtime = new HostUserTerminalRuntime({
      environment: { PATH: process.env.PATH, HOME: home, SHELL: "/bin/bash", CONDA_DEFAULT_ENV: "fixture-conda", WISH_INHERITED_VALUE: "kept" },
      shellCandidates: ["/bin/bash", "/bin/sh"],
    });
    const shells = await runtime.listShells();
    assert.equal(shells[0].path, "/bin/bash");
    assert.equal(shells.some(choice => choice.path === "/bin/sh"), true);
    prepared = await runtime.prepare(root, "/bin/bash", "session-host");
    assert.deepEqual(prepared.args, ["--rcfile", join(prepared.runtimeDirectory, "bashrc"), "-i"]);
    assert.equal(prepared.cwd, root);
    assert.equal(prepared.environment.COLORTERM, "truecolor");
    assert.equal(prepared.environment.WISH_INHERITED_VALUE, "kept");
    assert.equal(prepared.environment.CONDA_DEFAULT_ENV, "fixture-conda");
    assert.equal(prepared.environment.WISH_SESSION_ID, "session-host");
    const bashRc = await readFile(join(prepared.runtimeDirectory, "bashrc"), "utf8");
    assert.match(bashRc, /builtin source ~\/\.bashrc/u);
    assert.doesNotMatch(bashRc, /PS1=|PROMPT_COMMAND|conda activate/u, "Wish must not replace the user's Bash configuration");
    await assert.rejects(runtime.prepare(root, "/bin/not-a-wish-shell", "session-host"), error => error.code === "invalid_input");
  } finally {
    if (prepared?.runtimeDirectory) await rm(prepared.runtimeDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("User Terminal owns direct PTYs, Session binding, followers, and exclusive input control", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "wish-direct-terminal-"));
  const root = new Context();
  try {
    await root.plugin(class extends FixtureWorkspace { constructor(ctx) { super(ctx, workspaceRoot); } });
    await root.plugin(LocalUserTerminal, { maxTerminalsPerSession: 1, closeGraceMs: 100 });
    assert.equal((await root.userTerminal.listShells()).some(shell => shell.path === "/bin/bash"), true);
    const created = await root.userTerminal.create({ ownerSessionId: "session-a", workspaceRoot, shellPath: "/bin/bash" });
    assert.equal(created.authority, "host-user");
    assert.equal(created.shell, "bash");
    assert.equal(created.active, true);
    assert.equal(created.columns, 120);
    await assert.rejects(root.userTerminal.create({ ownerSessionId: "session-a", workspaceRoot }), error => error.code === "limit_reached");
    const first = follow(root.userTerminal, workspaceRoot, created.id, "attachment-a");
    await waitFor(() => first.frames.length > 0);
    assert.equal(first.frames[0].type, "snapshot");
    assert.equal(typeof first.frames[0].screen, "string");
    const second = follow(root.userTerminal, workspaceRoot, created.id, "attachment-b");
    await waitFor(() => second.frames.length > 0);
    await assert.rejects(root.userTerminal.write("session-a", workspaceRoot, created.id, "attachment-a", "pwd"), error => error.code === "control_unavailable");
    await assert.rejects(root.userTerminal.write("session-b", workspaceRoot, created.id, "attachment-a", "pwd"), error => error.code === "not_found");
    await root.userTerminal.resize("session-a", workspaceRoot, created.id, "attachment-b", 100, 30);
    await root.userTerminal.write("session-a", workspaceRoot, created.id, "attachment-b", "printf 'direct-provider-ready\\n'\r");
    await waitFor(() => second.frames.some(frame => frame.type === "output" && frame.data.includes("direct-provider-ready")));
    assert.equal((await root.userTerminal.list("session-a", workspaceRoot))[0].rows, 30);
    first.controller.abort(); second.controller.abort(); await Promise.all([first.following, second.following]);
    await root.userTerminal.close("session-a", workspaceRoot, created.id);
    assert.equal((await root.userTerminal.list("session-a", workspaceRoot)).length, 0);
  } finally { await root.fiber.dispose(); await rm(workspaceRoot, { recursive: true, force: true }); }
});

function workspaceSnapshot(root, requestedRoot) {
  return Object.freeze({ requestedRoot, root, fingerprint: `workspace:${root}`, revision: "revision-1", instructions: Object.freeze([]) });
}
function follow(service, workspaceRoot, terminalId, attachmentId) {
  const controller = new AbortController(), frames = [];
  const following = (async () => { for await (const frame of service.follow("session-a", workspaceRoot, terminalId, attachmentId, controller.signal)) frames.push(frame); })();
  return { controller, frames, following };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Timed out waiting for direct terminal state");
}
