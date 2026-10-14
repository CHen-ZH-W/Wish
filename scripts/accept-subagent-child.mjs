import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWishCli, parseWishCliArguments } from "../dist/apps/cli/index.js";
import {
  FileSubagentExchange,
  snapshotResult,
} from "../dist/subagents/index.js";
import { WishCliSubagentLauncherBackend } from
  "../dist/apps/cli/subagent-launcher.js";

class FixtureTerminal {
  interactive = true;
  output = "";
  error = "";
  async readLine() { return undefined; }
  async readAll() { return ""; }
  async writeOutput(text) { this.output += text; }
  async writeError(text) { this.error += text; }
  close() {}
}

function completed(runId, text) {
  return Object.freeze({
    status: "completed",
    result: Object.freeze({
      output: Object.freeze({
        model: Object.freeze({ provider: "fixture", model: "primary" }),
        reasoning: "",
        text,
        toolCalls: Object.freeze([]),
      }),
      message: Object.freeze({ role: "assistant", content: text }),
      messages: Object.freeze([]),
    }),
    snapshot: Object.freeze({ id: runId }),
  });
}

function modelConfiguration(auth = { type: "none" }, fallbackAuth) {
  return Object.freeze({
    schemaVersion: 1,
    providers: Object.freeze([Object.freeze({
      id: "fixture",
      protocol: "fixture",
      baseUrl: "https://fixture.invalid/v1",
      auth: Object.freeze(auth),
      headers: Object.freeze({}),
      defaultModel: "primary",
      developerRoleMode: "native",
      request: Object.freeze({ streamUsage: false, supportsTemperature: true, maxTokensField: "max_tokens", extraBody: Object.freeze({}) }),
      catalog: Object.freeze({ enabled: false }),
      models: Object.freeze([
        Object.freeze({ id: "primary", status: "active", input: Object.freeze({ text: true, image: false }), reasoning: false, toolCalling: true, developerRole: true }),
        Object.freeze({ id: "fallback", status: "active", input: Object.freeze({ text: true, image: false }), reasoning: false, toolCalling: true, developerRole: true,
          ...(fallbackAuth === undefined ? {} : { auth: Object.freeze(fallbackAuth) }) }),
      ]),
    })]),
    defaultModel: Object.freeze({ provider: "fixture", model: "primary" }),
    fallbackModels: fallbackAuth === undefined ? Object.freeze([]) : Object.freeze([Object.freeze({ provider: "fixture", model: "fallback" })]),
    maxRetries: 0,
  });
}

test("Wish child CLI consumes a private task, fixes ids, and writes a structured result", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "wish-child-workspace-"));
  const dataDirectory = join(workspace, ".wish");
  const exchange = new FileSubagentExchange(dataDirectory);
  const taskPath = await exchange.createTask("child-1", "Review the implementation");
  const identity = Object.freeze({ id: "child-1", childSessionId: "child-session-1", childRunId: "child-run-1" });
  const credentialPath = await exchange.writeCredentials(identity, { FIXTURE_API_KEY: "private-child-key" });
  const terminal = new FixtureTerminal();
  const calls = [];
  let modelCredential;
  const application = {
    agentId: "wish",
    async createSession(input) {
      calls.push(["create", input]);
      return Object.freeze({
        schemaVersion: 1,
        sessionId: input.sessionId,
        agentId: "wish",
        scope: workspace,
        status: "active",
        createdAt: "2026-09-12T12:00:00.000Z",
        updatedAt: "2026-09-12T12:00:00.000Z",
        historyRevision: "revision-1",
      });
    },
    async startRun(input) {
      assert.equal(modelCredential("FIXTURE_API_KEY"), "private-child-key", "child credential remains available during the Run");
      calls.push(["run", input]);
      return Object.freeze({
        runId: input.runId,
        completion: Promise.resolve(completed(input.runId, "Review complete")),
      });
    },
    async *observeRun(runId) {
      yield Object.freeze({
        schemaVersion: 1,
        eventId: "event-1",
        sequence: 1,
        type: "model.stream",
        occurredAt: "2026-09-12T12:00:00.000Z",
        runId,
        userTurnId: "turn-1",
        stepId: "step-1",
        payload: Object.freeze({ type: "text_delta", text: "Review complete" }),
      });
      yield Object.freeze({
        schemaVersion: 1,
        eventId: "event-2",
        sequence: 2,
        type: "model.stream",
        occurredAt: "2026-09-12T12:00:01.000Z",
        runId,
        userTurnId: "turn-1",
        stepId: "step-1",
        payload: Object.freeze({ type: "done", finishReason: "stop" }),
      });
    },
    controlRun() { return { accepted: false }; },
  };
  try {
    const cli = createWishCli({
      terminal,
      environment: { WISH_CHILD_CREDENTIALS_FILE: credentialPath },
      openApplication: async (input) => {
        modelCredential = input.modelCredential;
        assert.equal(modelCredential("FIXTURE_API_KEY"), "private-child-key");
        return application;
      },
    });
    const argv = [
      "child",
      "--child-id", "child-1",
      "--child-session", "child-session-1",
      "--child-run", "child-run-1",
      "--prompt-file", taskPath,
      "--data-dir", dataDirectory,
      "--exchange-data-dir", dataDirectory,
      "--cwd", workspace,
    ];
    assert.equal(await cli.run(argv), 0);
    assert.equal(calls[0][1].sessionId, "child-session-1");
    assert.equal(calls[1][1].runId, "child-run-1");
    assert.equal(calls[1][1].payload.text, "Review the implementation");
    const result = await exchange.read("child-1");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Review complete");
    assert.equal(modelCredential("FIXTURE_API_KEY"), undefined, "child credentials are released after the Run");
    await assert.rejects(readFile(taskPath, "utf8"), (error) => error.code === "ENOENT");
    await assert.rejects(readFile(credentialPath, "utf8"), (error) => error.code === "ENOENT");
    assert.match(terminal.output, /Review complete/u);
    assert.equal(`${terminal.output}\n${terminal.error}`.includes("private-child-key"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Wish Subagent launcher keeps task text out of argv and fixes child authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-child-launcher-"));
  try {
    const launcher = new WishCliSubagentLauncherBackend({
      dataDirectory: directory,
      cliEntry: "/opt/wish/main.js",
      executable: "/opt/node",
    });
    const launch = await launcher.resolve({
      parentAgentId: "wish",
      parentSessionId: "parent-session",
      parentRunId: "parent-run",
      workspaceRoot: directory,
      task: "private task text",
      role: "tester",
      permissionProfile: "read-only",
      availableTools: ["read", "grep"],
      modelsConfiguration: modelConfiguration(),
    }, {
      id: "child-2",
      childSessionId: "child-session-2",
      childRunId: "child-run-2",
    });
    assert.equal(launch.command.executable, "/opt/node");
    assert.equal(launch.command.args.includes("private task text"), false);
    assert.equal(launch.command.args.includes("child-run-2"), true);
    const childData = launch.command.args[launch.command.args.indexOf("--data-dir") + 1];
    assert.match(childData, /subagents\/children\/[a-f0-9]{64}$/u);
    assert.equal(launch.command.environment.WISH_PERMISSION_PROFILE, "read-only");
    assert.equal(launch.command.environment.WISH_AVAILABLE_TOOLS, "read,grep");
    assert.equal(launch.command.environment.WISH_SUBAGENTS_ENABLED, "0");
    assert.equal(launch.command.environment.WISH_SUBAGENT_TOOLS_ENABLED, "0");
    assert.equal(launch.command.environment.WISH_DATA_DIR, childData);
    assert.equal(launch.command.environment.WISH_STORAGE_FILE_ROOT, join(childData, "storage"));
    const promptPath = launch.command.args[launch.command.args.indexOf("--prompt-file") + 1];
    assert.equal(await readFile(promptPath, "utf8"), "private task text");
    const modelsPath = launch.command.args[launch.command.args.indexOf("--models-config") + 1];
    const configured = modelConfiguration();
    assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), {
      schemaVersion: 1,
      providers: configured.providers,
      defaultModel: "fixture/primary",
      fallbackModels: [],
      maxRetries: 0,
    });
    await launch.cleanupOnFailure();
    await assert.rejects(readFile(promptPath, "utf8"), (error) => error.code === "ENOENT");
    await assert.rejects(readFile(modelsPath, "utf8"), (error) => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wish Subagent launcher hands only selected Model credentials through a one-use private file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-child-credentials-"));
  const secrets = Object.freeze({ PRIMARY_API_KEY: "primary-secret", FALLBACK_API_KEY: "fallback-secret", UNUSED_API_KEY: "unused-secret" });
  const exchange = new FileSubagentExchange(directory);
  const identity = Object.freeze({ id: "child-secret", childSessionId: "child-secret-session", childRunId: "child-secret-run" });
  try {
    const launcher = new WishCliSubagentLauncherBackend({
      dataDirectory: directory,
      cliEntry: "/opt/wish/main.js",
      executable: "/opt/node",
      exchange,
      resolveCredential: reference => secrets[reference],
    });
    const launch = await launcher.resolve({
      parentAgentId: "wish",
      parentSessionId: "parent-session",
      parentRunId: "parent-run",
      workspaceRoot: directory,
      task: "inspect credentials safely",
      model: "fixture/primary",
      modelsConfiguration: modelConfiguration(
        { type: "bearer", apiKeyEnv: "PRIMARY_API_KEY" },
        { type: "bearer", apiKeyEnv: "FALLBACK_API_KEY" },
      ),
    }, identity);
    const credentialPath = launch.command.environment.WISH_CHILD_CREDENTIALS_FILE;
    assert.equal(launch.command.environment.PRIMARY_API_KEY, "");
    assert.equal(launch.command.environment.FALLBACK_API_KEY, "");
    assert.equal(JSON.stringify(launch.command).includes("primary-secret"), false);
    assert.equal(JSON.stringify(launch.command).includes("fallback-secret"), false);
    assert.equal(JSON.stringify(launch.command).includes("unused-secret"), false);
    assert.equal((await stat(credentialPath)).mode & 0o077, 0);
    assert.deepEqual(await exchange.consumeCredentials(identity, credentialPath), {
      PRIMARY_API_KEY: "primary-secret",
      FALLBACK_API_KEY: "fallback-secret",
    });
    await assert.rejects(readFile(credentialPath, "utf8"), error => error.code === "ENOENT");
    await launch.cleanupOnFailure();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wish Subagent launcher fails before execution when a scoped credential is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-child-missing-credential-"));
  const exchange = new FileSubagentExchange(directory);
  const identity = Object.freeze({ id: "child-missing", childSessionId: "child-missing-session", childRunId: "child-missing-run" });
  try {
    const launcher = new WishCliSubagentLauncherBackend({
      dataDirectory: directory,
      exchange,
      resolveCredential: () => undefined,
    });
    await assert.rejects(launcher.resolve({
      parentAgentId: "wish",
      parentSessionId: "parent-session",
      parentRunId: "parent-run",
      workspaceRoot: directory,
      task: "must not launch",
      model: "fixture/primary",
      modelsConfiguration: modelConfiguration({ type: "bearer", apiKeyEnv: "MISSING_API_KEY" }),
    }, identity), /Missing required Subagent Model credential MISSING_API_KEY/u);
    await assert.rejects(readFile(exchange.credentialsPath(identity.id), "utf8"), error => error.code === "ENOENT");
    const tasks = await readdir(join(exchange.rootDirectory, "tasks")).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(tasks, []);
    await assert.rejects(readFile(join(exchange.childDataDirectory(identity.id), "models.json"), "utf8"), error => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wish child parser fails closed when any host-owned identity is missing", () => {
  assert.throws(
    () => parseWishCliArguments(["child", "--cwd", "/workspace", "--data-dir", "/data", "--exchange-data-dir", "/data"]),
    /--child-id is required/u,
  );
  assert.throws(
    () => parseWishCliArguments(["--child-id", "child-1"]),
    /require wish child/u,
  );
});

test("structured Subagent results reject non-string text", () => {
  assert.throws(
    () => snapshotResult({
      schemaVersion: 1,
      id: "child-1",
      childSessionId: "child-session-1",
      childRunId: "child-run-1",
      status: "completed",
      text: { hidden: true },
      completedAt: "2026-09-12T12:00:00.000Z",
    }),
    /result text must be a string/u,
  );
});
