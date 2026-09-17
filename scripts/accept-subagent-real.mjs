import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalTmuxBackend } from "../dist/tmux/providers/local.js";
import {
  DomainSubagentRecordStore,
  SubagentRuntime,
} from "../dist/subagents/index.js";
import { TmuxSubagentExecutionBackend } from
  "../dist/subagents/providers/tmux-execution.js";
import { WishCliSubagentLauncherBackend } from
  "../dist/apps/cli/subagent-launcher.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";

const root = await mkdtemp(join(tmpdir(), "wish-subagent-real-"));
const workspace = join(root, "workspace");
const dataDirectory = join(root, "data");
const socketPath = join(root, "tmux.sock");
const modelsPath = join(root, "models.json");
let backend;
let kv;
let server;
let spawned;

try {
  await mkdir(workspace, { recursive: true });
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      assert.match(request.url ?? "", /chat\/completions/u);
      assert.match(body, /Inspect the transparent child/u);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "transparent child complete" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  await writeFile(modelsPath, `${JSON.stringify({
    schemaVersion: 1,
    defaultModel: "fixture/primary",
    maxRetries: 0,
    providers: [{
      id: "fixture",
      protocol: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      auth: { type: "none" },
      developerRoleMode: "native",
      request: {
        streamUsage: false,
        supportsTemperature: true,
        maxTokensField: "max_tokens",
        extraBody: {},
      },
      models: [{
        id: "primary",
        status: "active",
        contextWindowTokens: 4_096,
        maxOutputTokens: 1_024,
        input: { text: true, image: false },
        reasoning: false,
        toolCalling: true,
        developerRole: true,
      }],
    }],
  }, null, 2)}\n`, { mode: 0o600 });

  kv = new FileKvStorageBackend({
    backendId: "fixture",
    rootDirectory: join(root, "parent-kv"),
  });
  const storage = {
    backend(id) {
      assert.equal(id, "fixture");
      return { id, capabilities: { writerConcurrency: "single", kv: { list: true } }, kv };
    },
  };
  const launcher = new WishCliSubagentLauncherBackend({
    dataDirectory,
    modelsConfigurationPath: modelsPath,
  });
  backend = new SubagentRuntime({
    execution: new TmuxSubagentExecutionBackend(new LocalTmuxBackend({
      socketPath,
      sessionPrefix: "wish-real",
    })),
    store: new DomainSubagentRecordStore({ storage, backendId: "fixture" }),
    launcher,
    results: launcher.exchange,
    id: () => "child-real-1",
  });

  spawned = await backend.spawn({
    parentAgentId: "wish",
    parentSessionId: "parent-session-real",
    parentRunId: "parent-run-real",
    workspaceRoot: workspace,
    task: "Inspect the transparent child and answer concisely",
    role: "reviewer",
    permissionProfile: "read-only",
    availableTools: ["read", "grep"],
  });
  assert.equal(spawned.status, "running");
  assert.equal(spawned.target.locator.socketPath, socketPath);
  assert.match(spawned.target.attachCommand, /attach-session/u);

  const collected = await waitForResult(backend, spawned);
  assert.equal(collected.record.status, "exited");
  assert.equal(
    collected.record.result.status,
    "completed",
    JSON.stringify({ result: collected.record.result, output: collected.output }, null, 2),
  );
  assert.equal(collected.record.result.text, "transparent child complete");
  assert.match(collected.output ?? "", /transparent child complete/u);
  assert.equal(collected.record.childSessionId, "subagent-child-real-1");
  assert.equal(collected.record.childRunId, "subagent-run-child-real-1");

  const stopped = await backend.stop(access(spawned));
  assert.equal(stopped.status, "stopped");
  console.log("real transparent Wish Subagent in tmux passed");
} finally {
  if (spawned !== undefined) {
    await backend?.stop(access(spawned)).catch(() => undefined);
  }
  await backend?.close().catch(() => undefined);
  await kv?.close().catch(() => undefined);
  await new Promise((resolve) => server?.close(() => resolve()) ?? resolve());
  await rm(root, { recursive: true, force: true });
}

function access(record) {
  return {
    id: record.id,
    parentAgentId: record.parentAgentId,
    parentSessionId: record.parentSessionId,
    parentRunId: record.parentRunId,
    workspaceRoot: record.workspaceRoot,
  };
}

async function waitForResult(subagents, record) {
  const deadline = Date.now() + 20_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await subagents.collect({
      ...access(record),
      lines: 200,
      maxChars: 40_000,
    });
    if (latest.record.result !== undefined && latest.record.status === "exited") return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Subagent did not finish: ${JSON.stringify(latest)}`);
}
