import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournalStorageBackend } from "../dist/storage/providers/file/journal.js";
import { MemoryRuntime } from "../dist/memory/memory.js";
import { JournalMemoryStore } from "../dist/memory/store.js";
import { SubagentMemoryResources } from "../dist/memory/consumers/subagent-resources.js";
import { LocalTmuxBackend } from "../dist/tmux/providers/local.js";
import { SubagentRuntime } from "../dist/subagents/runtime.js";
import { MemorySubagentRecordStore } from "../dist/subagents/store.js";
import { TmuxSubagentExecutionBackend } from "../dist/subagents/providers/tmux-execution.js";
import { WishCliSubagentLauncherBackend } from "../dist/apps/cli/subagent-launcher.js";
import { FileSessionStore } from "../dist/sessions/providers/file/store.js";

const directory = await mkdtemp(join(tmpdir(), "wish-memory-child-real-"));
const workspace = join(directory, "workspace"), dataDirectory = join(directory, "parent-data");
const socketPath = join(directory, "tmux.sock"), modelsPath = join(directory, "models.json");
const requests = [];
let server, memory, journals, subagents, resources, child;

try {
  await mkdir(workspace, { recursive: true });
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      const toolMessages = payload.messages.filter(item => item.role === "tool");
      if (requests.length > 8) return sendText(response, "fixture refused repeated failed calls");
      if (toolMessages.some(item => item.tool_call_id === "memory-read-1")) return sendText(response, "Read the delegated memory Skill and applied its verification guidance.");
      return sendCall(response, "memory-read-1", "memory_read", { path: "skills/inspect/SKILL.md" });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await writeFile(modelsPath, JSON.stringify({ schemaVersion: 1, defaultModel: "fixture/primary", maxRetries: 0, providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, auth: { type: "none" }, developerRoleMode: "native", request: { streamUsage: false, supportsTemperature: true, maxTokensField: "max_tokens", extraBody: {} }, models: [{ id: "primary", status: "active", contextWindowTokens: 16000, maxOutputTokens: 2048, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] }), { mode: 0o600 });
  journals = new FileJournalStorageBackend({ backendId: "parent", rootDirectory: join(directory, "parent-library") });
  const journal = journals.open({ namespace: "memory/knowledge" });
  memory = new MemoryRuntime(new JournalMemoryStore(journal, "knowledge"));
  const evidence = [{ kind: "operator", id: "fixture", revision: "1", digest: "a".repeat(64) }];
  await memory.consolidate({ operationId: "seed", actor: { kind: "curation", id: "memory-curation" }, reason: "Fixture knowledge", expectedRevision: 0, retirements: [],
    upserts: [
      { id: "summary", path: "memory_summary.md", content: "v1\nSHARED_SUMMARY: Project verification procedures are indexed in MEMORY.md and skills/inspect/SKILL.md." },
      { id: "handbook", path: "MEMORY.md", content: "Inspect source and focused tests. Related Skill: skills/inspect/SKILL.md" },
      { id: "inspect-guidance", path: "skills/inspect/SKILL.md", content: "VERIFY_SHARED_READ_0913: inspect source and focused tests before changing code." },
    ].map(item => ({ ...item, expectedVersion: 0, title: item.path, appliesTo: "Wish child integration", keywords: ["inspect", "memory"], evidence })) });
  const launcher = new WishCliSubagentLauncherBackend({ dataDirectory, modelsConfigurationPath: modelsPath, prepareResources: (request, identity) => resources.prepare(request, identity) });
  subagents = new SubagentRuntime({ execution: new TmuxSubagentExecutionBackend(new LocalTmuxBackend({ socketPath, sessionPrefix: "wish-memory-real" })), store: new MemorySubagentRecordStore(),
    launcher: { async resolve(request, identity) {
      const launch = await launcher.resolve(request, identity);
      return { ...launch, command: { ...launch.command, environment: { ...launch.command.environment, WISH_MEMORY_ENABLED: "1", WISH_MEMORY_WRITE_ENABLED: "1", WISH_MEMORY_CURATION_ENABLED: "0", WISH_SHELL_PROVIDER: "host", WISH_SHELL_HOST_ENABLED: "1" } } };
    } }, results: launcher.exchange, id: () => "memory-child-real" });
  const evidenceReader = { async read(record, signal) {
    assert.equal(record.status, "exited");
    const store = new FileSessionStore({ rootDirectory: join(launcher.exchange.childDataDirectory(record.id), "sessions") });
    try { return await store.readHistory({ sessionId: record.childSessionId, signal }); } finally { await store.close(); }
  } };
  resources = new SubagentMemoryResources({ memory, exchange: launcher.exchange, subagents, evidence: evidenceReader });
  child = await subagents.spawn({ parentAgentId: "wish", parentSessionId: "parent-session", parentRunId: "parent-run", workspaceRoot: workspace,
    task: "Inspect the shared memory Skill in a transparent child", permissionProfile: "full-access", allowedCapabilities: ["runtime.read", "runtime.control"], availableTools: ["memory_read", "memory_search", "memory_list", "memory_write"] });
  assert.match(child.target.attachCommand, /attach-session/u);
  let collected;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    collected = await subagents.collect({ ...access(child), lines: 200, maxChars: 40000 });
    if (collected.record.status === "exited" && collected.record.result) break;
    if (collected.record.status === "exited" && collected.record.exitCode !== 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(collected?.record.result?.status, "completed", JSON.stringify(collected, null, 2));
  assert.equal(collected.record.status, "exited");
  assert.equal(collected.record.resourceManifestDigest, (await launcher.exchange.readInputResources(child)).digest);
  assert.ok(requests.some(request => request.messages.some(item => item.role === "tool" && String(item.content).includes("VERIFY_SHARED_READ_0913"))), JSON.stringify({ requests, output: collected.output }));
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes("SHARED_SUMMARY")), "summary is injected before the child asks to retrieve a file");
  assert.ok(requests.every(request => !request.tools?.some(tool => tool.function?.name === "memory_write")), "child does not start an independent write or human-review pipeline");
  await resources.consume(collected.record);
  assert.equal((await memory.state()).candidates.length, 0);
  await resources.close();
  await memory.close();
  memory = new MemoryRuntime(new JournalMemoryStore(journal, "knowledge"));
  assert.equal((await memory.state()).candidates.length, 0);
  assert.equal((await memory.state()).documents.length, 3);
  console.log("real tmux child received the complete pinned memory workspace, injected its summary and read a Skill through the model Tool path");
} finally {
  await resources?.close().catch(() => undefined);
  if (child) await subagents?.stop(access(child)).catch(() => undefined);
  await subagents?.close().catch(() => undefined);
  await memory?.close().catch(() => undefined);
  await journals?.close().catch(() => undefined);
  await new Promise(resolve => server?.close(() => resolve()) ?? resolve());
  await rm(directory, { recursive: true, force: true });
}

function access(record) { return { id: record.id, parentAgentId: record.parentAgentId, parentSessionId: record.parentSessionId, parentRunId: record.parentRunId, workspaceRoot: record.workspaceRoot }; }
function sendCall(response, id, name, argumentsValue) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(argumentsValue) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
}
function sendText(response, content) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
