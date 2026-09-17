import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalTmuxBackend } from "../dist/tmux/providers/local.js";

const directory = await mkdtemp(join(tmpdir(), "wish-tmux-real-"));
const socketPath = join(directory, "tmux.sock");
const tmux = new LocalTmuxBackend({
  socketPath,
});

try {
  const started = await tmux.start({
    sessionId: "real-smoke",
    windowName: "shell",
    command: {
      executable: "/bin/sh",
      args: ["-lc", "printf 'ready\\n'; read line; printf 'received:%s\\n' \"$line\""],
      cwd: process.cwd(),
    },
    metadata: {
      workspaceRoot: process.cwd(),
      label: "real tmux smoke",
    },
  });
  await waitUntil(async () => (await tmux.capture({ target: started.target })).includes("ready"));
  await tmux.send({ target: started.target, text: "hello" });
  const completed = await waitUntil(async () => {
    const snapshot = await tmux.inspect(started.target);
    return snapshot?.active === false ? snapshot : undefined;
  });
  const output = await tmux.capture({ target: started.target });

  assert.equal(completed.active, false);
  assert.equal(
    completed.exitCode === undefined || completed.exitCode === 0,
    true,
  );
  assert.match(output, /ready/u);
  assert.match(output, /received:hello/u);
  assert.equal((await tmux.list()).some((item) =>
    item.target.sessionId === "real-smoke" && item.active === false
  ), true);
  await tmux.stop({ target: started.target });
  assert.equal(await tmux.inspect(started.target), undefined);
  console.log("real tmux transparency smoke passed");
} finally {
  await tmux.stop({
    target: {
      sessionId: "real-smoke",
      session: "wish-real-smoke",
      window: "shell",
      pane: "%0",
      target: "wish-real-smoke:shell.0",
      socketPath,
      attachCommand: "",
      captureCommand: "",
    },
  }).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

async function waitUntil(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for tmux state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
