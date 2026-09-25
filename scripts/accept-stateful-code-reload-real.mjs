import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile), repository = dirname(dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 18000;
  while (!await check()) { if (Date.now() > end) throw Error("Stateful HMR timed out"); await delay(25); }
}
function send(response, delta, reason = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
}

for (const target of ["scheduler", "subagents", "tmux", "storage", "batch", "capture", "activation-failure", "receipt-failure"]) test(`managed native ${target} code reload preserves the real parent Run and tmux child`, { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-stateful-hmr-")), socket = join(directory, "tmux.sock");
  const childRelease = Promise.withResolvers(), received = Promise.withResolvers();
  const captureRelease = Promise.withResolvers(), captureEntered = Promise.withResolvers();
  const task = "inspect-stateful-hmr-child-fixture", requests = [], receipts = [];
  let booted, server, handle, completed = false, batchFiles;
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    server = createServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body); requests.push(payload);
        const users = payload.messages.filter(message => message.role === "user").map(message => String(message.content));
        if (users.some(text => text.includes(task))) {
          received.resolve(); void childRelease.promise.then(() => send(response, { content: "verified hot child evidence" }));
        } else if (users.some(text => text.includes("wish-workflow-result") || (text.includes("Workflow wf-") && text.includes("verified hot child evidence")))) {
          receipts.push(booted.pluginManagement.snapshot()); send(response, { content: "parent integrated hot child evidence" });
        } else if (payload.messages.some(message => message.role === "tool")) send(response, { content: "parent waiting for child" });
        else send(response, { tool_calls: [{ index: 0, id: "one-dispatch", type: "function", function: { name: "spawn_agent",
          arguments: JSON.stringify({ task, role: "reviewer", permissionProfile: "read-only", availableTools: ["read"] }) } }] }, "tool_calls");
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const configuration = { schemaVersion: 1, defaultModel: "fixture/model", maxRetries: 0, providers: [{ id: "fixture", protocol: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, auth: { type: "none" }, developerRoleMode: "native",
      request: { streamUsage: false, supportsTemperature: true, maxTokensField: "max_tokens", extraBody: {} },
      models: [{ id: "model", status: "active", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }],
    }] };
    const profile = join(directory, "dist/config/cordis.yml"), childProfile = join(directory, "child.yml");
    await writeFile(childProfile, await readFile(profile, "utf8"));
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    const { managedWebUi } = await import(pathToFileURL(join(directory, "dist/apps/webui/host/composition.js")));
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "1", WISH_DATA_DIR: join(directory, "data"), WISH_TMUX_SOCKET: socket,
        WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MEMORY_ENABLED: "0", WISH_SKILLS_ENABLED: "0",
        WISH_PERMISSION_PROFILE: "full-access", WISH_SHELL_PROVIDER: "host", WISH_SHELL_HOST_ENABLED: "1", WISH_MODELS_JSON: JSON.stringify(configuration) },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const ctx = booted.surfaceContext, loader = booted.context.loader, pid = process.pid;
    booted.context.on("hmr/reload-prepare", (batch, _signal, next) => {
      batchFiles = [...batch.values()].map(item => item.filename); return next();
    }, { global: true, prepend: true });
    const launcher = ctx.get("subagentLauncher"), resolve = launcher.resolve.bind(launcher);
    launcher.resolve = async (...args) => {
      const value = await resolve(...args);
      return { ...value, command: { ...value.command, environment: { ...value.command.environment,
        WISH_MEMORY_ENABLED: "0", WISH_SKILLS_ENABLED: "0", CORDIS_HMR: "0", CORDIS_CONFIG: childProfile } } };
    };
    const app = await ctx.get("application").open();
    await app.createSession({ sessionId: "parent", workspaceRoot: directory });
    handle = await app.startRun({ sessionId: "parent", payload: { text: "Delegate once and integrate the evidence" } });
    void handle.completion.then(() => { completed = true; });
    await Promise.race([received.promise, handle.completion.then(value => { throw Error(`Parent ended before child gate: ${JSON.stringify(value)}`); })]);
    await until(() => requests.length >= 3 && ctx.get("runEngine").execution.snapshot().activeSteps === 0);
    assert.equal(completed, false); assert.equal(ctx.get("workflowContinuations").state.size, 1);
    const workflow = (await ctx.get("workflow").state.list())[0], attempt = workflow.steps[0].attempts[0];
    const child = await ctx.get("subagents").inspect({ ...workflow.owner, id: attempt.childId });
    const terminal = (await ctx.get("tmux").list()).find(item => item.target.sessionId === child.id);
    assert.ok(terminal.panePid); assert.equal(terminal.active, true);
    const stable = new Map(["runtime", "sessions", "application", "tools", "workflow-continuations", "coordinator-storage", "webui"].map(id => [id, loader.resolve(`include:${id}`).fiber]));
    const mode = await ctx.get("coordinator").enter({ runId: handle.runId, sessionId: "parent", goal: "preserve parent mode" });
    const retiring = { scheduler: ctx.get("workflowScheduler").children, subagents: ctx.get("subagents"), tmux: ctx.get("tmux") };
    const base = booted.context.webManagementHost.url;
    const auth = await (await fetch(base + "/api/management/bootstrap")).json();
    const beforeDisable = booted.pluginManagement.snapshot();
    const response = await fetch(base + "/api/management/plugins/change", { method: "POST", headers: { "Content-Type": "application/json", "X-Wish-Management-Token": auth.token },
      body: JSON.stringify({ requestId: crypto.randomUUID(), revision: beforeDisable.revision, preference: "disabled", selection: { instanceId: auth.instanceId, entryIds: ["include:tmux-local"] } }) });
    assert.equal(response.status, 202);
    let { operation } = await response.json();
    await until(async () => {
      ({ operation } = await (await fetch(base + `/api/management/plugins/operations/${operation.id}`)).json());
      return ["succeeded", "rejected", "recovery-required"].includes(operation.phase);
    });
    assert.equal(operation.phase, "succeeded", JSON.stringify(operation));
    assert.equal(booted.pluginManagement.snapshot().preferences["include:tmux-local"].preference, "disabled");
    assert.equal(ctx.get("tmux"), undefined);
    assert.equal(ctx.get("subagents"), undefined);
    assert.equal(ctx.get("workflowScheduler"), undefined);
    assert.equal(completed, false);
    assert.equal(ctx.get("workflowContinuations").state.size, 1);
    assert.throws(() => retiring.subagents.inspect({ ...workflow.owner, id: child.id }), /closed/i);
    await assert.rejects(retiring.tmux.list(), /closed/i);
    await assert.rejects(retiring.scheduler.submit({}), /closed/i);

    const afterDisable = booted.pluginManagement.snapshot();
    const enableResponse = await fetch(base + "/api/management/plugins/change", { method: "POST", headers: { "Content-Type": "application/json", "X-Wish-Management-Token": auth.token },
      body: JSON.stringify({ requestId: crypto.randomUUID(), revision: afterDisable.revision, preference: "enabled",
        selection: { instanceId: auth.instanceId, entryIds: ["include:tmux-local"] } }) });
    assert.equal(enableResponse.status, 202);
    ({ operation } = await enableResponse.json());
    await until(async () => {
      ({ operation } = await (await fetch(base + `/api/management/plugins/operations/${operation.id}`)).json());
      return ["succeeded", "rejected", "recovery-required"].includes(operation.phase);
    });
    assert.equal(operation.phase, "succeeded", JSON.stringify(operation));
    assert.equal((await ctx.get("tmux").inspect(terminal.target)).panePid, terminal.panePid);
    assert.equal((await ctx.get("subagents").inspect({ ...workflow.owner, id: child.id })).id, child.id);
    const resumedAttempt = (await ctx.get("workflow").state.get(workflow.id)).steps[0].attempts[0];
    for (const key of ["id", "ordinal", "childId", "deadline", "idempotencyKey"]) assert.equal(resumedAttempt[key], attempt[key], key);
    assert.equal(ctx.get("workflowContinuations").state.size, 1);
    assert.equal(requests.length, 3, "managed re-enable must not dispatch another child");

    const oldScheduler = ctx.get("workflowScheduler").children;
    const old = { subagents: ctx.get("subagents"), tmux: ctx.get("tmux"), state: ctx.get("workflow").state };
    const oldTmuxFiber = loader.resolve("include:tmux-local").fiber;
    let capture;
    if (target === "capture") {
      const run = old.tmux.backend.runner.run.bind(old.tmux.backend.runner);
      old.tmux.backend.runner.run = async input => {
        if (input.args.includes("capture-pane")) { captureEntered.resolve(); await captureRelease.promise; }
        return run(input);
      };
      capture = old.tmux.capture({ target: terminal.target }); await captureEntered.promise;
    }
    let queued;
    if (target === "receipt-failure") {
      queued = await old.state.create({ key: "pending-exclusive", kind: "subagent", owner: workflow.owner,
        permissionProfile: "read-only", availableTools: ["read"], tasks: [{ id: "later", title: "must not dispatch before receipt",
          dependencies: [], execution: { role: "reviewer", readOnly: false, timeoutMs: 120000 } }] });
      const store = booted.pluginManagement.store, commit = store.commit.bind(store);
      store.commit = (revision, state) => {
        if (state.pending === null && state.receipts.at(-1)?.code === "management_code_reload_applied") throw Error("fixture receipt failure");
        return commit(revision, state);
      };
    }
    const edits = {
      scheduler: ["workflow/child-scheduler.js", "maxConcurrent ?? 4", "maxConcurrent ?? 3"],
      subagents: ["subagents/runtime.js", "DEFAULT_MAX_CONCURRENT = 4", "DEFAULT_MAX_CONCURRENT = 3"],
      tmux: ["tmux/providers/local.js", "DEFAULT_CAPTURE_LINES = 200", "DEFAULT_CAPTURE_LINES = 199"],
      storage: ["workflow/runtime.js", "maxTotalAttempts: 200", "maxTotalAttempts: 199"],
      "activation-failure": ["subagents/runtime.js", "await this.backend.resume();", 'await this.backend.resume(); throw Error("fixture activation failure");'],
    };
    await Promise.all((target === "batch" ? ["scheduler", "subagents", "tmux", "storage"] : [target === "capture" ? "tmux" : target === "receipt-failure" ? "scheduler" : target]).map(async key => {
      const [path, before, after] = edits[key], filename = join(directory, "dist", path);
      const source = await readFile(filename, "utf8"); assert.ok(source.includes(before));
      await writeFile(filename, source.replace(before, after));
    }));
    if (target === "capture") {
      await until(() => booted.codeReload.snapshot().phase === "draining"); await delay(150);
      assert.equal(booted.codeReload.snapshot().phase, "draining"); assert.ok(loader.resolve("include:tmux-local").fiber === oldTmuxFiber);
      assert.equal(completed, false); captureRelease.resolve(); await capture;
    }
    await until(() => ["succeeded", "rejected", "recovery-required"].includes(booted.codeReload.snapshot().phase));
    if (target === "activation-failure") {
      await until(() => booted.pluginManagement.snapshot().status === "ready");
      const management = booted.pluginManagement.snapshot();
      assert.equal(booted.codeReload.snapshot().phase, "rejected");
      assert.equal(booted.codeReload.snapshot().code, "code_reload_candidate_rolled_back");
      assert.equal(management.status, "ready"); assert.equal(management.pending, null);
      assert.equal(management.lastReceipt.code, "management_code_reload_rolled_back");
      assert.equal(ctx.get("runEngine").execution.snapshot().phase, "ready");
      assert.notEqual(ctx.get("subagents"), old.subagents);
      assert.throws(() => old.subagents.inspect({ ...workflow.owner, id: child.id }), /closed/i);
      assert.equal(completed, false); assert.equal(ctx.get("workflowContinuations").state.size, 1);
      assert.equal((await ctx.get("tmux").inspect(terminal.target)).panePid, terminal.panePid);
      childRelease.resolve();
      const completion = await handle.completion;
      assert.equal(completion.status, "completed", JSON.stringify(completion));
      assert.equal(receipts.length, 1); assert.equal(receipts[0].pending, null);
      assert.equal(receipts[0].lastReceipt.code, "management_code_reload_rolled_back");
      assert.equal(ctx.get("workflowContinuations").state.size, 0);
      assert.match(JSON.stringify(await app.readSessionHistory({ sessionId: "parent" })), /parent integrated hot child evidence/);
      assert.equal(requests.length, 4); assert.equal(process.pid, pid);
      for (const [id, fiber] of stable) assert.ok(loader.resolve(`include:${id}`).fiber === fiber, `${id} was replaced`);
      return;
    }
    if (target === "receipt-failure") {
      assert.equal(booted.codeReload.snapshot().phase, "recovery-required");
      assert.equal(completed, false); assert.equal(ctx.get("workflowContinuations").state.size, 1);
      assert.equal((await ctx.get("tmux").inspect(terminal.target)).panePid, terminal.panePid);
      assert.equal(ctx.get("runEngine").execution.snapshot().phase, "failed");
      assert.equal((await fetch(base + "/api/management/bootstrap")).status, 200);
      if (queued) {
        assert.ok(booted.pluginManagement.snapshot().pending);
        assert.equal(ctx.get("workflowScheduler").children.timer, undefined);
        await assert.rejects(ctx.get("workflowScheduler").children.submit({}), /closed/i);
        childRelease.resolve(); await delay(700);
        assert.equal(requests.length, 3); assert.equal((await old.state.get(queued.id)).steps[0].attempts.length, 0);
      }
      app.controlRun(handle.runId, { type: "abort", source: "fixture", reason: "explicit recovery cancellation" });
      assert.equal((await handle.completion).status, "aborted");
      assert.equal(ctx.get("workflowContinuations").state.size, 0); assert.equal(receipts.length, 0);
      return;
    }
    assert.equal(booted.codeReload.snapshot().phase, "succeeded", JSON.stringify(booted.codeReload.snapshot()));
    assert.notEqual(ctx.get("workflowScheduler").children, oldScheduler);
    if (target === "scheduler" || target === "batch") assert.equal(ctx.get("workflowScheduler").children.maxConcurrent, 3);
    if (target === "subagents" || target === "batch") {
      assert.notEqual(ctx.get("subagents"), old.subagents); assert.equal(ctx.get("subagents").backend.maxConcurrent, 3);
      assert.throws(() => old.subagents.inspect({ ...workflow.owner, id: child.id }), /closed/i);
    }
    if (target === "tmux" || target === "batch") {
      assert.notEqual(ctx.get("tmux"), old.tmux); assert.equal(ctx.get("tmux").backend.options.captureLines, 199);
      await assert.rejects(old.tmux.list(), /closed/i);
    }
    if (target === "storage" || target === "batch") {
      assert.notEqual(ctx.get("workflow").state, old.state); await assert.rejects(old.state.list(), /closed/i);
      const next = await ctx.get("workflow").state.create({ key: "new-budget", kind: "subagent", owner: workflow.owner,
        permissionProfile: "read-only", availableTools: ["read"], tasks: [] });
      assert.equal(next.budget.maxTotalAttempts, 199);
    }
    assert.equal(completed, false); assert.equal(ctx.get("workflowContinuations").state.size, 1, JSON.stringify(await ctx.get("workflow").state.get(workflow.id)));
    assert.equal((await ctx.get("tmux").inspect(terminal.target)).panePid, terminal.panePid);
    const current = (await ctx.get("workflow").state.get(workflow.id)).steps[0].attempts[0];
    assert.deepEqual(await ctx.get("coordinator").get({ runId: handle.runId }), mode);
    for (const key of ["id", "ordinal", "childId", "deadline", "idempotencyKey"]) assert.equal(current[key], attempt[key], key);
    childRelease.resolve();
    const completion = await handle.completion;
    assert.equal(completion.status, "completed", JSON.stringify(completion)); assert.equal(completion.snapshot.runId, handle.runId);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].pending, null);
    assert.equal(receipts[0].lastReceipt.code, "management_code_reload_applied");
    const done = await ctx.get("workflow").state.get(workflow.id);
    assert.equal(done.steps[0].attempts.length, 1); assert.equal(done.status, "completed");
    assert.equal(done.events.filter(event => event.type === "attempt.dispatched").length, 1);
    assert.equal(done.events.filter(event => event.type === "attempt.completed").length, 1);
    assert.equal(ctx.get("workflowContinuations").state.size, 0);
    const history = await app.readSessionHistory({ sessionId: "parent" });
    assert.match(JSON.stringify(history), /parent integrated hot child evidence/);
    assert.equal(requests.length, 4); assert.equal(process.pid, pid);
    for (const [id, fiber] of stable) assert.ok(loader.resolve(`include:${id}`).fiber === fiber, `${id} was replaced`);
    await delay(550); assert.equal(receipts.length, 1); assert.equal(requests.length, 4);
  } catch (error) { throw Error(`${error.stack}\nReload: ${JSON.stringify(booted?.codeReload.snapshot())}\nBatch: ${JSON.stringify(batchFiles)}\nRuntime: ${JSON.stringify(booted?.context.get("pluginInspection").inspect().fibers.filter(f => /runtime|workflow/.test(f.entryId ?? "")))}`, { cause: error }); }
  finally {
    captureRelease.resolve(); childRelease.resolve(); await booted?.dispose();
    await execute("tmux", ["-S", socket, "kill-server"]).catch(() => {});
    server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve) ?? resolve());
    await rm(directory, { recursive: true, force: true });
  }
});
