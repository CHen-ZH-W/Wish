import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const specification = {
  objective: "交付一个可验证的本地问候功能", scope: ["新增 answer.txt 并保存 hello wish"], outOfScope: ["外部服务"], constraints: ["保留 preserved.txt 的用户内容"],
  criteria: [{ id: "greeting", text: "answer.txt 包含 hello wish", kind: "technical" }, { id: "understand", text: "能够理解本次交付及后续修改入口", kind: "user" }],
  questions: [], assumptions: ["本地使用"], decisions: [], planMarkdown: "保留已有文件，添加问候文件，运行实际内容检查并交付说明。",
  assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "一个本地文件的可逆修改" },
};
const active = project => project.changes.find(change => change.id === project.activeChangeId) ?? project.changes.at(-1);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, predicate, label) {
  let value;
  for (let n = 0; n < 180; n++) { value = await read(); if (predicate(value)) return value; await delay(50); }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

test("Real product HTTP, Runtime tools, Shell verification and durable delivery form one closed loop", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-development-integration-")), workspace = join(directory, "workspace");
  let booted, development, requests = 0, titleRequests = 0, failure;
  let finishExploration;
  const explorationGate = new Promise(resolve => { finishExploration = resolve; });
  let finishImplementation, revisionQueued = false;
  const implementationGate = new Promise(resolve => { finishImplementation = resolve; });
  const calls = [], failures = [];
  const provider = createServer((request, response) => {
    const chunks = []; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => { void (async () => {
      try {
        const wire = JSON.parse(Buffer.concat(chunks).toString());
        // Auxiliary generation has no Tools. Keep the real title feature on,
        // and reserve the scripted development actions for the main Run.
        if (!wire.tools?.length) {
          titleRequests++;
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "本地问候开发" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        for (const message of wire.messages ?? []) if (message.role === "tool" && /Tool failed|permission_denied|execution_failed/u.test(message.content ?? "")) failures.push(message.content);
        const project = (await development.list())[0], change = project && active(project), spec = change?.specs.at(-1), confirmation = change?.confirmations.at(-1);
        let name, input, content = "本地确定性模型已完成本轮，等待用户检查。";
        if (!project?.activeChangeId) { name = "wish_begin"; input = { rawWish: "我想要一个简单的本地问候功能" }; }
        else if (change.phase === "stopping" && !revisionQueued) {
          const delivered = (wire.messages ?? []).some(message => message.role === "user" && message.content === "请额外核对用户原有文件未被修改");
          name = delivered ? "wish_begin" : "wish_read"; input = delivered ? { rawWish: "请额外核对用户原有文件未被修改" } : {};
          revisionQueued = delivered;
        }
        else if (!spec || change.phase === "exploring" && change.gate === "none") { name = "wish_propose"; input = { expectedRevision: project.revision, spec: specification }; }
        else if (change.phase === "running") {
          await implementationGate;
          if (active((await development.list())[0]).phase === "stopping") { name = "wish_read"; input = {}; }
          else {
          const actual = await readFile(join(workspace, "answer.txt"), "utf8").catch(() => "");
          if (actual !== "hello wish\n") { name = "write"; input = { path: "answer.txt", content: "hello wish\n" }; }
          else if (!change.verifications.length) {
            name = "wish_verify"; input = { expectedRevision: project.revision, executionEpoch: change.executionEpoch, confirmationDigest: confirmation.digest,
              command: `node -e 'const fs=require("node:fs");if(fs.readFileSync("answer.txt","utf8")!=="hello wish\\n")process.exit(2);console.log("greeting verified")'`, timeout: 10, criterionIds: ["greeting"] };
          } else { name = "wish_report"; input = { expectedRevision: project.revision, executionEpoch: change.executionEpoch, confirmationDigest: confirmation.digest,
            summary: "已添加本地问候文件，真实命令验证内容正确，并保留已有用户文件。", limitations: ["尚需用户确认交付说明是否清楚"], nextSteps: ["可以在当前对话直接提出下一轮修改"] }; }
          }
        }
        if (!name && change?.phase === "exploring") await explorationGate;
        requests++;
        if (name) calls.push(name);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = name ? { tool_calls: [{ index: 0, id: `product-call-${requests}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } : { content };
        response.end(`data: ${JSON.stringify({ id: `product-fixture-${requests}`, choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`);
      } catch (error) { failure = error; response.writeHead(500); response.end(String(error)); }
    })(); });
  });
  try {
    await mkdir(workspace); await writeFile(join(workspace, "preserved.txt"), "user's uncommitted content\n");
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const models = { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
      providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native", models: [{ id: "primary", status: "active", contextWindowTokens: 65536, maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
    booted = await bootstrap({ surface: "webui", cwd: workspace, homeDirectory: directory,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: workspace, WISH_MODELS_JSON: JSON.stringify(models),
        WISH_PERMISSION_PROFILE: "full-access", WISH_SHELL_PROVIDER: "host", WISH_SHELL_HOST_ENABLED: "1" },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
    });
    development = booted.surfaceContext.get("wishDevelopment"); assert.ok(development);
    const url = booted.context.get("webManagementHost").url;
    const { token } = await (await fetch(`${url}/api/management/bootstrap`)).json();
    const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", "X-Wish-Management-Token": token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`); return value;
    };
    const { session } = await api("/api/sessions", { workspaceRoot: workspace });
    const path = `/api/sessions/${session.sessionId}/controls/wish-development`;
    const opened = await api(`/api/sessions/${session.sessionId}/runs`, { text: "我想要一个简单的本地问候功能" });
    assert.ok(opened.run.runId);
    let project = await eventually(async () => (await development.list())[0], item => item && active(item)?.specs.length === 1, "ordinary chat must begin and propose through the real Tools");
    const earlySpec = active(project).specs.at(-1);
    const early = await fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Wish-Management-Token": token }, body: JSON.stringify({ action: "approve-and-start", requestId: "too-early", projectId: project.id, expectedRevision: project.revision, data: { changeId: active(project).id, specVersion: earlySpec.version, specDigest: earlySpec.digest } }) });
    assert.equal(early.status, 409); assert.equal(active((await development.list())[0]).confirmations.length, 0, "An active ordinary chat must not be partially approved");
    assert.equal(development.activeRunCount, 1, "The normal chat Run is adopted by the product lifecycle");
    finishExploration();
    await eventually(async () => (await api(`/api/sessions/${session.sessionId}/runs`)).runs, runs => runs.some(run => run.runId === opened.run.runId && run.status === "completed"), "normal conversation Run is observed");
    await eventually(async () => development.activeRunCount, count => count === 0, "adopted conversation cleanup must finish before approval");
    assert.equal(await readFile(join(workspace, "answer.txt"), "utf8").catch(() => null), null, "exploration cannot implement the wish");
    project = (await development.list())[0];
    const spec = active(project).specs.at(-1);
    let startBody = { action: "approve-and-start", requestId: "integration-start", projectId: project.id, expectedRevision: project.revision,
      data: { changeId: active(project).id, specVersion: spec.version, specDigest: spec.digest } };
    let started = (await api(path, startBody)).value;
    assert.ok(started.runId);
    const observed = await api(`/api/sessions/${session.sessionId}/runs`); assert.ok(observed.runs.some(run => run.runId === started.runId), "product-started Run appears in the ordinary Session ledger");
    const steering = await api(`/api/runs/${started.runId}/controls`, { type: "steer", text: "请额外核对用户原有文件未被修改" });
    assert.equal(steering.receipt.accepted, true); finishImplementation();
    project = await eventually(async () => (await development.list())[0], item => active(item).wishUpdates.length === 1 && active(item).specs.length === 2, "ordinary steering must retain the new human request and re-propose after cleanup");
    await eventually(async () => development.activeRunCount, count => count === 0, "revised read-only exploration must settle");
    assert.equal(await readFile(join(workspace, "answer.txt"), "utf8").catch(() => null), null, "Steering invalidates writes before the revised proposal is confirmed");
    assert.equal(active(project).wishUpdates[0], "请额外核对用户原有文件未被修改");
    project = (await development.list())[0];
    const revisedSpec = active(project).specs.at(-1);
    startBody = { action: "approve-and-start", requestId: "integration-start-revised", projectId: project.id, expectedRevision: project.revision,
      data: { changeId: active(project).id, specVersion: revisedSpec.version, specDigest: revisedSpec.digest } };
    started = (await api(path, startBody)).value;
    project = await eventually(async () => (await development.list())[0], item => active(item)?.reports.length === 1 && active(item).starts.every(start => start.status === "completed"), "implementation and report must finish through the real tools");
    assert.equal(failure, undefined);
    const change = active(project), report = change.reports.at(-1), receipt = change.verifications.at(-1);
    assert.deepEqual(calls.slice(0, 2), ["wish_begin", "wish_propose"]);
    assert.deepEqual(calls.slice(-3), ["write", "wish_verify", "wish_report"]);
    assert.equal(calls.filter(name => name === "wish_begin").length, 2); assert.equal(calls.filter(name => name === "wish_propose").length, 2);
    assert.equal(receipt.exitCode, 0); assert.match(receipt.output, /greeting verified/); assert.ok(receipt.runId && receipt.toolCallId);
    assert.equal(report.criteria.find(item => item.criterionId === "greeting").status, "verified");
    assert.equal(report.criteria.find(item => item.criterionId === "understand").status, "waiting-user");
    assert.equal(await readFile(join(workspace, "preserved.txt"), "utf8"), "user's uncommitted content\n");
    assert.equal((await api(path, startBody)).value.runId, started.runId, "retry returns the original Run without replaying implementation");
    const accepted = (await api(path, { action: "accept", requestId: "integration-accept", projectId: project.id, expectedRevision: project.revision,
      data: { changeId: change.id, reportId: report.id, reportDigest: report.digest } })).value.project;
    assert.equal(accepted.changes.at(-1).phase, "accepted");
    await api(`/api/sessions/${session.sessionId}/runs`, { text: "现在增加一个新的问候需求" });
    project = await eventually(async () => (await development.list())[0], item => item.changes.length === 2 && active(item).specs.length === 1, "next coding request reuses the same ordinary conversation");
    assert.equal(active(project).rawWish, "现在增加一个新的问候需求", "The original new human request is retained instead of the model's summary");
    await eventually(async () => development.activeRunCount, count => count === 0, "second natural exploration finishes");
    await api(`/api/sessions/${session.sessionId}`, {}, "DELETE");
    const retained = (await api("/api/controls/wish-development/default")).value.projects[0];
    const delivery = retained.changes.find(item => item.id === change.id);
    assert.equal(delivery.reports.at(-1).digest, report.digest);
    assert.match(delivery.verifications.at(-1).output, /greeting verified/, "project evidence survives Session archive cleanup");
    assert.equal(retained.sessionIds.length, 0);
    assert.ok(requests >= 6); assert.ok(titleRequests >= 1, "title generation coexists with the scripted development Run");
    assert.deepEqual(failures, []);
  } catch (error) {
    throw new Error(`${error.message}\nTool calls: ${JSON.stringify(calls)}\nTool failures: ${JSON.stringify([...new Set(failures)])}`, { cause: error });
  } finally {
    finishExploration();
    finishImplementation();
    await booted?.dispose(); await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
