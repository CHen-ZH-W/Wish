import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "wish-subagent-runtime-real-"));
const workspace = join(root, "workspace");
const dataDirectory = join(root, "data");
const socketPath = join(root, "tmux.sock");
const modelsPath = join(root, "models.json");
let server;
const requests = [];

try {
  await mkdir(workspace, { recursive: true });
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      const contents = payload.messages.map((message) =>
        typeof message.content === "string" ? message.content : ""
      );
      if (contents.some((content) => content.includes("Audit the transparent runtime bridge"))) {
        sendText(response, "child runtime evidence");
        return;
      }
      if (contents.some((content) => content.includes("Subagent result received") || (content.includes("Workflow wf-") && content.includes("child runtime evidence")))) {
        sendText(response, "parent integrated child evidence");
        return;
      }
      if (payload.messages.some((message) => message.role === "tool")) {
        sendText(response, "child launched; awaiting structured result");
        return;
      }
      sendToolCall(response, {
        id: "spawn-call-1",
        name: "spawn_agent",
        arguments: JSON.stringify({
          task: "Audit the transparent runtime bridge",
          role: "reviewer",
          permissionProfile: "read-only",
          availableTools: ["read", "grep"],
        }),
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  await writeFile(modelsPath, `${JSON.stringify(modelConfiguration(address.port), null, 2)}\n`, {
    mode: 0o600,
  });

  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("WISH_")) delete environment[name];
  }
  Object.assign(environment, {
    WISH_DATA_DIR: dataDirectory,
    WISH_TMUX_SOCKET: socketPath,
    WISH_SUBAGENT_TOOLS_ENABLED: "1",
    WISH_PERMISSION_PROFILE: "full-access",
    WISH_SHELL_PROVIDER: "host",
    WISH_SHELL_HOST_ENABLED: "1",
    WISH_MODEL_MAX_RETRIES: "0",
  });
  const result = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "dist/apps/cli/main.js"),
      "run",
      "--cwd", workspace,
      "--data-dir", dataDirectory,
      "--models-config", modelsPath,
      "Delegate this review and integrate the child result",
    ],
    {
      cwd: process.cwd(),
      env: environment,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const tmuxDiagnostic = await captureTmux(socketPath);
  assert.match(result.stdout, /child launched; awaiting structured result/u);
  assert.match(
    result.stdout,
    /parent integrated child evidence/u,
    `${summarizeRequests(requests)}\n${tmuxDiagnostic}`,
  );
  assert.match(result.stderr, /\[tool\] spawn_agent completed/u);
  assert.equal(
    requests.some((request) => {
      const messages = JSON.stringify(request.messages);
      return (messages.includes("Subagent result received") || messages.includes("Workflow wf-")) &&
        messages.includes("child runtime evidence");
    }),
    true,
    summarizeRequests(requests),
  );
  console.log("real Subagent completion hold and parent follow-up passed");
} finally {
  await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => undefined);
  await new Promise((resolve) => server?.close(() => resolve()) ?? resolve());
  await rm(root, { recursive: true, force: true });
}

async function captureTmux(socket) {
  try {
    const listed = await execFileAsync("tmux", [
      "-S", socket, "list-panes", "-a", "-F", "#{session_name}:#{window_name}.#{pane_index}",
    ]);
    const targets = listed.stdout.trim().split("\n").filter(Boolean);
    const captures = await Promise.all(targets.map(async (target) => {
      const captured = await execFileAsync("tmux", [
        "-S", socket, "capture-pane", "-p", "-J", "-S", "-80", "-t", target,
      ]);
      return `${target}\n${captured.stdout}`;
    }));
    return captures.join("\n");
  } catch (error) {
    return `tmux diagnostic unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function sendText(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
}

function summarizeRequests(values) {
  return JSON.stringify(values.map((request) => ({
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === "string"
        ? message.content.slice(0, 1_000)
        : message.content,
    })),
  })), null, 2);
}

function sendToolCall(response, call) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: call.arguments } }] }, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
}

function modelConfiguration(port) {
  return {
    schemaVersion: 1,
    defaultModel: "fixture/primary",
    maxRetries: 0,
    providers: [{
      id: "fixture",
      protocol: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
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
        contextWindowTokens: 8_192,
        maxOutputTokens: 1_024,
        input: { text: true, image: false },
        reasoning: false,
        toolCalling: true,
        developerRole: true,
      }],
    }],
  };
}
