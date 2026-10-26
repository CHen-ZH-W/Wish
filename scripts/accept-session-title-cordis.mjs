import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = resolve(process.env.WISH_TEST_DIST || join(root, "dist"));
const { bootstrap } = await import(pathToFileURL(join(dist, "boot/bootstrap.js")));
const titleContext = process => process.context.loader.resolve("include:session-title-storage").ctx;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const configuration = JSON.stringify({
  schemaVersion: 1,
  defaultModel: "fixture/title-model", fallbackModels: [], maxRetries: 0,
  providers: [{
    id: "fixture", protocol: "title-fixture", baseUrl: "https://unused.example.test",
    auth: { type: "none" }, developerRoleMode: "native",
    models: [{ id: "title-model", status: "active", contextWindowTokens: 100000,
      maxOutputTokens: 4096, input: { text: true, image: false }, reasoning: false,
      toolCalling: true, developerRole: true }],
  }],
});

async function until(read, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  }
  assert.fail("Title job did not reach the expected state");
}

test("the shipped Cordis profile names accepted human input through its independent Provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-title-cordis-"));
  let process;
  const mainStarted = Promise.withResolvers(), mainCompletion = Promise.withResolvers();
  try {
    process = await bootstrap({ surface: "cli", argv: ["--version"], cwd: root,
      homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: configuration, WISH_SESSION_TITLE_ENABLED: "1",
        CORDIS_HMR: "0", WISH_SKILLS_ENABLED: "0", WISH_MEMORY_ENABLED: "0" },
    });
    assert.equal(await process.completion, 0);
    const ctx = titleContext(process);
    assert.ok(ctx.get("sessionTitle"));
    assert.ok(ctx.get("sessionTitleGenerator"));
    assert.equal(process.surfaceContext.get("sessionTitle"), undefined, "title services stay private to their feature group");
    assert.equal(process.surfaceContext.get("sessionTitleGenerator"), undefined);
    assert.equal(ctx.get("sessions").manager, process.surfaceContext.get("sessions").manager);
    assert.ok(ctx.get("runEngine"), "the title group inherits the foreground Runtime service");
    const rows = process.plugins.inspect().entries;
    for (const id of ["session-title-storage", "session-title-model", "session-title-session-feature"]) {
      assert.ok(rows.some(entry => entry.id === `include:${id}` && entry.parentId === "include:session-title" && entry.phase === "active"), id);
    }
    const requests = [];
    let titleAttempts = 0;
    process.surfaceContext.get("models").registry.register("title-fixture", () => ({
      async *stream(request) {
        requests.push(request);
        yield { type: "start", model: request.model };
        if (request.metadata?.purpose !== "session-title") {
          mainStarted.resolve();
          await mainCompletion.promise;
        }
        if (request.metadata?.purpose === "session-title" && ++titleAttempts === 1) {
          yield { type: "error", error: { code: "network_error", message: "Fixture interruption", retryable: true } };
          return;
        }
        yield { type: "text_delta", text: request.metadata?.purpose === "session-title" ? "修复会话标题" : "Main response" };
        yield { type: "done", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, source: "provider" } };
      },
    }));
    const application = await process.surfaceContext.get("application").open();
    const session = await application.createSession({ workspaceRoot: directory });
    const handle = await application.startRun({ sessionId: session.sessionId,
      inputSource: "user", payload: { text: "请修复新建会话时的标题生成" } });
    await mainStarted.promise;
    assert.ok(ctx.get("runEngine").lifecycleSnapshot().activeRuns > 0, "the inherited Runtime observes the active main Run");
    await delay(300);
    assert.equal(titleAttempts, 0, "An auxiliary title cannot compete with the active main model request");
    const pending = await ctx.get("sessionTitle").inspect(session.sessionId);
    assert.equal(pending.state, "pending"); assert.equal(pending.attempts, 0);
    assert.equal((await application.getSession({ sessionId: session.sessionId })).titleSource, "fallback");
    mainCompletion.resolve();
    const completion = await handle.completion;
    assert.equal(completion.status, "completed");
    const job = await until(() => ctx.get("sessionTitle").inspect(session.sessionId), value => value?.state === "succeeded");
    assert.equal(job.attempts, 2);
    const updated = await application.getSession({ sessionId: session.sessionId });
    assert.equal(updated.title, "修复会话标题");
    assert.equal(updated.titleSource, "model");
    const titleRequests = requests.filter(request => request.metadata?.purpose === "session-title");
    assert.equal(titleRequests.length, 2);
    for (const request of titleRequests) {
      assert.deepEqual(request.tools, []);
      assert.equal(request.messages.length, 1);
      assert.equal(request.invocationScope, undefined);
      assert.ok(Buffer.byteLength(request.messages[0].content, "utf8") <= 4096);
    }
    const history = await application.readSessionHistory({ sessionId: session.sessionId });
    assert.ok(!history.records.some(record => record.kind === "message" && record.message.content === "修复会话标题"), "auxiliary title stays out of the transcript");
  } finally {
    mainCompletion.resolve();
    await process?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default profile can disable title services without changing Session creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-title-disabled-"));
  let process;
  try {
    process = await bootstrap({ surface: "cli", argv: ["--version"], cwd: root, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), CORDIS_HMR: "0", WISH_SESSION_TITLE_ENABLED: "0" },
    });
    assert.equal(await process.completion, 0);
    const ctx = titleContext(process);
    assert.equal(ctx.get("sessionTitle"), undefined);
    assert.equal(ctx.get("sessionTitleGenerator"), undefined);
    for (const id of ["session-title-storage", "session-title-model", "session-title-session-feature"]) {
      const row = process.plugins.inspect().entries.find(entry => entry.id === `include:${id}`);
      assert.equal(row.parentId, "include:session-title");
      assert.equal(row.enabled, false);
    }
    const session = await ctx.get("sessions").manager.create({ sessionId: "disabled", agentId: "wish", scope: directory });
    assert.equal(session.title, undefined);
  } finally {
    await process?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh production graph resumes a file-backed interrupted title without resetting its budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-title-disk-restart-"));
  const originalFetch = globalThis.fetch;
  let process;
  let phase = "interrupted";
  let requests = 0;
  const source = JSON.parse(configuration);
  source.providers[0].protocol = "openai-chat-completions";
  source.providers[0].baseUrl = "https://title-fixture.example.test/v1";
  const environment = { WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: JSON.stringify(source), WISH_SESSION_TITLE_ENABLED: "1",
    CORDIS_HMR: "0", WISH_SKILLS_ENABLED: "0", WISH_MEMORY_ENABLED: "0" };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://title-fixture.example.test/v1/chat/completions");
    requests++;
    if (phase === "interrupted") {
      return new Response(new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => controller.close(), { once: true });
          if (options.signal.aborted) controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"重启后恢复标题"},"finish_reason":null}]}', "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}', "",
      "data: [DONE]", "", "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } });
  };
  const open = () => bootstrap({ surface: "cli", argv: ["--version"], cwd: root, homeDirectory: directory, environment });
  try {
    process = await open();
    const ctx = titleContext(process);
    await ctx.get("sessions").manager.create({ sessionId: "disk-restart", agentId: "wish", scope: directory });
    await ctx.get("sessionTitle").accept({ sessionId: "disk-restart", text: "重启期间仍应保留首条标题任务" });
    await until(() => requests, count => count === 1);
    assert.equal((await ctx.get("sessionTitle").inspect("disk-restart")).attempts, 1);
    await process.dispose();
    process = undefined;
    const { WISH_SESSION_TITLE_ENABLED: _enabled, ...cliEnvironment } = environment;
    process = await bootstrap({ surface: "cli", argv: ["--version"], cwd: root, homeDirectory: directory, environment: cliEnvironment });
    assert.equal(await process.completion, 0);
    assert.equal(titleContext(process).get("sessionTitle"), undefined);
    assert.equal(titleContext(process).get("sessionTitleGenerator"), undefined);
    assert.equal(requests, 1, "ordinary CLI metadata commands do not resume WebUI title requests");
    await process.dispose();
    process = undefined;
    phase = "completed";
    process = await open();
    const next = titleContext(process);
    const job = await until(() => next.get("sessionTitle").inspect("disk-restart"), value => value?.state === "succeeded");
    assert.equal(job.attempts, 2);
    assert.equal(requests, 2);
    const session = await next.get("sessions").manager.get({ sessionId: "disk-restart" });
    assert.equal(session.title, "重启后恢复标题");
    assert.equal(session.titleSource, "model");
  } finally {
    await process?.dispose();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
