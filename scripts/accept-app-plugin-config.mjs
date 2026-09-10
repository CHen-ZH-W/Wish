import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import Application, {
  Config as ApplicationConfig,
} from "../dist/apps/service.js";
import Agents, {
  Config as AgentsConfig,
} from "../dist/core/agent/service.js";
import AgentLoop from "../dist/core/agent-loop/service.js";
import { Config as WebUiConfig } from "../dist/apps/webui/plugin.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import Compaction, {
  Config as CompactionConfig,
} from "../dist/compaction/service.js";
import ContextEngine, {
  Config as ContextEngineConfig,
} from "../dist/context/service.js";
import * as ModelPlugins from "../dist/models/plugins.js";
import Models, {
  Config as ModelsConfig,
} from "../dist/models/service.js";
import Runtime, {
  Config as RuntimeConfig,
} from "../dist/core/runtime/service.js";
import Sessions, {
  Config as SessionsConfig,
} from "../dist/sessions/service.js";
import Tools from "../dist/tools/service.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("capability, Application and WebUI plugins validate only their own settings", () => {
  assert.deepEqual(ApplicationConfig({}), {});
  assert.deepEqual(AgentsConfig({ agentId: "wish" }), { agentId: "wish" });
  assert.deepEqual(ModelsConfig({
    configurationPath: "models.json",
    fallbackModels: ["fixture/secondary"],
    maxRetries: 2,
  }), {
    configurationPath: "models.json",
    fallbackModels: ["fixture/secondary"],
    maxRetries: 2,
  });
  assert.deepEqual(RuntimeConfig({
    maxSteps: 4,
    generationDrainTimeoutMs: 2_000,
  }), {
    maxSteps: 4,
    generationDrainTimeoutMs: 2_000,
  });
  assert.deepEqual(ContextEngineConfig({ reservedOutputTokens: 1_024 }), {
    reservedOutputTokens: 1_024,
  });
  assert.deepEqual(CompactionConfig({
    keepRecentTokens: 2_048,
    summaryMaxOutputTokens: 512,
  }), {
    keepRecentTokens: 2_048,
    summaryMaxOutputTokens: 512,
  });
  assert.deepEqual(SessionsConfig({ dataDirectory: "state" }), {
    dataDirectory: "state",
  });
  assert.deepEqual(WebUiConfig({
    host: "127.0.0.1",
    port: 8790,
    workspaceRoot: "workspace",
  }), {
    host: "127.0.0.1",
    port: 8790,
    workspaceRoot: "workspace",
  });
  assert.throws(() => WebUiConfig({ port: 0 }), /expected number >= 1/u);
  assert.throws(() => WebUiConfig({ port: 65_536 }), /expected number <= 65535/u);
  assert.throws(() => SessionsConfig({ dataDirectory: 42 }), /expected string/u);
  assert.throws(() => RuntimeConfig({ maxSteps: 0 }), /expected number >= 1/u);
  assert.throws(
    () => RuntimeConfig({ generationDrainTimeoutMs: 0 }),
    /expected number >= 1/u,
  );
  assert.throws(() => AgentsConfig({ agentId: 42 }), /expected string/u);
  assert.throws(
    () => ContextEngineConfig({ reservedOutputTokens: -1 }),
    /expected number >= 0/u,
  );
  assert.throws(
    () => CompactionConfig({ keepRecentTokens: 0 }),
    /expected number >= 1/u,
  );
});

test("stable Agent config updates replace the downstream Application generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "application-config-update-"));
  const root = new Context();
  const environment = {
    DEEPSEEK_API_KEY: "runtime-only",
    WISH_DATA_DIR: join(directory, "ignored-environment-state"),
  };
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment,
  });
  const configurations = [];
  let disposals = 0;
  const consumer = Object.assign(
    async (ctx) => {
      configurations.push(await ctx.application.resolve());
      return () => {
        disposals += 1;
      };
    },
    { inject: ["application"] },
  );

  try {
    await root.plugin(Tools);
    await root.plugin(Sessions, { dataDirectory: "./session-state" });
    await root.plugin(Models);
    await root.plugin(ContextEngine);
    await root.plugin(Compaction);
    await root.plugin(AgentLoop);
    await root.plugin(Runtime);
    const provider = await root.plugin(Agents, { agentId: "first-agent" });
    await root.plugin(ModelPlugins.OpenAIChatCompletions);
    await root.plugin(ModelPlugins.OpenAIResponses);
    await root.plugin(ModelPlugins.AnthropicMessages);
    await root.plugin(Application);
    const consumerFiber = await root.plugin(consumer);
    assert.equal(configurations.length, 1);
    assert.equal(
      configurations[0].dataDirectory,
      join(directory, "session-state"),
    );
    assert.equal(configurations[0].agentId, "first-agent");
    assert.equal(configurations[0].modelEnvironment, environment);

    await provider.update({ agentId: "second-agent" });
    await consumerFiber.await();
    assert.equal(disposals, 1);
    assert.equal(configurations.length, 2);
    assert.equal(
      configurations[1].dataDirectory,
      join(directory, "session-state"),
    );
    assert.equal(configurations[1].agentId, "second-agent");
    await assert.rejects(access(join(directory, "ignored-environment-state")));
  } finally {
    await root.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(disposals, 2);
});

test("the built-in profile translates compatibility environment at Loader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "built-in-config-root-"));
  const environment = {
    WISH_DATA_DIR: join(directory, "configured-state"),
    WISH_MODEL: "deepseek/deepseek-v4-pro",
    WISH_FALLBACK_MODELS: "openai/gpt-5.2, anthropic/claude-opus-4-6",
    WISH_MODEL_MAX_RETRIES: "3",
    WISH_AGENT_ID: "configured-agent",
    WISH_AGENT_INSTRUCTIONS: "Follow the configured instructions.",
    WISH_CONTEXT_RESERVED_OUTPUT_TOKENS: "1024",
    WISH_COMPACTION_KEEP_RECENT_TOKENS: "2048",
    WISH_COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS: "512",
    WISH_MAX_STEPS: "4",
    WISH_RUN_GENERATION_DRAIN_TIMEOUT_MS: "2000",
    DEEPSEEK_API_KEY: "runtime-only",
  };
  let application;
  try {
    application = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: repositoryRoot,
      homeDirectory: directory,
      environment,
    });
    const configuration = await application.surfaceContext
      .get("application")
      .resolve();
    assert.equal(configuration.dataDirectory, join(directory, "configured-state"));
    assert.deepEqual(configuration.models.defaultModel, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    assert.deepEqual(configuration.models.fallbackModels, [{
      provider: "openai",
      model: "gpt-5.2",
    }, {
      provider: "anthropic",
      model: "claude-opus-4-6",
    }]);
    assert.equal(configuration.models.maxRetries, 3);
    assert.equal(configuration.agentId, "configured-agent");
    assert.equal(
      configuration.agentInstructions[0].content,
      "Follow the configured instructions.",
    );
    assert.equal(configuration.reservedOutputTokens, 1_024);
    assert.equal(configuration.keepRecentTokens, 2_048);
    assert.equal(configuration.summaryMaxOutputTokens, 512);
    assert.equal(application.surfaceContext.get("runEngine").maxSteps, 4);
    assert.equal(
      application.surfaceContext.get("runEngine").generationDrainTimeoutMs,
      2_000,
    );
    assert.equal("maxSteps" in configuration, false);
    assert.equal(configuration.modelEnvironment, environment);
    assert.equal(await application.completion, 0);
  } finally {
    await application?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("external Loader rows override environment and reload by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-plugin-config-"));
  const workspace = join(directory, "workspace");
  const profile = join(directory, "cordis.yml");
  const [firstPort, secondPort, environmentPort] = await reservePorts(3);
  await mkdir(workspace);
  await writeFile(profile, webProfile({
    port: firstPort,
    dataDirectory: "./profile-state",
  }));

  const environment = cleanEnvironment();
  environment.CORDIS_CONFIG = profile;
  environment.WISH_DATA_DIR = join(directory, "environment-state");
  environment.WISH_WEBUI_HOST = "127.0.0.1";
  environment.WISH_WEBUI_PORT = String(environmentPort);
  environment.WISH_WEBUI_WORKSPACE_ROOT = join(directory, "missing-workspace");
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, "dist/apps/webui/main.js")],
    {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");

  try {
    await waitForHealthy(firstPort, () => `first configured port did not start:\n${stderr}`);
    await assertUnavailable(environmentPort);

    const created = await requestJson(firstPort, "/api/sessions", {
      method: "POST",
      body: { sessionId: "plugin-config-session" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.session.scope, workspace);
    assert.equal((await readdir(join(directory, "profile-state", "sessions"))).length, 1);
    await assert.rejects(access(join(directory, "environment-state")));
    await delay(150);

    await replaceProfile(profile, webProfile({
      port: firstPort,
      dataDirectory: "./profile-state",
      maxSteps: 0,
    }));
    await waitFor(
      () => stderr.includes("Cordis config reload failed at"),
      () => `invalid shared configuration was not reported:\n${stderr}`,
    );
    await waitForHealthy(
      firstPort,
      () => `last-known-good WebUI configuration was not restored:\n${stderr}`,
    );
    await delay(150);

    await replaceProfile(profile, webProfile({
      port: secondPort,
      dataDirectory: "./profile-state",
      maxSteps: 8,
    }));
    await waitForHealthy(secondPort, () => `updated configured port did not start:\n${stderr}`);
    await waitForUnavailable(
      firstPort,
      () => `previous configured port did not close:\n${stderr}`,
    );
    const listed = await requestJson(secondPort, "/api/sessions");
    assert.equal(listed.response.status, 200);
    assert.deepEqual(
      listed.value.sessions.map((session) => session.sessionId),
      ["plugin-config-session"],
    );

    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = await withTimeout(
      exited,
      10_000,
      "configured WebUI did not stop after SIGTERM",
    );
    assert.equal(code, 143);
    assert.equal(signal, null);
    assert.equal(stdout, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

function webProfile({ port, dataDirectory, maxSteps = 32 }) {
  return `- id: timer
  name: 'cordis:timer'

- id: hmr
  name: 'cordis:hmr'
  config:
    base: '.'
    root: ['.']
    ignored: ['**/.*', '**/*.tmp', 'profile-state/**', 'environment-state/**']
    debounce: 25

- id: app
  name: 'cordis:group'
  group: true
  config:
    - id: sessions
      name: 'cordis:sessions'
      config:
        dataDirectory: ${JSON.stringify(dataDirectory)}

    - id: models
      name: 'cordis:models'
    - id: model-openai-chat-completions
      name: 'cordis:model-openai-chat-completions'
    - id: model-openai-responses
      name: 'cordis:model-openai-responses'
    - id: model-anthropic-messages
      name: 'cordis:model-anthropic-messages'

    - id: context-engine
      name: 'cordis:context-engine'
    - id: compaction
      name: 'cordis:compaction'

    - id: tools
      name: 'cordis:tools'
    - id: tool-read
      name: 'cordis:read'
    - id: tool-write
      name: 'cordis:write'
    - id: tool-edit
      name: 'cordis:edit'
    - id: tool-grep
      name: 'cordis:grep'
    - id: tool-bash
      name: 'cordis:bash'

    - id: agent-loop
      name: 'cordis:agent-loop'

    - id: runtime
      name: 'cordis:runtime'
      config:
        maxSteps: ${maxSteps}

    - id: agents
      name: 'cordis:agents'

    - id: application
      name: 'cordis:application'

    - id: webui
      name: 'cordis:webui'
      config:
        host: '127.0.0.1'
        port: ${port}
        workspaceRoot: './workspace'
`;
}

async function replaceProfile(path, content) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function requestJson(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    ...(options.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body),
        }),
  });
  return { response, value: await response.json() };
}

async function waitForHealthy(port, message) {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, message);
}

async function assertUnavailable(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
}

async function waitForUnavailable(port, message) {
  await waitFor(async () => {
    try {
      await assertUnavailable(port);
      return true;
    } catch {
      return false;
    }
  }, message);
}

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("WISH_") || name.startsWith("CORDIS_")) {
      delete environment[name];
    }
  }
  return environment;
}

async function reservePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    return servers.map((server) => {
      const address = server.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(async (server) => {
      server.close();
      await once(server, "close");
    }));
  }
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(await message());
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
