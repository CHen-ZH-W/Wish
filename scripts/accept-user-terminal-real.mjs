import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DirectUserTerminal } from "../dist/terminal/providers/local.js";
import { HostUserTerminalRuntime } from "../dist/terminal/providers/host-runtime.js";

const root = await mkdtemp(join(tmpdir(), "wish-user-terminal-real-"));
let terminal, command;
try {
  const condaInit = process.env.CONDA_EXE ? join(dirname(dirname(process.env.CONDA_EXE)), "etc", "profile.d", "conda.sh") : undefined;
  await writeFile(join(root, ".bashrc"), [
    "export WISH_HOST_RC_LOADED=from-real-bashrc",
    "alias wish-host-alias='printf \"__WISH_HOST_ALIAS__ok\\n\"'",
    ...(condaInit && process.env.CONDA_PREFIX ? [
      `[[ ! -r ${bashQuote(condaInit)} ]] || builtin source ${bashQuote(condaInit)}`,
      `conda activate ${bashQuote(process.env.CONDA_PREFIX)} >/dev/null 2>&1 || true`,
    ] : []),
    "__wish_fixture_prompt() {",
    "  PS1=\"\\[\\e[1;36m\\](${CONDA_DEFAULT_ENV:-fixture-conda})\\[\\e[0m\\] \\[\\e[1;32m\\]host\\[\\e[0m\\]\\[\\e[90m\\]@\\[\\e[0m\\]\\[\\e[1;34m\\]wish\\[\\e[0m\\]:\\[\\e[35m\\]\\w\\[\\e[0m\\]\\n\\[\\e[1;33m\\]❯\\[\\e[0m\\] \"",
    "}",
    "PROMPT_COMMAND=__wish_fixture_prompt",
    "",
  ].join("\n"), "utf8");
  const runtime = new HostUserTerminalRuntime({
    environment: { ...process.env, HOME: root, SHELL: "/bin/bash", CONDA_DEFAULT_ENV: process.env.CONDA_DEFAULT_ENV ?? "fixture-conda" },
    shellCandidates: ["/bin/bash"],
  });
  command = await runtime.prepare(root, "/bin/bash", "real-host-terminal");
  assert.deepEqual(command.args, ["--rcfile", join(command.runtimeDirectory, "bashrc"), "-i"]);
  terminal = DirectUserTerminal.spawn(command, Object.freeze({
    id: "interactive-smoke", label: "bash", createdAt: new Date().toISOString(), active: true,
    authority: "host-user", shell: "bash", columns: 100, rows: 30,
  }), 1_000, 2 * 1024 * 1024, 250);

  const first = await attach(terminal, "attachment-a");
  await waitFor(() => terminalText(first.frames).includes("host@wish"), "host Bash prompt");
  await terminal.write("attachment-a", "printf '__WISH_RC__%s\\n' \"$WISH_HOST_RC_LOADED\"; wish-host-alias; printf 'wish-interactive-ready\\n'\r");
  await waitFor(() => terminalText(first.frames).includes("wish-interactive-ready"), "initial terminal output");
  const initialOutput = terminalRaw(first.frames);
  assert.match(stripAnsi(initialOutput), /host@wish/u, "the host shell must preserve its Bash prompt");
  assert.match(stripAnsi(initialOutput), /__WISH_RC__from-real-bashrc/u, "the host user's Bash startup file must run");
  assert.match(stripAnsi(initialOutput), /__WISH_HOST_ALIAS__ok/u, "aliases from the host user's Bash startup file must work");
  const promptColors = new Set([...initialOutput.matchAll(/\u001b\[(?:1;)?(3\d|90)m/gu)].map(match => match[1]));
  assert.equal(promptColors.size >= 4, true, `the host shell prompt must preserve multiple ANSI colors, received ${[...promptColors].join(",")}`);
  if (process.env.CONDA_EXE && process.env.CONDA_PREFIX) {
    assert.match(stripAnsi(initialOutput), /\(base\)|\([^\r\n()]+\)/u, "the host shell must show the active Conda environment");
    await terminal.write("attachment-a", "wish_conda_prefix=$CONDA_PREFIX; conda deactivate; printf '__WISH_CONDA_OFF__%s\\n' \"${CONDA_DEFAULT_ENV:-none}\"; conda activate \"$wish_conda_prefix\"; printf '__WISH_CONDA_ON__%s\\n' \"$CONDA_DEFAULT_ENV\"\r");
    const condaName = process.env.CONDA_DEFAULT_ENV ?? "base";
    await waitFor(() => terminalText(first.frames).includes("__WISH_CONDA_OFF__none\n")
      && terminalText(first.frames).includes(`__WISH_CONDA_ON__${condaName}\n`), "Conda deactivate and reactivate");
  }
  assert.doesNotMatch(initialOutput, /cannot find name|Permission denied/u, "the host shell must start without sandbox identity failures");

  first.controller.abort(); await first.following;
  assert.equal(terminal.view.active, true, "detaching a browser follower must not stop the direct PTY");
  const second = await attach(terminal, "attachment-b");
  const snapshot = second.frames[0];
  assert.equal(snapshot.type, "snapshot");
  assert.match(snapshot.screen, /wish-interactive-ready/u, "a new follower must recover the server-side terminal screen");

  await terminal.resize("attachment-b", 90, 28);
  await terminal.write("attachment-b", "stty size\r");
  await waitFor(() => terminalText(second.frames).includes("28 90"), "PTY resize");
  await terminal.write("attachment-b", "sleep 10\r");
  await new Promise(resolve => setTimeout(resolve, 100));
  await terminal.write("attachment-b", "\x03printf 'wish-after-interrupt\\n'\r");
  await waitFor(() => terminalText(second.frames).includes("wish-after-interrupt"), "Ctrl-C recovery");
  second.controller.abort(); await second.following;
  await terminal.close(); terminal = undefined; command = undefined;
  console.log("real direct host-user Terminal PTY smoke passed");
} finally {
  await terminal?.close().catch(() => undefined);
  if (!terminal && command?.runtimeDirectory) await rm(command.runtimeDirectory, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

async function attach(terminal, attachmentId) {
  const controller = new AbortController(), frames = [];
  const following = (async () => { for await (const frame of terminal.follow(attachmentId, controller.signal)) frames.push(frame); })();
  await waitFor(() => frames.length > 0, "terminal snapshot");
  return { controller, frames, following };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function terminalRaw(frames) {
  return frames.map(frame => frame.type === "snapshot" ? frame.screen : frame.type === "output" ? frame.data : "").join("");
}

function terminalText(frames) { return stripAnsi(terminalRaw(frames)); }

function stripAnsi(value) {
  return value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu, "").replaceAll("\r", "");
}

function bashQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
