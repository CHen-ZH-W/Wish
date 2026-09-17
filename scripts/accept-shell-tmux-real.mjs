import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { LocalFilesystemBackend } from "../dist/filesystem/providers/local.js";
import { LinuxNativeShellBackend } from "../dist/shell/providers/linux-native.js";
import { createBashTool } from "../dist/shell/consumers/model-tool.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const root = await mkdtemp(join(tmpdir(), "wish-shell-tmux-real-"));
const runtime = join(root, "runtime");
const socket = join(runtime, "tmux.sock");
const worker = join(root, "worker.sh");
const filesystem = new LocalFilesystemBackend();
const shell = new LinuxNativeShellBackend(filesystem);
let call = 0;

try {
  await mkdir(runtime);
  await writeFile(worker, [
    "#!/bin/sh",
    "printf 'ready\\n'",
    "read line",
    "printf 'received:%s\\n' \"$line\"",
  ].join("\n"), "utf8");
  await chmod(worker, 0o700);

  const started = await bash(
    `TMPDIR="$PWD/runtime" tmux -S "$PWD/runtime/tmux.sock" new-session -d -s wish-transparent -n worker "$PWD/worker.sh" && tmux -S "$PWD/runtime/tmux.sock" set-option -p -t wish-transparent:worker.0 remain-on-exit on`,
  );
  assert.equal(started.ok, true, JSON.stringify(started));
  const initial = await waitForOutput(/ready/u);
  assert.match(initial, /ready/u);

  const listed = await bash(
    `tmux -S "$PWD/runtime/tmux.sock" list-sessions -F '#{session_name}'`,
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.match(listed.output.content[0].text, /wish-transparent/u);

  const sent = await bash(
    `tmux -S "$PWD/runtime/tmux.sock" send-keys -t wish-transparent:worker.0 -l hello && tmux -S "$PWD/runtime/tmux.sock" send-keys -t wish-transparent:worker.0 Enter`,
  );
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const completed = await waitForOutput(/received:hello/u);
  assert.match(completed, /received:hello/u);

  const stopped = await bash(
    `tmux -S "$PWD/runtime/tmux.sock" kill-server`,
  );
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  console.log("real synchronous Bash to transparent tmux smoke passed");
} finally {
  await bash(`tmux -S "$PWD/runtime/tmux.sock" kill-server`).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function waitForOutput(pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCaptured;
  for (;;) {
    const captured = await bash(
      `tmux -S "$PWD/runtime/tmux.sock" capture-pane -p -J -t wish-transparent:worker.0`,
    );
    lastCaptured = captured;
    if (captured.ok && pattern.test(captured.output.content[0].text)) {
      return captured.output.content[0].text;
    }
    if (Date.now() >= deadline) {
      const log = await readFile(worker, "utf8");
      throw new Error(
        `timed out waiting for tmux output; captured=${JSON.stringify(lastCaptured)}; worker=${log}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function bash(command) {
  const registry = new ToolRegistry();
  registry.register(createBashTool({ shell }));
  const context = basicToolContext(root, { shell, filesystem });
  const snapshot = registry.captureSnapshot({
    authorityVersion: context.permissions.authorityVersion,
  });
  const parsed = registry.parseCall({
    id: `shell-tmux-real-${++call}`,
    name: "bash",
    argumentsJson: JSON.stringify({
      command,
      permissions: {
        filesystem: "write",
        network: false,
        externalSideEffect: true,
        destructive: false,
      },
    }),
  });
  assert.equal(parsed.ok, true);
  return await new ToolExecutor({
    registry,
    authorization: {
      authorize() { return { status: "allowed", policyVersion: "policy-1" }; },
      revalidate() { return { status: "valid", policyVersion: "policy-1" }; },
    },
  }).execute({
    call: parsed.call,
    context,
    scope: Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" }),
    snapshot,
  });
}
