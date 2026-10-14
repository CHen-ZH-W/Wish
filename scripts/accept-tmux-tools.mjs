import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import {
  createTmuxTools,
  TMUX_TOOL_NAMES,
} from "../dist/tmux/consumers/model-tools.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

function target(id = "server") {
  return Object.freeze({
    sessionId: id,
    session: `wish-agent-${id}`,
    window: "dev-server",
    pane: "%1",
    target: `wish-agent-${id}:dev-server.0`,
    socketPath: "/tmp/wish.sock",
    attachCommand: `tmux -S /tmp/wish.sock attach-session -t wish-agent-${id}`,
    captureCommand: `tmux -S /tmp/wish.sock capture-pane -p -t wish-agent-${id}:dev-server.0`,
  });
}

function snapshot(id = "server", active = true) {
  return Object.freeze({
    target: target(id),
    metadata: Object.freeze({ workspaceRoot: "/workspace", label: "dev server" }),
    createdAt: "2026-10-11T12:00:00.000Z",
    active,
    ...(active ? { currentCommand: "wish-linux-sandbox", panePid: 4242 } : { exitCode: 0 }),
  });
}

function harness() {
  const calls = [], authorizations = [];
  let terminals = [];
  const shell = {
    policy: Object.freeze({
      schemaVersion: 1,
      version: "shell-1",
      backend: "linux-native",
      filesystem: "path-scoped",
      network: "per-call",
      environment: "profile-scoped",
      automaticPermissionProfiles: Object.freeze(["workspace-write", "full-access"]),
      resourceLimits: Object.freeze({
        maxProcesses: 128,
        maxOpenFiles: 128,
        maxFileSizeBytes: 1_000_000,
        maxMemoryBytes: 1_000_000_000,
        maxTimeoutSeconds: 900,
      }),
      filesystemPolicyVersion: "filesystem-1",
    }),
    async preflight() { throw new Error("not used"); },
    async resolve(request) {
      calls.push(["resolve", request]);
      return Object.freeze({
        command: request.command,
        cwd: request.cwd,
        timeoutSeconds: request.timeoutSeconds,
        readPaths: Object.freeze(["."]),
        writePaths: Object.freeze(["."]),
        networkEnabled: false,
        policyVersion: "shell-1",
        context: request.context,
        grant: request.grant,
      });
    },
    async prepare(request) {
      calls.push(["prepare", request]);
      return Object.freeze({
        executable: "/native/wish-linux-sandbox",
        args: Object.freeze(["--", "/bin/sh", "-lc", request.spec.command]),
        cwd: request.spec.cwd,
        runtimeDirectory: "/tmp/wish-shell-terminal-fixture",
      });
    },
    async run() { throw new Error("not used"); },
  };
  const tmux = {
    async start(request) {
      calls.push(["start", request]);
      const started = Object.freeze({
        ...snapshot(request.sessionId),
        metadata: Object.freeze(request.metadata),
        runtimeDirectory: request.command.runtimeDirectory,
      });
      terminals = [started];
      return started;
    },
    async list(request) { calls.push(["list", request]); return terminals; },
    async inspect(address) { return terminals.find(item => item.target.sessionId === address.sessionId); },
    async capture(request) { calls.push(["capture", request]); return "ready\nlistening"; },
    async send(request) { calls.push(["send", request]); },
    async stop(request) { calls.push(["stop", request]); terminals = []; },
  };
  const registry = new ToolRegistry();
  for (const definition of createTmuxTools({ shell, tmux })) registry.register(definition);
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize(input) {
        authorizations.push(input);
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() { return { status: "valid", policyVersion: "policy-1" }; },
    },
    grantId: (() => { let ordinal = 0; return () => `grant-${++ordinal}`; })(),
  });
  const context = basicToolContext("/workspace", { shell, profile: "full-access" });
  let ordinal = 0;
  async function execute(name, input) {
    const parsed = registry.parseCall({
      id: `tmux-call-${++ordinal}`,
      name,
      argumentsJson: JSON.stringify(input),
    });
    assert.equal(parsed.ok, true);
    return executor.execute({
      call: parsed.call,
      context,
      scope: { runId: "run", userTurnId: "turn", stepId: `step-${ordinal}` },
      snapshot: registry.captureSnapshot({ authorityVersion: context.permissions.authorityVersion }),
    });
  }
  return { registry, execute, calls, authorizations };
}

test("tmux Tools expose explicit lifecycle operations instead of background Bash", () => {
  const fixture = harness();
  assert.deepEqual(fixture.registry.list().map(item => item.name), TMUX_TOOL_NAMES);
  const start = fixture.registry.list().find(item => item.name === "tmux_start");
  assert.equal(start.executionMode, "sequential");
  assert.equal(start.recoveryPolicy, "needs-reconciliation");
  assert.match(start.description, /session sidebar/u);
});

test("tmux_start passes the exact authorized command through Shell preparation", async () => {
  const fixture = harness();
  const result = await fixture.execute("tmux_start", {
    command: "npm run dev",
    id: "server",
    label: "dev server",
    permissions: {
      filesystem: "write",
      network: true,
      externalSideEffect: false,
      destructive: false,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output.terminal.target.sessionId, "server");
  assert.match(result.output.content[0].text, /Attach:/u);
  assert.equal(fixture.calls[0][0], "resolve");
  assert.equal(fixture.calls[0][1].command, "npm run dev");
  assert.equal(fixture.calls[1][0], "prepare");
  assert.equal(fixture.calls[2][0], "start");
  assert.equal(fixture.calls[2][1].command.executable, "/native/wish-linux-sandbox");
  assert.equal(fixture.calls[2][1].command.runtimeDirectory, "/tmp/wish-shell-terminal-fixture");
  assert.deepEqual(
    fixture.authorizations[0].capabilities.requirements.map(item => item.capability),
    ["process.exec", "filesystem.read", "filesystem.write", "network.connect", "runtime.control"],
  );
});

test("tmux lifecycle Tools rediscover by Workspace and operate on the real target", async () => {
  const fixture = harness();
  assert.equal((await fixture.execute("tmux_start", { command: "watch", id: "server" })).ok, true);
  const listed = await fixture.execute("tmux_list", {});
  const captured = await fixture.execute("tmux_capture", { id: "server", lines: 20 });
  const sent = await fixture.execute("tmux_send", { id: "server", text: "continue", enter: false });
  const stopped = await fixture.execute("tmux_stop", { id: "server" });
  assert.equal(listed.output.terminals.length, 1);
  assert.equal(captured.output.content[0].text, "ready\nlistening");
  assert.equal(sent.ok, true);
  assert.equal(stopped.ok, true);
  assert.equal((await fixture.execute("tmux_list", {})).output.terminals.length, 0);
  assert.equal(fixture.calls.some(([name, request]) => name === "send" && request.target.target === target().target), true);
  assert.equal(fixture.calls.some(([name, request]) => name === "stop" && request.target.target === target().target), true);
});

test("tmux Tool parsing rejects hidden background ambiguity and unknown targets", async () => {
  const fixture = harness();
  for (const [name, input] of [
    ["tmux_start", { command: "" }],
    ["tmux_start", { command: "server", id: "has spaces" }],
    ["tmux_send", { id: "server", text: 1 }],
    ["tmux_capture", { id: "server", lines: 0 }],
  ]) {
    const parsed = fixture.registry.parseCall({ id: `invalid-${name}`, name, argumentsJson: JSON.stringify(input) });
    assert.equal(parsed.ok, false);
  }
  const missing = await fixture.execute("tmux_capture", { id: "missing" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "not_found");
});
