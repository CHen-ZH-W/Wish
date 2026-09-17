import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context, Service } from "@deepseek-ai/cordis";

import {
  RunGeneration,
  RunGenerationDrainTimeoutError,
  RunGenerationRetiredError,
} from "../dist/core/runtime/generation.js";
import Runtime from "../dist/composition/runtime-service.js";
import { bootstrap } from "../dist/boot/bootstrap.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

class StubRuntimeLifecycle extends Service {
  version = "fixture-runtime-lifecycle-v1";

  constructor(ctx) {
    super(ctx, "runtimeLifecycle");
  }

  openRun() {}
  finishRun() {}
  openUserTurn() {}
  finishUserTurn() {}
  openStep() {}
  finishStep() {}
}

test("retirement closes admission, aborts once, drains originals, and never replays", async () => {
  const completions = new Map();
  const starts = [];
  const controls = [];
  let resourceReleases = 0;
  const runtime = {
    startRun(definition, input) {
      const completion = deferred();
      const runId = input.runId ?? `run-${starts.length + 1}`;
      completions.set(runId, completion);
      starts.push({ definition, input, runId });
      return Object.freeze({
        agentId: definition.id,
        runId,
        initialUserTurnId: `turn-${starts.length}`,
        scope: input.scope,
        completion: completion.promise,
      });
    },
    control(agentId, runId, control) {
      controls.push({ agentId, runId, control });
      return Object.freeze({ accepted: true, kind: control.type, runId });
    },
    async *observe() {},
  };
  const generation = new RunGeneration(runtime, {
    id: "generation-1",
    drainTimeoutMs: 1_000,
    abortControl: ({ reason }) => Object.freeze({
      type: "abort",
      source: "generation-test",
      reason,
    }),
    release() {
      resourceReleases += 1;
    },
  });
  const definition = Object.freeze({ id: "agent-1" });
  const first = generation.startRun(definition, {
    runId: "run-1",
    scope: "session-1",
    payload: "first",
  });
  generation.startRun(definition, {
    runId: "run-2",
    scope: "session-2",
    payload: "second",
  });

  const retirement = generation.retire({ reason: "configuration reload" });
  assert.equal(generation.retire(), retirement, "retirement must be idempotent");
  assert.equal(generation.state, "retiring");
  assert.deepEqual(
    generation.snapshot().activeRuns.map((run) => ({
      runId: run.runId,
      abortRequested: run.abortRequested,
    })),
    [
      { runId: "run-1", abortRequested: true },
      { runId: "run-2", abortRequested: true },
    ],
  );
  assert.deepEqual(
    controls.map(({ runId, control }) => ({ runId, ...control })),
    [
      {
        runId: "run-1",
        type: "abort",
        source: "generation-test",
        reason: "configuration reload",
      },
      {
        runId: "run-2",
        type: "abort",
        source: "generation-test",
        reason: "configuration reload",
      },
    ],
  );
  assert.throws(
    () => generation.startRun(definition, {
      runId: "run-3",
      scope: "session-3",
      payload: "stale",
    }),
    (error) =>
      error instanceof RunGenerationRetiredError &&
      error.code === "run_generation_retired" &&
      error.generationId === "generation-1",
  );

  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  completions.get(first.runId).resolve({ status: "aborted" });
  await tick();
  assert.equal(retired, false);
  assert.equal(generation.snapshot().activeRuns.length, 1);
  assert.equal(resourceReleases, 0);

  completions.get("run-2").resolve({ status: "aborted" });
  await retirement;
  assert.equal(generation.state, "retired");
  assert.equal(generation.snapshot().activeRuns.length, 0);
  assert.equal(starts.length, 2, "retirement must not replay a Run");
  assert.equal(controls.length, 2, "each active Run receives one abort");
  assert.equal(resourceReleases, 1);
});

test("a drain timeout fails visibly but remains pending until the original completion", async () => {
  const completion = deferred();
  const controls = [];
  const runtime = {
    startRun(definition, input) {
      return Object.freeze({
        agentId: definition.id,
        runId: "run-stuck",
        initialUserTurnId: "turn-stuck",
        scope: input.scope,
        completion: completion.promise,
      });
    },
    control(agentId, runId, control) {
      controls.push({ agentId, runId, control });
      return Object.freeze({ accepted: true, kind: control.type, runId });
    },
    async *observe() {},
  };
  const generation = new RunGeneration(runtime, {
    id: "generation-timeout",
    drainTimeoutMs: 20,
    abortControl: ({ reason }) => ({ type: "abort", reason }),
  });
  generation.startRun({ id: "agent-1" }, {
    scope: "session-stuck",
    payload: "unknown-side-effect",
  });
  const timeout = deferred();
  const retirement = generation.retire({
    onDrainTimeout: (error) => timeout.resolve(error),
  });
  const error = await withTimeout(
    timeout.promise,
    1_000,
    "generation drain timeout was not reported",
  );
  assert.ok(error instanceof RunGenerationDrainTimeoutError);
  assert.equal(error.code, "run_generation_drain_timeout");
  assert.equal(error.timeoutMs, 20);
  assert.deepEqual(error.activeRuns.map((run) => run.runId), ["run-stuck"]);
  assert.equal(generation.state, "retiring");
  assert.equal(controls.length, 1);

  let retired = false;
  void retirement.then(() => {
    retired = true;
  });
  await tick();
  assert.equal(retired, false, "timeout must not claim the old Run was cleaned");
  let lateNotification;
  assert.equal(generation.retire({
    onDrainTimeout: (lateError) => {
      lateNotification = lateError;
    },
  }), retirement);
  assert.equal(lateNotification, error);

  completion.resolve({ status: "aborted" });
  await retirement;
  assert.equal(generation.state, "retired");
  assert.equal(controls.length, 1);
});

test("Cordis Runtime update drains the old generation before activating the new one", async () => {
  const entered = deferred();
  let executions = 0;
  let cancellations = 0;
  let sessionReleases = 0;

  class StubAgentLoop extends Service {
    constructor(ctx) {
      super(ctx, "agentLoop");
    }

    open() {
      let sessionReleased = false;
      let contextReleased = false;
      let resourcesReleased = false;
      const sessions = Object.freeze({
        manager: {},
        get released() {
          return sessionReleased;
        },
        release() {
          if (sessionReleased) return false;
          sessionReleased = true;
          sessionReleases += 1;
          return true;
        },
      });
      const context = Object.freeze({
        get released() {
          return contextReleased;
        },
        release() {
          if (contextReleased) return false;
          contextReleased = true;
          return true;
        },
      });
      return Object.freeze({
        sessions,
        context,
        models: Object.freeze({ configuredModel: {} }),
        stepPipeline: {
          async execute({ signal }) {
            executions += 1;
            entered.resolve();
            if (!signal.aborted) {
              await new Promise((accept) =>
                signal.addEventListener("abort", accept, { once: true })
              );
            }
            cancellations += 1;
            return { status: "aborted", reason: "generation retired" };
          },
        },
        get released() {
          return resourcesReleased;
        },
        release() {
          if (resourcesReleased) return false;
          resourcesReleased = true;
          context.release();
          sessions.release();
          return true;
        },
      });
    }
  }

  const root = new Context();
  root.provide("launch", { fail() {} });
  root.provide("sessions", { acquire() { return { manager: {}, release() {} }; } });
  root.provide("models", { open() { return { configuredModel: {} }; } });
  await root.plugin(StubRuntimeLifecycle);
  await root.plugin(StubAgentLoop);
  const generations = [];
  let oldHandle;
  const consumer = root.plugin({
    inject: ["runEngine"],
    apply(ctx) {
      if (generations.length > 0) {
        assert.equal(
          generations.at(-1).state,
          "retired",
          "a replacement must not overlap the old active generation",
        );
      }
      const resources = ctx.runEngine.open({
        dataDirectory: "state",
        agentId: "agent-1",
        agentInstructions: [],
        modelsConfiguration: {},
        reservedOutputTokens: 1,
        keepRecentTokens: 1,
        summaryMaxOutputTokens: 1,
      });
      generations.push(resources.generation);
      if (generations.length === 1) {
        oldHandle = resources.runtime.startRun(
          { id: "agent-1", configuration: { agentInstructions: [] } },
          { runId: "run-old", scope: "session-old", payload: { text: "wait" } },
        );
      }
    },
  });
  const runtimeProvider = root.plugin(Runtime, {
    maxSteps: 2,
    generationDrainTimeoutMs: 1_000,
  });
  try {
    await consumer.await();
    await entered.promise;
    const oldGeneration = generations[0];
    const oldId = oldGeneration.id;

    await runtimeProvider.update({
      maxSteps: 3,
      generationDrainTimeoutMs: 1_000,
    });
    await consumer.await();
    const completion = await oldHandle.completion;
    assert.equal(completion.status, "aborted");
    assert.equal(completion.cancellation.source, "wish-run-generation");
    assert.equal(oldGeneration.state, "retired");
    assert.throws(
      () => oldGeneration.startRun(
        { id: "agent-1", configuration: { agentInstructions: [] } },
        { scope: "stale", payload: { text: "must fail" } },
      ),
      RunGenerationRetiredError,
    );

    assert.equal(generations.length, 2);
    assert.notEqual(generations[1].id, oldId);
    assert.equal(generations[1].state, "accepting");
    assert.equal(executions, 1);
    assert.equal(cancellations, 1);
    assert.equal(sessionReleases, 1);
  } finally {
    await root.fiber.dispose();
  }
  assert.equal(generations.at(-1)?.state, "retired");
  assert.equal(executions, 1, "Cordis update must not replay old work");
  assert.equal(sessionReleases, 1, "only the executed Step opens and releases pipeline resources");
});

test("Loader stable-id update safely replaces a WebUI graph with an active model stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-run-generation-loader-"));
  const configurationFile = join(directory, "cordis.yml");
  const provider = createServer((request, response) => {
    providerRequests += 1;
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { content: "started" },
          finish_reason: null,
        }],
      })}\n\n`,
    );
    response.on("close", () => {
      providerCloses += 1;
    });
  });
  let providerRequests = 0;
  let providerCloses = 0;
  let booted;
  try {
    await copyFile(join(repositoryRoot, "config", "cordis.yml"), configurationFile);
    const providerAddress = await listen(provider);
    const webPort = await reservePort();
    booted = await bootstrap({
      surface: "webui",
      cwd: repositoryRoot,
      homeDirectory: directory,
      configurationFile,
      environment: {
        WISH_DATA_DIR: join(directory, "state"),
        WISH_MODELS_JSON: JSON.stringify(loaderModelConfiguration(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        )),
        WISH_WEBUI_HOST: "127.0.0.1",
        WISH_WEBUI_PORT: String(webPort),
        WISH_WEBUI_WORKSPACE_ROOT: directory,
        WISH_RUN_GENERATION_DRAIN_TIMEOUT_MS: "2000",
      },
    });
    const created = await requestJson(
      webPort,
      "/api/sessions",
      { method: "POST", body: { sessionId: "loader-session" } },
    );
    assert.equal(created.response.status, 201);
    const accepted = await requestJson(
      webPort,
      "/api/sessions/loader-session/runs",
      { method: "POST", body: { text: "keep streaming" } },
    );
    assert.equal(accepted.response.status, 202);
    await waitFor(() => providerRequests === 1, "model stream did not start");

    const oldRuntime = booted.surfaceContext.get("runEngine");
    await withTimeout(
      booted.context.loader.update("include:runtime", {
        config: { maxSteps: 33, generationDrainTimeoutMs: 2_000 },
      }),
      5_000,
      "Loader update did not drain the active generation",
    );
    await booted.context.loader.resolve("include:webui").fiber.await();
    await waitFor(() => providerCloses === 1, "old model stream was not closed");

    const newRuntime = booted.surfaceContext.get("runEngine");
    assert.notEqual(newRuntime, oldRuntime);
    assert.equal(newRuntime.maxSteps, 33);
    const health = await requestJson(webPort, "/api/health");
    assert.equal(health.response.status, 200);
    const sessions = await requestJson(webPort, "/api/sessions");
    assert.deepEqual(
      sessions.value.sessions.map((session) => session.sessionId),
      ["loader-session"],
    );
    const staleRun = await requestJson(
      webPort,
      `/api/runs/${accepted.value.run.runId}`,
    );
    assert.equal(staleRun.response.status, 404);
    await delay(25);
    assert.equal(providerRequests, 1, "Loader update must not replay the model request");
    assert.equal(booted.completion, booted.context.get("launch").completion);
  } finally {
    provider.closeAllConnections?.();
    await booted?.dispose();
    await closeServer(provider);
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((accept) => setImmediate(accept));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loaderModelConfiguration(baseUrl) {
  return {
    schemaVersion: 1,
    defaultModel: "fixture/model",
    fallbackModels: [],
    maxRetries: 0,
    providers: [{
      id: "fixture",
      protocol: "openai-chat-completions",
      baseUrl,
      auth: { type: "none" },
      developerRoleMode: "native",
      request: { streamUsage: false },
      models: [{
        id: "model",
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

function requestJson(port, path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined
      ? undefined
      : { "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }).then(async (response) => ({ response, value: await response.json() }));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error(message);
}

function delay(timeoutMs) {
  return new Promise((accept) => setTimeout(accept, timeoutMs));
}

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  return server.address();
}

async function reservePort() {
  const server = createServer();
  const address = await listen(server);
  await closeServer(server);
  return address.port;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((accept, reject) => {
    server.close((error) => error === undefined ? accept() : reject(error));
  });
}
