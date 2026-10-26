import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { models, boot } from "./fixtures/candidates.mjs";
import { executeProfileTask } from "../dist/experiments/providers/process.js";
const invoke = promisify(execFile), cli = fileURLToPath(new URL("../dist/apps/cli/main.js", import.meta.url));
test("Coding Runtime reads frozen evidence, writes and tests private code, exports real usage and submits one candidate", { timeout: 210000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-runtime-")), requests = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const part of request) { raw += part; if (raw.length > 2e6) throw new Error("fixture_request_limit"); }
      const body = JSON.parse(raw); requests.push(body);
      const tool = (id, name, args, index = 0) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
      const delta = requests.length === 1 ? { tool_calls: [tool("evidence", "read", { path: "evidence.json" }), tool("draft", "write", { path: "draft-check.mjs", content: "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('private evidence',()=>assert.ok(JSON.parse(readFileSync('evidence.json','utf8')).objective));\n" }, 1)] }
        : requests.length === 2 ? { tool_calls: [tool("check", "bash", { command: "node --test draft-check.mjs" })] }
        : { content: JSON.stringify({ content: "Inspect committed receipts and preserve unresolved operations before retrying.", rationale: "A recovery hypothesis. Private tests verify the generation workflow, not effectiveness." }) };
      response.setHeader("content-type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(400); response.end(String(error)); }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    await mkdir(join(directory, "tmp"));
    const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: join(directory, "tmp"), LANG: "C.UTF-8", CORDIS_HMR: "0", WISH_MANAGED_CLI: "1", WISH_EVOLUTION_ENABLED: "1", WISH_PERMISSION_PROFILE: "workspace-write",
      WISH_DATA_DIR: join(directory, "data"), WISH_CANDIDATES_DIR: join(directory, "candidates"), WISH_EXPERIMENTS_DIR: join(directory, "experiments"), WISH_MANAGEMENT_DATA_DIR: join(directory, "management"),
      WISH_MODELS_JSON: JSON.stringify(models(`http://127.0.0.1:${server.address().port}/v1`)) };
    const result = await invoke(process.execPath, [cli, "evolution", "begin", "Improve recovery using committed evidence", "prompt", "runtime"], { cwd: directory, env, timeout: 190000, maxBuffer: 16e6 });
    const campaign = JSON.parse(result.stdout), attempt = campaign.attempts[0];
    assert.equal(campaign.state, "awaiting-external-validation", `${campaign.error}\n${result.stderr}`);
    assert.equal(campaign.spec.context.generatorId, "runtime"); assert.equal(attempt.proposal.generation.engine, "runtime");
    assert.equal(campaign.usage.modelCalls, 3); assert.equal(campaign.usage.tokens, 180); assert.equal(requests.length, 3);
    assert.ok(requests[0].tools.some(tool => tool.function.name === "write"));
    assert.ok(requests[0].max_tokens <= 1024);
    const worker = join(directory, "data", "evolution-generation", campaign.id, attempt.id);
    const output = JSON.parse(await readFile(join(worker, "result.json"), "utf8"));
    assert.equal(output.runId, attempt.proposal.generation.runId); assert.equal(output.status, "completed");
    assert.equal(await readFile(join(worker, "workspace", "draft-check.mjs"), "utf8").then(text => text.includes("private evidence")), true);
    const completed = output.executionEvidence.events.filter(event => event.type === "tool.completed");
    assert.deepEqual(completed.map(event => event.toolName).sort(), ["bash", "read", "write"]);
    assert.equal(completed.find(event => event.toolName === "bash").resultStatus, "completed");
    assert.match(output.executionEvidence.historyDigest, /^[a-f0-9]{64}$/);
    assert.equal(attempt.verdict, undefined); assert.equal(campaign.publication, undefined);
    const history = await invoke(process.execPath, [cli, "candidate", "history"], { cwd: directory, env, timeout: 30000, maxBuffer: 16e6 });
    const records = JSON.parse(history.stdout); assert.equal(records.evaluations.length, 0); assert.equal(records.promotions.length, 0);
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
test("cancelling a real Profile task stops its running native Bash descendant and retains incomplete billing", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-cancel-")), abort = new AbortController();
  let host, running, pid;
  const server = createServer(async (request, response) => {
    for await (const _part of request) {}
    const call = { index: 0, id: "long-command", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `node -e 'require("node:fs").writeFileSync("owned.pid",String(process.pid));setInterval(()=>{},1000)'`, permissions: { filesystem: "write", network: false, externalSideEffect: false, destructive: false } }) } };
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const env = { WISH_MODELS_JSON: JSON.stringify(models(`http://127.0.0.1:${server.address().port}/v1`)), WISH_EVOLUTION_ENABLED: "0" };
    host = await boot(directory, env); const ctx = host.surfaceContext;
    await ctx.get("agentProfiles").register({ schemaVersion: 1, id: "cancel-profile", version: 1, model: "fixture/a", tools: ["bash"], permissionProfile: "workspace-write", memory: "none", reservedOutputTokens: 128, request: { maxOutputTokens: 1024 } });
    const snapshot = await ctx.get("agentProfiles").capture("cancel-profile@1", await ctx.get("application").resolve(), { resources: { cwd: directory, emptySkills: true } });
    const task = join(directory, "task");
    running = executeProfileTask({ snapshot, directory: task, testCase: { id: "cancel", prompt: "Start the requested private long command.", files: {}, assertion: { kind: "contains", expected: "unused" } }, maxSteps: 2, timeoutMs: 30000, requestBudget: { modelCalls: 2, tokens: 256000, maxOutputTokens: 1024 } }, abort.signal, process.env);
    const path = join(task, "workspace", "owned.pid"), deadline = Date.now() + 25000;
    while (Date.now() < deadline) { try { pid = Number(await readFile(path, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "The real native command must start before cancellation");
    abort.abort(new Error("Operator cancelled private generation"));
    const result = await running; assert.equal(result.status, "aborted"); assert.equal(result.attemptsComplete, false);
    let alive = true;
    try { process.kill(pid, 0); const state = await readFile(`/proc/${pid}/stat`, "utf8"); alive = !/[)] [ZX] /u.test(state); }
    catch (error) { if (!["ESRCH", "ENOENT"].includes(error.code)) throw error; alive = false; }
    assert.equal(alive, false, "Cancellation must stop the owned command, including its separate process group");
  } finally {
    abort.abort(); await running?.catch(() => {}); if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await host?.dispose(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  }
});
