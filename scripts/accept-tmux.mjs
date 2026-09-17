import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  LocalTmuxBackend,
} from "../dist/tmux/providers/local.js";
import { NodeTmuxCommandRunner } from
  "../dist/tmux/providers/node-command-runner.js";
import { TmuxService } from "../dist/tmux/service.js";

const separator = "\u001f";

function snapshotLine(overrides = {}) {
  return [
    overrides.session ?? "wish-child-1",
    overrides.window ?? "scout",
    overrides.pane ?? "%7",
    overrides.dead ?? "0",
    overrides.deadStatus ?? "",
    overrides.currentCommand ?? "node",
    overrides.panePid ?? "4242",
    overrides.sessionId ?? "child-1",
    overrides.workspaceRoot ?? "/workspace",
    overrides.label ?? "scout",
    overrides.createdAt ?? "2026-09-12T12:00:00.000Z",
  ].join(separator);
}

function scriptedRunner(outputs = []) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push({ executable: request.executable, args: [...(request.args ?? [])] });
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next ?? { stdout: "", stderr: "" };
    },
  };
}

function target() {
  return Object.freeze({
    sessionId: "child-1",
    session: "wish-child-1",
    window: "scout",
    pane: "%7",
    target: "wish-child-1:scout.0",
    socketPath: "/tmp/wish.sock",
    attachCommand:
      "'tmux' -S '/tmp/wish.sock' attach-session -t 'wish-child-1'",
    captureCommand:
      "'tmux' -S '/tmp/wish.sock' capture-pane -p -J -t 'wish-child-1:scout.0'",
  });
}

test("private tmux command runner is synchronous and bounded", async () => {
  const runner = new NodeTmuxCommandRunner();
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    maxOutputBytes: 1024,
  });
  assert.deepEqual(result, { stdout: "out", stderr: "err" });
  await assert.rejects(
    runner.run({ executable: "bad\0command" }),
    /without null bytes/u,
  );
});

test("Local tmux start publishes real target and discovery metadata", async () => {
  const outputs = new Array(6).fill(undefined).map(() => ({ stdout: "", stderr: "" }));
  outputs.push({ stdout: `${snapshotLine()}\n`, stderr: "" });
  const runner = scriptedRunner(outputs);
  const tmux = new LocalTmuxBackend({
    socketPath: "/tmp/wish.sock",
    runner,
    now: () => "2026-09-12T12:00:00.000Z",
  });
  const result = await tmux.start({
    sessionId: "child-1",
    windowName: "scout",
    command: {
      executable: "node",
      args: ["wish-child.js"],
      cwd: "/workspace",
      environment: { WISH_CHILD: "1", WISH_DATA_DIR: "/workspace/.wish-child" },
    },
    metadata: {
      workspaceRoot: "/workspace",
      label: "scout",
    },
  });

  assert.equal(result.target.target, "wish-child-1:scout.0");
  assert.equal(result.target.socketPath, "/tmp/wish.sock");
  assert.match(result.target.attachCommand, /attach-session/u);
  assert.equal(result.active, true);
  assert.equal(result.metadata.label, "scout");
  assert.deepEqual(runner.calls[0].args.slice(0, 12), [
    "-S", "/tmp/wish.sock", "new-session", "-d", "-s", "wish-child-1",
    "-n", "scout", "-x", "120", "-y", "40",
  ]);
  assert.equal(runner.calls.some((call) =>
    call.args.includes("@wish_label") && call.args.includes("scout")
  ), true);
  assert.equal(runner.calls.some((call) => call.args.includes("remain-on-exit")), true);
  assert.equal(runner.calls[0].args.includes("WISH_CHILD=1"), true);
  assert.equal(runner.calls[0].args.includes("WISH_DATA_DIR=/workspace/.wish-child"), true);
});

test("Local tmux list is reconstructible, filterable, and preserves dead panes", async () => {
  const runner = scriptedRunner([{
    stdout: [
      snapshotLine(),
      snapshotLine({
        session: "wish-server-1",
        window: "dev",
        sessionId: "server-1",
        label: "dev server",
        dead: "1",
        deadStatus: "7",
      }),
      snapshotLine({ session: "foreign", sessionId: "foreign" }),
    ].join("\n"),
    stderr: "",
  }]);
  const tmux = new LocalTmuxBackend({ socketPath: "/tmp/wish.sock", runner });
  const sessions = await tmux.list({ workspaceRoot: "/workspace" });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].active, false);
  assert.equal(sessions[1].exitCode, 7);
  assert.equal(sessions[1].metadata.label, "dev server");
});

test("Local tmux capture, send, and stop stay transparent", async () => {
  const runner = scriptedRunner([
    { stdout: "0123456789", stderr: "" },
    { stdout: "", stderr: "" },
    { stdout: "", stderr: "" },
    { stdout: "", stderr: "" },
  ]);
  const tmux = new LocalTmuxBackend({ socketPath: "/tmp/wish.sock", runner });
  const address = target();
  const captured = await tmux.capture({ target: address, lines: 20, maxChars: 5 });
  await tmux.send({ target: address, text: "continue" });
  await tmux.stop({ target: address });

  assert.equal(captured, "56789\n[truncated]");
  assert.deepEqual(runner.calls[1].args.slice(-5), [
    "send-keys", "-t", "wish-child-1:scout.0", "-l", "continue",
  ]);
  assert.equal(runner.calls[2].args.at(-1), "Enter");
  assert.deepEqual(runner.calls[3].args.slice(-3), [
    "kill-session", "-t", "wish-child-1",
  ]);
});

test("Local tmux fails loud and treats an absent server as an empty index", async () => {
  const missing = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
  const unavailable = new LocalTmuxBackend({ runner: scriptedRunner([missing]) });
  await assert.rejects(
    unavailable.start({
      sessionId: "one",
      windowName: "main",
      command: { executable: "true", cwd: "/workspace" },
      metadata: { workspaceRoot: "/workspace" },
    }),
    (error) => error.code === "tmux_unavailable",
  );

  const absent = Object.assign(new Error("no server running"), {
    stderr: "no server running on /tmp/wish.sock",
  });
  const empty = new LocalTmuxBackend({ runner: scriptedRunner([absent]) });
  assert.deepEqual(await empty.list(), []);
});

test("Tmux Service supports Cordis replacement and unload", async () => {
  class FixtureTmux extends TmuxService {
    async start() { throw new Error("not used"); }
    async list() { return []; }
    async inspect() { return undefined; }
    async capture() { return ""; }
    async send() {}
    async stop() {}
  }
  const root = new Context();
  const seen = [];
  const consumer = root.plugin({
    inject: ["tmux"],
    apply(ctx) { seen.push(ctx.tmux); },
  });
  assert.equal(consumer.state, 0);
  const first = await root.plugin(FixtureTmux);
  await consumer.await();
  assert.equal(consumer.state, 2);
  assert.equal(seen.length, 1);
  await first.dispose();
  assert.equal(root.get("tmux"), undefined);
  assert.equal(consumer.state, 0);
  await root.plugin(FixtureTmux);
  await consumer.await();
  assert.equal(seen.length, 2);
  await root.fiber.dispose();
});
