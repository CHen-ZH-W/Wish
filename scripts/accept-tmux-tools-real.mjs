import assert from "node:assert/strict";
import { access, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { LocalFilesystemBackend } from "../dist/filesystem/providers/local.js";
import { LinuxNativeShellBackend } from "../dist/shell/providers/linux-native.js";
import { createTmuxTools } from "../dist/tmux/consumers/model-tools.js";
import { LocalTmuxBackend } from "../dist/tmux/providers/local.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const root = await mkdtemp(join(tmpdir(), "wish-tmux-tools-real-"));
const socket = join(root, "tmux.sock");
const escapeMarker = join(tmpdir(), `wish-tmux-tools-escape-${process.pid}`);
const filesystem = new LocalFilesystemBackend();
const shell = new LinuxNativeShellBackend(filesystem);
const tmux = new LocalTmuxBackend({ socketPath: socket, sessionPrefix: "wish-real" });
const registry = new ToolRegistry();
for (const definition of createTmuxTools({ shell, tmux })) registry.register(definition);
const context = basicToolContext(root, { filesystem, shell, profile: "workspace-write" });
const executor = new ToolExecutor({
  registry,
  authorization: {
    authorize() { return { status: "allowed", policyVersion: "policy-1" }; },
    revalidate() { return { status: "valid", policyVersion: "policy-1" }; },
  },
  grantId: (() => { let ordinal = 0; return () => `tmux-real-grant-${++ordinal}`; })(),
});
let call = 0;
let terminal;

try {
  const started = await execute("tmux_start", {
    id: "interactive",
    label: "interactive worker",
    command: [
      `if tmux new-window -d -n escape -- /bin/sh -lc ${shellQuote(`printf escaped > ${shellQuote(escapeMarker)}`)}; then`,
      "  printf 'tmux-control:open\\n'",
      "else",
      "  printf 'tmux-control:blocked\\n'",
      "fi",
      "printf 'ready\\n'",
      "read line",
      "printf 'received:%s\\n' \"$line\"",
    ].join("\n"),
    permissions: {
      filesystem: "write",
      network: false,
      externalSideEffect: false,
      destructive: false,
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  terminal = started.output.terminal;
  assert.equal(terminal.target.sessionId, "interactive");
  assert.match(terminal.target.attachCommand, /attach-session/u);
  assert.ok(terminal.runtimeDirectory);
  await access(terminal.runtimeDirectory);

  const initial = await waitForOutput(/ready/u);
  assert.match(initial, /tmux-control:blocked/u);
  await assert.rejects(access(escapeMarker), { code: "ENOENT" });
  const listed = await execute("tmux_list", {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.output.terminals.some(item => item.target.sessionId === "interactive"), true);

  const sent = await execute("tmux_send", { id: "interactive", text: "hello" });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.match(await waitForOutput(/received:hello/u), /received:hello/u);

  const exited = await waitForExit();
  assert.equal(exited.active, false);
  const retained = await execute("tmux_capture", { id: "interactive", lines: 50 });
  assert.equal(retained.ok, true, JSON.stringify(retained));
  assert.match(retained.output.content[0].text, /received:hello/u);

  const stopped = await execute("tmux_stop", { id: "interactive" });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  await assert.rejects(access(terminal.runtimeDirectory), { code: "ENOENT" });
  assert.equal((await tmux.list({ workspaceRoot: root })).length, 0);
  terminal = undefined;
  console.log("real authorized tmux Tool lifecycle passed");
} finally {
  if (terminal !== undefined) await tmux.stop({ target: terminal.target }).catch(() => undefined);
  await unlink(escapeMarker).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function execute(name, input) {
  const parsed = registry.parseCall({
    id: `tmux-real-call-${++call}`,
    name,
    argumentsJson: JSON.stringify(input),
  });
  assert.equal(parsed.ok, true);
  return executor.execute({
    call: parsed.call,
    context,
    scope: { runId: "run", userTurnId: "turn", stepId: `step-${call}` },
    snapshot: registry.captureSnapshot({ authorityVersion: context.permissions.authorityVersion }),
  });
}

async function waitForOutput(pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    const result = await execute("tmux_capture", { id: "interactive", lines: 50 });
    if (result.ok) {
      last = result.output.content[0].text;
      if (pattern.test(last)) return last;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for terminal output: ${JSON.stringify(last)}`);
}

async function waitForExit(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const item = (await tmux.list({ workspaceRoot: root }))
      .find(candidate => candidate.target.sessionId === "interactive");
    if (item !== undefined && !item.active) return item;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("timed out waiting for terminal exit");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
