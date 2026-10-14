import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  LocalTmuxBackend,
} from "../dist/tmux/providers/local.js";
import { NodeTmuxCommandRunner } from
  "../dist/tmux/providers/node-command-runner.js";
import { TmuxService } from "../dist/tmux/service.js";
import { createTmuxSessionFeature } from
  "../dist/tmux/consumers/session-feature.js";

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
    overrides.runtimeDirectory ?? "",
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
  const outputs = new Array(7).fill(undefined).map(() => ({ stdout: "", stderr: "" }));
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
    { stdout: `${snapshotLine()}\n`, stderr: "" },
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
  assert.deepEqual(runner.calls[4].args.slice(-3), [
    "kill-session", "-t", "wish-child-1",
  ]);
});

test("tmux Session feature retains each final terminal view until explicit deletion", async () => {
  let visible = [featureSnapshot("server-1", true), featureSnapshot("worker-1", false)];
  const captured = [], stopped = [];
  let tick = 0;
  const feature = createTmuxSessionFeature({
    agentId: "agent",
    async getSession(sessionId) {
      assert.equal(sessionId, "parent");
      return { agentId: "agent", status: "active", scope: "/workspace" };
    },
    async resolveWorkspaceRoot(scope) { assert.equal(scope, "/workspace"); return scope; },
    now: () => `2026-10-11T00:00:0${tick++}.000Z`,
    tmux: {
      async list(request) { assert.equal(request.workspaceRoot, "/workspace"); return visible; },
      async capture(request) { captured.push(request.target.sessionId); return `screen:${request.target.sessionId}:${captured.length}`; },
      async stop(request) { stopped.push(request.target.sessionId); visible = visible.filter(item => item.target.sessionId !== request.target.sessionId); },
    },
  });

  const initial = await feature.inspect("parent");
  assert.deepEqual(initial.actions.map(action => action.name), ["capture", "delete"]);
  assert.deepEqual(initial.data.captures, []);
  assert.equal(initial.token.schemaVersion, 1);
  await feature.act("parent", "capture", initial.token, "server-1");
  await feature.act("parent", "capture", initial.token, "worker-1");
  let inspected = await feature.inspect("parent");
  assert.deepEqual(inspected.data.captures.map(item => ({ id: item.sessionId, active: item.active })), [
    { id: "server-1", active: true },
    { id: "worker-1", active: false },
  ]);

  visible = [featureSnapshot("server-1", false), featureSnapshot("worker-1", false)];
  await feature.act("parent", "capture", inspected.token, "server-1");
  inspected = await feature.inspect("parent");
  assert.equal(inspected.data.captures.find(item => item.sessionId === "server-1").active, false, "the final dead-pane capture stops live polling");
  const deletedToken = inspected.token;
  await feature.act("parent", "delete", deletedToken, "server-1");
  let afterDelete = await feature.inspect("parent");
  assert.deepEqual(stopped, ["server-1"]);
  assert.equal(afterDelete.data.sessions.some(item => item.target.sessionId === "server-1"), false);
  assert.equal(afterDelete.data.captures.some(item => item.sessionId === "server-1"), false);

  visible = [featureSnapshot("server-1", true, "2026-10-11T01:00:00.000Z"), ...visible];
  await assert.rejects(feature.act("parent", "delete", deletedToken, "server-1"), /target changed/u,
    "a stale sidebar action must not delete a recreated terminal with the same id");
  assert.deepEqual(stopped, ["server-1"]);
  afterDelete = await feature.inspect("parent");
  assert.equal(afterDelete.data.sessions.some(item => item.target.sessionId === "server-1"), true);
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
  const missingSocket = Object.assign(new Error("socket missing"), {
    stderr: "error connecting to /tmp/wish.sock (No such file or directory)",
  });
  assert.deepEqual(await new LocalTmuxBackend({ runner: scriptedRunner([missingSocket]) }).list(), []);
});

function featureSnapshot(sessionId, active, createdAt = "2026-10-11T00:00:00.000Z") {
  return Object.freeze({
    target: Object.freeze({
      ...target(),
      sessionId,
      session: `wish-${sessionId}`,
      target: `wish-${sessionId}:main.0`,
      attachCommand: `tmux attach-session -t wish-${sessionId}`,
      captureCommand: `tmux capture-pane -p -t wish-${sessionId}:main.0`,
    }),
    metadata: Object.freeze({ workspaceRoot: "/workspace", label: sessionId }),
    createdAt,
    active,
    ...(active ? { currentCommand: "node", panePid: 4242 } : { exitCode: 0 }),
  });
}

test("Tmux Service supports Cordis replacement and unload", async () => {
  class FixtureTmux extends TmuxService {
    async start() { throw new Error("not used"); }
    async list() { return []; }
    async inspect() { return undefined; }
    async capture() { return ""; }
    async send() {}
    async attach() { throw new Error("not used"); }
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
