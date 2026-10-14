import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const directory = await mkdtemp(join(tmpdir(), "wish-workspace-sidebar-http-"));
let booted;
try {
  await writeFile(join(directory, "visible.txt"), "visible from Files\n", "utf8");
  await writeFile(join(directory, "pixel.bin"), Buffer.from([0, 1, 2, 255]));
  booted = await bootstrap({
    surface: "webui",
    cwd: directory,
    homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_TMUX_ENABLED: "0", CORDIS_HMR: "0" },
    management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
  });
  const context = booted.surfaceContext;
  assert.equal(context.get("tmux"), undefined, "User Terminal must remain available when tmux is disabled");
  assert.equal(booted.context.loader.resolve("include:tmux-session-feature").disabled, true,
    "the tmux observation feature must follow the product tmux switch instead of remaining pending");
  const sessionId = randomUUID();
  await context.get("sessions").manager.create({ sessionId, agentId: context.get("agents").agentId, scope: directory });
  await context.get("sessionPermissions").port.initialize(sessionId, "approval-required");
  const baseUrl = booted.context.get("webManagementHost").url;
  const bootstrapResponse = await fetch(`${baseUrl}/api/management/bootstrap`);
  const bootstrapBody = await bootstrapResponse.json();
  const headers = { "content-type": "application/json", "x-wish-management-token": bootstrapBody.token };
  const serviceProbe = await context.get("userTerminal").create({ ownerSessionId: sessionId, workspaceRoot: directory });
  assert.equal(serviceProbe.authority, "host-user", "User Terminal authority is independent of the Agent permission profile");
  await context.get("userTerminal").close(sessionId, directory, serviceProbe.id);
  const files = await json(`${baseUrl}/api/sessions/${sessionId}/queries/workspace-files`, headers, { operation: "list", path: "." });
  assert.equal(files.value.root, directory);
  assert.equal(files.value.entries.some(entry => entry.name === "visible.txt"), true);
  const preview = await json(`${baseUrl}/api/sessions/${sessionId}/queries/workspace-files`, headers, { operation: "read", path: "visible.txt" });
  assert.equal(preview.value.content, "visible from Files\n");
  const binary = await json(`${baseUrl}/api/sessions/${sessionId}/queries/workspace-files`, headers, { operation: "read-bytes", path: "pixel.bin" });
  assert.equal(binary.value.contentBase64, Buffer.from([0, 1, 2, 255]).toString("base64"));
  const shells = await json(`${baseUrl}/api/sessions/${sessionId}/controls/user-terminal`, headers, { action: "shells" });
  assert.equal(shells.value.shells.some(shell => shell.path === "/bin/bash"), true);
  const created = await json(`${baseUrl}/api/sessions/${sessionId}/controls/user-terminal`, headers, { action: "create", shellPath: "/bin/bash" });
  assert.equal(created.value.authority, "host-user");
  assert.equal(created.value.shell, "bash");
  const blockedArchive = await fetch(`${baseUrl}/api/sessions/${sessionId}/archive`, { method: "POST", headers, body: "{}" });
  assert.equal(blockedArchive.status, 409, "a retained User Terminal must veto Session archive");
  const attachmentId = randomUUID(), streamAbort = new AbortController();
  const stream = await fetch(`${baseUrl}/api/sessions/${sessionId}/streams/user-terminal?terminalId=${created.value.id}&attachmentId=${attachmentId}`, { signal: streamAbort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  let received = await readUntil(reader, decoder, "event: terminal.snapshot");
  await json(`${baseUrl}/api/sessions/${sessionId}/controls/user-terminal`, headers, { action: "write", terminalId: created.value.id, attachmentId, text: "printf 'http-terminal-ready\\n'\r" });
  received += await readUntil(reader, decoder, "http-terminal-ready");
  assert.match(received, /event: terminal.output/u);
  assert.match(received, /http-terminal-ready/u);
  streamAbort.abort(); await reader.cancel().catch(() => undefined);
  await json(`${baseUrl}/api/sessions/${sessionId}/controls/user-terminal`, headers, { action: "close", terminalId: created.value.id });
  console.log("real WebUI Files and User Terminal HTTP smoke passed");
} finally {
  await booted?.dispose();
  await rm(directory, { recursive: true, force: true });
}

async function readUntil(reader, decoder, expected) {
  const deadline = Date.now() + 5_000;
  let text = "";
  while (Date.now() < deadline && !text.includes(expected)) {
    const next = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), Math.max(1, deadline - Date.now()))) ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  return text;
}

async function json(url, headers, body) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
