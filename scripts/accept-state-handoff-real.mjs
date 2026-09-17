import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { LocalTmuxBackend } from "../dist/tmux/providers/local.js";
import { loadModelsConfiguration } from "../dist/models/config.js";

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 18000;
  while (!await check()) { if (Date.now() >= deadline) throw Error("State handoff timed out"); await delay(25); }
}
function continuation() {
  const view = { holds: 0, releases: 0, messages: [] };
  return { view, deferCompletion() { view.holds++; return { release() { view.releases++; } }; }, followUp(message) { view.messages.push(message); } };
}

for (const failRestore of [false, true]) test(`real tmux child survives module handoff${failRestore ? " and failed observation activation" : ""} without duplicate dispatch`, { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-state-handoff-")), socket = join(directory, "tmux.sock");
  const release = Promise.withResolvers(), received = Promise.withResolvers();
  const operator = new LocalTmuxBackend({ socketPath: socket, sessionPrefix: "wish-agent" });
  const requests = [];
  let booted, child, server;
  try {
    server = createServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body)); received.resolve();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "handoff " }, finish_reason: null }] })}\n\n`);
        void release.promise.then(() => response.end([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "verified child" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n",
        ].join("")));
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const configuration = { schemaVersion: 1, defaultModel: "fixture/model", maxRetries: 0, providers: [{ id: "fixture", protocol: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native",
      request: { streamUsage: false, supportsTemperature: true, maxTokensField: "max_tokens", extraBody: {} },
      models: [{ id: "model", status: "active", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }],
    }] };
    const profile = join(directory, "cordis.yml");
    await writeFile(profile, await readFile(new URL("../config/cordis.yml", import.meta.url), "utf8"));
    const childProfile = join(directory, "child.yml");
    await writeFile(childProfile, await readFile(profile, "utf8"));
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory, configurationFile: profile,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_TMUX_SOCKET: socket, WISH_MEMORY_ENABLED: "0", WISH_SKILLS_ENABLED: "0" } });
    const ctx = booted.surfaceContext, loader = booted.context.loader, pid = process.pid;
    const old = { tmux: ctx.get("tmux"), children: ctx.get("subagents"), scheduler: ctx.get("workflowScheduler").children, workflow: ctx.get("workflow").state };
    const stable = new Map(["runtime", "sessions", "application", "tools"].map(id => [id, loader.resolve(`include:${id}`).fiber]));
    // The real CLI launcher/protocol remain in use; isolate optional child roots
    // from operator preferences and ensure the fixture never watches source files.
    const launcher = ctx.get("subagentLauncher"), resolve = launcher.resolve.bind(launcher);
    launcher.resolve = async (...args) => {
      const value = await resolve(...args);
      return { ...value, command: { ...value.command, environment: { ...value.command.environment,
        WISH_MEMORY_ENABLED: "0", WISH_SKILLS_ENABLED: "0", CORDIS_HMR: "0", CORDIS_CONFIG: childProfile } } };
    };
    const owner = { parentAgentId: "wish", parentSessionId: "handoff-session", parentRunId: "handoff-parent", workspaceRoot: directory };
    const run = await old.scheduler.submit({ key: "same-attempt", kind: "subagent", owner, permissionProfile: "read-only", availableTools: ["read"],
      allowedCapabilities: ["filesystem.read"], modelsConfiguration: loadModelsConfiguration({ json: JSON.stringify(configuration) }),
      tasks: [{ id: "child", title: "Inspect the handoff boundary", dependencies: [], execution: { role: "reviewer", readOnly: true, timeoutMs: 120000 } }],
    });
    const attempt = run.steps[0].attempts[0];
    assert.ok(attempt?.childId, JSON.stringify(run));
    child = await old.children.inspect({ ...owner, id: attempt.childId });
    await Promise.race([received.promise, until(async () => { const r = await old.children.inspect({ ...owner, id: child.id });
      if (r?.result || r?.status !== "running") throw Error(`child exited before model gate: ${JSON.stringify(await old.children.collect({ ...owner, id: child.id }))}`);
      return requests.length > 0;
    })]);
    const terminal = (await operator.list()).find(session => session.target.sessionId === child.id);
    assert.equal(terminal.active, true); assert.ok(terminal.panePid);
    const previousRecipient = continuation(); old.scheduler.watch(run.id, previousRecipient);

    const tmux = loader.resolve("include:tmux-local"), workflow = loader.resolve("include:workflow-storage");
    const originalConfig = structuredClone(tmux.options.config);
    await tmux.update({ disabled: true }); await loader.await();
    assert.equal(ctx.get("subagents"), undefined); assert.equal(ctx.get("workflowScheduler"), undefined);
    await assert.rejects(old.tmux.list(), /closed/i);
    assert.throws(() => old.children.inspect({ ...owner, id: child.id }), /closed/i);
    await assert.rejects(old.scheduler.submit({}), /closed/i);
    assert.equal(previousRecipient.view.releases, 0);
    assert.equal((await operator.inspect(terminal.target)).panePid, terminal.panePid);
    await workflow.update({ disabled: true }); await loader.await();
    await assert.rejects(old.workflow.get(run.id), /closed/i);
    await workflow.update({ disabled: false }); await loader.await();
    const restoredState = ctx.get("workflow").state;
    assert.notEqual(restoredState, old.workflow);
    assert.equal((await restoredState.get(run.id)).steps[0].attempts[0].status, "interrupted");

    if (failRestore) {
      // A transport that cannot inspect the saved target fails dependent startup;
      // it must not relaunch a child or overwrite its durable result/binding.
      await tmux.update({ disabled: false, config: { ...originalConfig, executable: join(directory, "missing-tmux") } });
      await assert.rejects(loader.await(), /subagents-runtime.*Failed to inspect tmux/);
      assert.equal(ctx.get("workflowScheduler"), undefined);
      assert.equal((await restoredState.get(run.id)).steps[0].attempts[0].status, "interrupted");
      assert.equal((await operator.inspect(terminal.target)).panePid, terminal.panePid);
      assert.equal(requests.length, 1);
    }
    await tmux.update({ disabled: false, config: originalConfig }); await loader.await();
    await until(() => ctx.get("workflowScheduler") !== undefined);
    const next = ctx.get("workflowScheduler").children;
    const recovered = await restoredState.get(run.id), current = recovered.steps[0].attempts[0];
    assert.equal(current.id, attempt.id); assert.equal(current.ordinal, attempt.ordinal); assert.equal(current.childId, attempt.childId);
    assert.equal(current.deadline, attempt.deadline); assert.equal(current.idempotencyKey, attempt.idempotencyKey);
    assert.equal(current.status, "running"); assert.equal(recovered.steps[0].attempts.length, 1);
    assert.equal((await ctx.get("tmux").inspect(terminal.target)).panePid, terminal.panePid);
    assert.equal((await ctx.get("subagents").inspect({ ...owner, id: child.id })).target.attachCommand, child.target.attachCommand);
    // The Workflow-owned relationship survives; no replacement watch is needed.
    release.resolve();
    await until(async () => (await restoredState.get(run.id)).status === "completed" && previousRecipient.view.messages.length === 1);
    const completed = await restoredState.get(run.id);
    assert.equal(completed.steps[0].attempts.length, 1); assert.equal(requests.length, 1);
    assert.equal(completed.events.filter(event => event.type === "attempt.dispatched").length, 1);
    assert.equal(completed.events.filter(event => event.type === "attempt.completed").length, 1);
    assert.match(previousRecipient.view.messages[0].text, /handoff verified child/);
    assert.equal(previousRecipient.view.releases, 1); assert.equal(previousRecipient.view.holds, 1);
    await assert.rejects(old.scheduler.lifecycleSnapshot(), /closed/i);
    assert.equal(old.scheduler.pendingTicks, 0);
    assert.equal(process.pid, pid);
    for (const [id, fiber] of stable) assert.ok(loader.resolve(`include:${id}`).fiber === fiber, `${id} unexpectedly replaced`);
    await delay(550); assert.equal(previousRecipient.view.messages.length, 1); assert.equal(requests.length, 1);
  } finally {
    release.resolve();
    await booted?.dispose();
    // Only this fixture's dedicated socket is removed; never the operator's server.
    await execute("tmux", ["-S", socket, "kill-server"]).catch(() => {});
    server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve) ?? resolve());
    await rm(directory, { recursive: true, force: true });
  }
});
