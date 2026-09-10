import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWishCli,
  parseWishCliArguments,
  parseWishCliActiveInput,
  WishCliUsageError,
} from "../dist/apps/cli/index.js";
import {
  ApplicationFacade,
} from "../dist/apps/application.js";
import { createWishAgent } from "../dist/core/agent/service.js";
import { createAgentLoopPipeline } from "../dist/core/agent-loop/service.js";
import { createWishRuntime } from "../dist/core/runtime/service.js";
import {
  loadWishHostConfiguration,
  WishHostConfigurationError,
} from "../dist/apps/config.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import {
  createDefaultModelAdapterRegistry,
  ModelAdapterRegistry,
} from "../dist/models/registry.js";
import { createConfiguredModelResources } from "../dist/models/runtime.js";
import { TokenizerUsageEstimator } from "../dist/models/usage.js";
import { createFileSessionResources } from "../dist/sessions/index.js";
import { createContextResources } from "../dist/context/service.js";
import { createCompactionResources } from "../dist/compaction/service.js";

function createStandaloneHostApplication(configuration, input) {
  const sessions = createFileSessionResources(configuration.dataDirectory);
  const models = createConfiguredModelResources({
    configuration: configuration.models,
    registry: createDefaultModelAdapterRegistry(),
    usageEstimator: new TokenizerUsageEstimator(),
    environment: configuration.modelEnvironment,
  });
  const context = createContextResources({
      dataDirectory: configuration.dataDirectory,
      sessions,
      agentInstructions: configuration.agentInstructions,
      models,
      configuration: {
        reservedOutputTokens: configuration.reservedOutputTokens,
      },
    });
  const compaction = createCompactionResources({
      dataDirectory: configuration.dataDirectory,
      sessions,
      models,
      keepRecentTokens: configuration.keepRecentTokens,
      summaryMaxOutputTokens: configuration.summaryMaxOutputTokens,
    });
  const runtime = {
    runtime: createWishRuntime({
      stepPipeline: createAgentLoopPipeline({
        sessions,
        agentId: configuration.agentId,
        models,
        workspace: {
          resolve({ session }) {
            return { cwd: session.scope, instructions: [] };
          },
        },
        context,
        compaction,
        ...(input.approval === undefined
          ? {}
          : { tools: { approval: input.approval } }),
      }),
    }),
  };
  return new ApplicationFacade({
    sessions,
    models,
    agent: createWishAgent({
      id: configuration.agentId,
      name: "Wish",
      configuration: {
        agentInstructions: configuration.agentInstructions,
      },
    }, runtime),
  });
}

class FakeTerminal {
  constructor({ interactive, lines = [], pipedInput = "", blocking = false }) {
    this.interactive = interactive;
    this.lines = [...lines];
    this.pipedInput = pipedInput;
    this.blocking = blocking;
    this.output = "";
    this.error = "";
    this.prompts = [];
    this.closed = false;
    this.pendingRead = undefined;
  }

  async readLine(prompt, signal) {
    this.prompts.push(prompt);
    if (this.lines.length > 0) return this.lines.shift();
    if (!this.blocking || this.closed) return undefined;
    if (this.pendingRead !== undefined) {
      throw new Error("Concurrent terminal reads are not allowed");
    }
    return new Promise((resolve) => {
      this.pendingRead = { resolve };
      if (signal === undefined) return;
      const abort = () => this.finishRead(undefined);
      this.pendingRead.abort = abort;
      this.pendingRead.signal = signal;
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  setInterruptHandler(handler) {
    this.interruptHandler = handler;
  }

  interrupt() {
    this.interruptHandler?.();
  }

  pushLine(line) {
    if (this.pendingRead === undefined) {
      this.lines.push(line);
      return;
    }
    this.finishRead(line);
  }

  async readAll() {
    return this.pipedInput;
  }

  async writeOutput(text) {
    this.output += text;
  }

  async writeError(text) {
    this.error += text;
  }

  close() {
    this.closed = true;
    this.finishRead(undefined);
  }

  finishRead(line) {
    const pending = this.pendingRead;
    if (pending === undefined) return;
    this.pendingRead = undefined;
    pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(line);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

function session(sessionId, scope, title) {
  return {
    schemaVersion: 1,
    sessionId,
    agentId: "wish",
    scope,
    status: "active",
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    historyRevision: "0",
    ...(title === undefined ? {} : { title }),
  };
}

function completed(runId, text = "") {
  return {
    status: "completed",
    result: {
      output: {
        model: { provider: "fixture", model: "primary" },
        reasoning: "",
        text,
        toolCalls: [],
      },
      steps: [],
    },
    snapshot: { id: runId },
  };
}

function modelTextEvent(runId, sequence, text) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    type: "model.stream",
    occurredAt: "2099-01-01T00:00:00.000Z",
    runId,
    userTurnId: `turn-${sequence}`,
    stepId: `step-${sequence}`,
    payload: { type: "text_delta", text },
  };
}

function modelDoneEvent(runId, sequence) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    type: "model.stream",
    occurredAt: "2099-01-01T00:00:00.000Z",
    runId,
    userTurnId: `turn-${sequence}`,
    stepId: `step-${sequence}`,
    payload: { type: "done", finishReason: "stop" },
  };
}

function openAiTextResponse(text) {
  return new Response([
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function approvalInput(scope) {
  return {
    call: {
      status: "ready",
      id: "call-1",
      name: "read",
      input: { path: "note.txt" },
    },
    descriptor: {
      name: "read",
      description: "Read a file",
      inputSchemaJson: "{}",
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
    },
    capabilities: {
      requirements: [{ capability: "filesystem.read", paths: ["note.txt"] }],
    },
    context: { cwd: scope, modelSupportsImages: false },
    scope: {
      runId: "run-1",
      userTurnId: "turn-1",
      stepId: "step-1",
    },
    snapshot: {
      schemaVersion: 1,
      registryVersion: 1,
      authorityVersion: "authority-v1",
      availableTools: ["read"],
    },
  };
}

function fakeHostConfiguration(scope) {
  return {
    dataDirectory: join(scope, ".wish"),
    agentId: "wish",
    agentInstructions: [],
    models: {},
    modelEnvironment: {},
    reservedOutputTokens: 1,
    keepRecentTokens: 1,
    summaryMaxOutputTokens: 1,
  };
}

test("parses explicit interactive and one-shot CLI modes", () => {
  assert.deepEqual(parseWishCliArguments([]), { command: "interactive" });
  assert.deepEqual(
    parseWishCliArguments([
      "--data-dir", ".data", "run", "check", "this", "--model=fixture/primary",
    ]),
    {
      command: "run",
      dataDirectory: ".data",
      model: { provider: "fixture", model: "primary" },
      prompt: "check this",
    },
  );
  assert.throws(
    () => parseWishCliArguments(["--session", "session-1", "--cwd", "."]),
    WishCliUsageError,
  );
  assert.throws(
    () => parseWishCliArguments(["unexpected"]),
    WishCliUsageError,
  );
});

test("maps active input by state without guessing between control kinds", () => {
  assert.deepEqual(parseWishCliActiveInput("change direction"), {
    type: "control",
    control: { type: "steer", source: "wish-cli", text: "change direction" },
  });
  assert.deepEqual(parseWishCliActiveInput("/steer be concise"), {
    type: "control",
    control: { type: "steer", source: "wish-cli", text: "be concise" },
  });
  assert.deepEqual(parseWishCliActiveInput("/follow-up add tests"), {
    type: "control",
    control: {
      type: "follow_up",
      source: "wish-cli",
      text: "add tests",
      payload: { text: "add tests" },
    },
  });
  assert.equal(parseWishCliActiveInput("/abort").control.type, "abort");
  assert.equal(parseWishCliActiveInput("/follow-up").type, "invalid");
  assert.equal(parseWishCliActiveInput("/unknown value").type, "invalid");
});

test("loads shared host configuration without a second Models format", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-config-"));
  try {
    const path = join(root, "models.json");
    const modelsJson = JSON.stringify({
      schemaVersion: 1,
      defaultModel: "fixture/primary",
      providers: [{
        id: "fixture",
        protocol: "openai-chat-completions",
        baseUrl: "https://fixture.example.test/v1",
        auth: { type: "none" },
        developerRoleMode: "native",
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
    });
    await writeFile(path, modelsJson, "utf8");
    const configuration = await loadWishHostConfiguration({
      modelsConfigurationPath: path,
      homeDirectory: root,
      environment: {},
      reservedOutputTokens: 512,
      keepRecentTokens: 1_024,
      summaryMaxOutputTokens: 256,
    });
    assert.equal(configuration.dataDirectory, join(root, ".wish"));
    assert.equal(configuration.models.defaultModel.model, "primary");
    assert.equal(configuration.reservedOutputTokens, 512);
    assert.equal(configuration.keepRecentTokens, 1_024);
    assert.equal(configuration.summaryMaxOutputTokens, 256);
    assert.equal(configuration.agentInstructions.length, 1);

    const inline = await loadWishHostConfiguration({
      homeDirectory: root,
      modelsConfigurationJson: modelsJson,
      environment: {},
    });
    assert.equal(inline.models.defaultModel.model, "primary");

    await assert.rejects(
      loadWishHostConfiguration({
        modelsConfigurationPath: path,
        homeDirectory: root,
        environment: {},
        reservedOutputTokens: 4_096,
      }),
      WishHostConfigurationError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host uses generated defaults or the conventional data-directory models file", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-default-models-"));
  try {
    const generated = await loadWishHostConfiguration({
      homeDirectory: root,
      environment: {},
    });
    assert.deepEqual(generated.models.defaultModel, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });

    const dataDirectory = join(root, ".wish");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      join(dataDirectory, "models.json"),
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: "fixture/local",
        providers: [{
          id: "fixture",
          protocol: "openai-chat-completions",
          baseUrl: "https://fixture.example.test/v1",
          auth: { type: "none" },
          defaultModel: "local",
          developerRoleMode: "system-fallback",
          models: [{ id: "local", toolCalling: true }],
        }],
      }),
      "utf8",
    );
    const fromFile = await loadWishHostConfiguration({
      homeDirectory: root,
      environment: {},
    });
    assert.deepEqual(fromFile.models.defaultModel, {
      provider: "fixture",
      model: "local",
    });

    await writeFile(
      join(dataDirectory, "models.json"),
      JSON.stringify({
        schemaVersion: 2,
        defaultModel: "deepseek/deepseek-v4-pro",
        providers: [{
          id: "deepseek",
          models: [{ id: "deepseek-v4-pro", maxOutputTokens: 64_000 }],
        }],
      }),
      "utf8",
    );
    const overlay = await loadWishHostConfiguration({
      homeDirectory: root,
      environment: {},
    });
    assert.equal(overlay.models.providers.length, 17);
    assert.deepEqual(overlay.models.defaultModel, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    assert.equal(
      overlay.models.providers.find((provider) => provider.id === "deepseek")
        .models.find((model) => model.id === "deepseek-v4-pro")
        .maxOutputTokens,
      64_000,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive CLI reuses one Session across sequential Runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-interactive-"));
  try {
    const terminal = new FakeTerminal({
      interactive: true,
      lines: ["inspect the note"],
      blocking: true,
    });
    const created = [];
    const starts = [];
    const application = {
      async createSession(input) {
        created.push(input);
        return session("session-1", input.workspaceRoot, input.title);
      },
      async getSession({ sessionId }) {
        return session(sessionId, root, "Existing");
      },
      async startRun(input) {
        starts.push(input);
        const runId = `run-${starts.length}`;
        return {
          agentId: "wish",
          runId,
          initialUserTurnId: `turn-${starts.length}`,
          scope: input.sessionId,
          completion: Promise.resolve(completed(runId, `answer-${starts.length}`)),
        };
      },
      async *observeRun(runId) {
        const ordinal = Number(runId.slice("run-".length));
        yield modelTextEvent(runId, 1, `answer-${ordinal}`);
        yield modelDoneEvent(runId, 2);
      },
      controlRun() {
        throw new Error("No control expected");
      },
    };
    const cli = createWishCli({
      terminal,
      cwd: () => root,
      async openApplication(input) {
        const configuration = fakeHostConfiguration(root);
        assert.equal(configuration.dataDirectory, join(root, ".wish"));
        assert.ok(input.approval);
        return application;
      },
    });

    const running = cli.run([]);
    await waitFor(() => starts.length === 1, "first interactive Run did not start");
    await waitFor(
      () => terminal.prompts.filter((prompt) => prompt === "wish> ").length >= 2,
      "idle prompt did not return after the first Run",
    );
    terminal.pushLine("continue");
    await waitFor(() => starts.length === 2, "second interactive Run did not start");
    await waitFor(
      () => terminal.prompts.filter((prompt) => prompt === "wish> ").length >= 3,
      "idle prompt did not return after the second Run",
    );
    terminal.pushLine(undefined);

    assert.equal(await running, 0);
    assert.equal(created.length, 1);
    assert.equal(created[0].workspaceRoot, root);
    assert.equal(created[0].title, "inspect the note");
    assert.deepEqual(starts.map((item) => item.sessionId), [
      "session-1",
      "session-1",
    ]);
    assert.equal(terminal.output, "answer-1\nanswer-2\n");
    assert.match(terminal.error, /Session: session-1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one-shot piped input keeps answer on stdout and denies non-TTY tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-pipe-"));
  try {
    const terminal = new FakeTerminal({
      interactive: false,
      pipedInput: "summarize stdin\n",
    });
    let approval;
    let approvalResponse;
    const application = {
      async createSession(input) {
        return session("session-pipe", input.workspaceRoot, input.title);
      },
      async startRun(input) {
        approvalResponse = await approval.requestApproval(approvalInput(root));
        return {
          agentId: "wish",
          runId: "run-pipe",
          initialUserTurnId: "turn-pipe",
          scope: input.sessionId,
          completion: Promise.resolve(completed("run-pipe", "pipe answer")),
        };
      },
      async *observeRun() {
        yield modelTextEvent("run-pipe", 1, "pipe answer");
        yield modelDoneEvent("run-pipe", 2);
      },
      controlRun() {
        throw new Error("No control expected");
      },
    };
    const cli = createWishCli({
      terminal,
      cwd: () => root,
      async openApplication(input) {
        approval = input.approval;
        return application;
      },
    });

    assert.equal(await cli.run(["run"]), 0);
    assert.equal(terminal.output, "pipe answer\n");
    assert.equal(approvalResponse.status, "denied");
    assert.match(terminal.error, /approval requires an interactive terminal/u);
    assert.match(terminal.error, /Session: session-pipe/u);
    assert.equal(terminal.prompts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real CLI composition persists Session history across one-shot invocations", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-real-composition-"));
  const originalFetch = globalThis.fetch;
  try {
    const modelsJson = JSON.stringify({
      schemaVersion: 1,
      defaultModel: "fixture/primary",
      maxRetries: 0,
      providers: [{
        id: "fixture",
        protocol: "openai-chat-completions",
        baseUrl: "https://fixture.example.test/v1",
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
    });
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return openAiTextResponse(`integrated answer ${requests.length}`);
    };
    const environment = {};
    const openApplication = async (input) => createStandaloneHostApplication(
      await loadWishHostConfiguration({
      ...input,
      homeDirectory: root,
      modelsConfigurationJson: modelsJson,
      environment,
      }),
      input,
    );
    const firstTerminal = new FakeTerminal({
      interactive: false,
      pipedInput: "first integrated question\n",
    });
    const first = createWishCli({
      terminal: firstTerminal,
      cwd: () => root,
      openApplication,
    });
    assert.equal(await first.run(["run", "--data-dir", "data"]), 0);
    assert.equal(firstTerminal.output, "integrated answer 1\n");
    const sessionId = /Session: ([^\n]+)/u.exec(firstTerminal.error)?.[1];
    assert.ok(sessionId);

    const secondTerminal = new FakeTerminal({ interactive: false });
    const second = createWishCli({
      terminal: secondTerminal,
      cwd: () => root,
      openApplication,
    });
    assert.equal(await second.run([
      "run",
      "--data-dir",
      "data",
      "--session",
      sessionId,
      "second integrated question",
    ]), 0);
    assert.equal(secondTerminal.output, "integrated answer 2\n");
    assert.equal(requests.length, 2);
    assert.equal(
      requests[1].messages.some((message) =>
        message.role === "assistant" && message.content === "integrated answer 1"
      ),
      true,
    );
    assert.equal(
      requests[1].messages.filter((message) =>
        message.role === "user" && message.content === "second integrated question"
      ).length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("active input controls Runtime while Tool approval owns stdin exclusively", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-controls-"));
  try {
    const terminal = new FakeTerminal({
      interactive: true,
      lines: ["initial question"],
      blocking: true,
    });
    const started = deferred();
    const runCompletion = deferred();
    const controls = [];
    let approval;
    const application = {
      async createSession(input) {
        return session("session-controls", input.workspaceRoot, input.title);
      },
      async startRun(input) {
        started.resolve();
        return {
          agentId: "wish",
          runId: "run-controls",
          initialUserTurnId: "turn-controls",
          scope: input.sessionId,
          completion: runCompletion.promise,
        };
      },
      async *observeRun() {
        await runCompletion.promise;
      },
      controlRun(runId, control) {
        controls.push({ runId, control });
        if (control.type === "abort") {
          runCompletion.resolve({
            status: "aborted",
            cancellation: {
              reason: control.reason,
              source: control.source,
              requestedAt: "2099-01-01T00:00:00.000Z",
            },
            snapshot: { id: runId },
          });
          return {
            accepted: true,
            kind: "abort",
            runId,
            controlId: "control-abort",
          };
        }
        return {
          accepted: true,
          kind: control.type,
          runId,
          controlId: `control-${controls.length}`,
          position: control.type === "steer" ? controls.length : 1,
        };
      },
    };
    const cli = createWishCli({
      terminal,
      cwd: () => root,
      async openApplication(input) {
        approval = input.approval;
        return application;
      },
    });
    const running = cli.run([]);
    await started.promise;
    await waitFor(
      () => terminal.prompts.includes(
        "wish [running: Enter=steer, /follow-up, /abort]> ",
      ),
      "active control prompt did not start",
    );

    const approvalPromise = approval.requestApproval(approvalInput(root));
    await waitFor(
      () => terminal.prompts.includes("Allow this call once? [y/N] "),
      "Tool approval did not preempt the control prompt",
    );
    terminal.pushLine("y");
    assert.equal((await approvalPromise).status, "approved");

    await waitFor(
      () => terminal.prompts.filter((prompt) => prompt.startsWith("wish [running")).length >= 2,
      "control prompt did not resume after approval",
    );
    terminal.pushLine("change focus");
    await waitFor(() => controls.length === 1, "ordinary input was not delivered");
    terminal.pushLine("/steer explicit correction");
    await waitFor(() => controls.length === 2, "explicit steer was not delivered");
    terminal.pushLine("/follow-up add a summary");
    await waitFor(() => controls.length === 3, "follow-up was not delivered");
    terminal.pushLine("/abort");
    await waitFor(() => controls.length === 4, "abort was not delivered");
    terminal.pushLine(undefined);

    assert.equal(await running, 0);
    assert.deepEqual(controls.map(({ control }) => control), [
      { type: "steer", source: "wish-cli", text: "change focus" },
      { type: "steer", source: "wish-cli", text: "explicit correction" },
      {
        type: "follow_up",
        source: "wish-cli",
        text: "add a summary",
        payload: { text: "add a summary" },
      },
      {
        type: "abort",
        source: "wish-cli",
        reason: "User requested /abort",
      },
    ]);
    assert.match(terminal.error, /steer accepted at position 1/u);
    assert.match(terminal.error, /follow-up accepted at position 1/u);
    assert.match(terminal.error, /abort accepted/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI controls drive the real Runtime Step and UserTurn queues", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-real-controls-"));
  try {
    const terminal = new FakeTerminal({
      interactive: true,
      lines: ["initial task"],
      blocking: true,
    });
    const gates = [deferred(), deferred()];
    const requests = [];
    const adapters = new ModelAdapterRegistry();
    adapters.register("fixture-protocol", () => ({
      async *stream(request, signal) {
        requests.push(request);
        const index = requests.length - 1;
        yield { type: "start", model: request.model };
        if (index < 2) {
          await gates[index].promise;
          yield {
            type: "text_delta",
            text: index === 0 ? "first answer" : "steered answer",
          };
          yield { type: "done", finishReason: "stop" };
          return;
        }
        if (!signal.aborted) {
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true })
          );
        }
        yield {
          type: "error",
          error: { code: "aborted", message: "stopped", retryable: false },
        };
      },
    }));
    const models = loadModelsConfiguration({
      json: {
        schemaVersion: 1,
        defaultModel: "fixture/primary",
        maxRetries: 0,
        providers: [{
          id: "fixture",
          protocol: "fixture-protocol",
          baseUrl: "https://fixture.example.test/v1",
          auth: { type: "none" },
          developerRoleMode: "native",
          models: [{
            id: "primary",
            status: "active",
            contextWindowTokens: 8_192,
            maxOutputTokens: 1_024,
            input: { text: true, image: false },
            reasoning: false,
            toolCalling: false,
            developerRole: true,
          }],
        }],
      },
      availableProtocols: ["fixture-protocol"],
    });
    const cli = createWishCli({
      terminal,
      cwd: () => root,
      async openApplication(input) {
        const dataDirectory = join(root, "data");
        const sessions = createFileSessionResources(dataDirectory);
        const modelResources = createConfiguredModelResources({
          configuration: models,
          registry: adapters,
          usageEstimator: new TokenizerUsageEstimator(),
        });
        const context = createContextResources({
          dataDirectory,
          sessions,
          agentInstructions: [],
          models: modelResources,
          configuration: { reservedOutputTokens: 1_024 },
        });
        const compaction = createCompactionResources({
          dataDirectory,
          sessions,
          models: modelResources,
          keepRecentTokens: 1_024,
          summaryMaxOutputTokens: 512,
        });
        const runtime = {
          runtime: createWishRuntime({
            stepPipeline: createAgentLoopPipeline({
              sessions,
              agentId: "wish",
              models: modelResources,
              workspace: {
                resolve({ session }) {
                  return { cwd: session.scope, instructions: [] };
                },
              },
              context,
              compaction,
              tools: { approval: input.approval },
            }),
          }, { maxSteps: 4 }),
        };
        return new ApplicationFacade({
          sessions,
          agent: createWishAgent({
            id: "wish",
            configuration: { agentInstructions: [] },
          }, runtime),
          models: modelResources,
        });
      },
    });
    const running = cli.run([]);
    await waitFor(() => requests.length === 1, "first model Step did not start");
    terminal.pushLine("focus on sessions");
    await waitFor(
      () => /steer accepted at position 1/u.test(terminal.error),
      "steer was not accepted by Runtime",
    );
    gates[0].resolve();
    await waitFor(() => requests.length === 2, "steered Step did not start");
    assert.equal(
      requests[1].messages.some((message) =>
        message.role === "user" && message.content === "focus on sessions"
      ),
      true,
    );

    terminal.pushLine("/follow-up summarize the result");
    await waitFor(
      () => /follow-up accepted at position 1/u.test(terminal.error),
      "follow-up was not accepted by Runtime",
    );
    gates[1].resolve();
    await waitFor(() => requests.length === 3, "follow-up UserTurn did not start");
    assert.equal(
      requests[2].messages.filter((message) =>
        message.role === "user" && message.content === "summarize the result"
      ).length,
      1,
    );

    terminal.pushLine("/abort");
    await waitFor(
      () => /\[run\] aborted: User requested \/abort/u.test(terminal.error),
      "Runtime Run did not abort",
    );
    terminal.pushLine(undefined);
    assert.equal(await running, 0);
    assert.match(terminal.error, /steering delivered to/u);
    assert.match(terminal.error, /follow-up .* started/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGINT aborts the active Run without terminating the interactive Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-cli-interrupt-"));
  try {
    const terminal = new FakeTerminal({
      interactive: true,
      lines: ["wait", undefined],
    });
    let resolveCompletion;
    let started = false;
    const controls = [];
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const application = {
      async createSession(input) {
        return session("session-interrupt", input.workspaceRoot, input.title);
      },
      async startRun(input) {
        started = true;
        return {
          agentId: "wish",
          runId: "run-interrupt",
          initialUserTurnId: "turn-interrupt",
          scope: input.sessionId,
          completion,
        };
      },
      async *observeRun() {
        await completion;
      },
      controlRun(runId, control) {
        controls.push({ runId, control });
        resolveCompletion({
          status: "aborted",
          cancellation: {
            reason: control.reason,
            source: control.source,
            requestedAt: "2099-01-01T00:00:00.000Z",
          },
          snapshot: { id: runId },
        });
        return { accepted: true, kind: "abort", runId, controlId: "abort-1" };
      },
    };
    const forced = [];
    const cli = createWishCli({
      terminal,
      cwd: () => root,
      openApplication: async () => application,
      forceExit: (code) => forced.push(code),
      interruptTimeoutMs: 100,
    });
    const run = cli.run([]);
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    terminal.interrupt();

    assert.equal(await run, 0);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].runId, "run-interrupt");
    assert.equal(controls[0].control.type, "abort");
    assert.equal(forced.length, 0);
    assert.match(terminal.error, /abort requested by SIGINT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
