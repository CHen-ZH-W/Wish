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
} from "../dist/composition/agent-service.js";
import AgentLoop from "../dist/composition/agent-loop-service.js";
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
import StorageModelAttemptLedger, {
  Config as ModelAttemptLedgerConfig,
} from
  "../dist/models/pricing/providers/storage.js";
import Runtime, {
  Config as RuntimeConfig,
} from "../dist/composition/runtime-service.js";
import Sessions, {
  Config as SessionsConfig,
} from "../dist/sessions/service.js";
import { StorageHub } from "../dist/storage/index.js";
import FileStorage from "../dist/storage/providers/file/plugin.js";
import JournalRuntimeLifecycleProvider, {
  Config as RuntimeLifecycleConfig,
} from "../dist/core/runtime/durability/providers/journal.js";
import FileSessionPersistence from
  "../dist/sessions/providers/file/plugin.js";
import BlobToolResultArchiveProvider from
  "../dist/tools/results/providers/blob.js";
import Tools from "../dist/tools/service.js";
import LocalWorkspace, {
  Config as WorkspaceConfig,
} from "../dist/workspace/providers/local.js";
import ApprovalHub from "../dist/approval/service.js";
import StorageApprovalRules from
  "../dist/permissions/rules/providers/storage.js";
import DefaultPermissions, {
  Config as PermissionsConfig,
} from "../dist/permissions/providers/default.js";
import LocalFilesystem, {
  Config as FilesystemConfig,
} from "../dist/filesystem/providers/local.js";
import LinuxNativeShell, {
  Config as ShellConfig,
} from "../dist/shell/providers/linux-native.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";
import { Config as TmuxConfig } from "../dist/tmux/providers/local.js";
import { Config as SubagentsConfig } from "../dist/subagents/runtime.js";
import { Config as PlanConfig } from "../dist/plan/providers/storage.js";
import { Config as CoordinatorConfig } from
  "../dist/coordinator/providers/storage.js";
import { Config as SubagentLauncherConfig } from
  "../dist/apps/cli/subagent-launcher.js";
import {
  cleanEnvironment,
  delay,
  waitFor,
  withTimeout,
} from "./support/process-fixtures.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("capability, Application and WebUI plugins validate only their own settings", () => {
  assert.deepEqual(ApplicationConfig({}), {});
  assert.deepEqual(AgentsConfig({ agentId: "wish" }), { agentId: "wish" });
  assert.deepEqual(PermissionsConfig({ defaultProfile: "read-only" }), {
    defaultProfile: "read-only",
  });
  assert.deepEqual(FilesystemConfig({ maxFileBytes: 1024 }), {
    maxFileBytes: 1024,
    protectedDirectoryNames: [".git", ".wish"],
    protectedFileNames: [".env", ".gitconfig", ".netrc", ".npmrc"],
    protectedFilePrefixes: [".env."],
    protectedNameExceptions: [".env.example"],
  });
  assert.throws(
    () => FilesystemConfig({ maxFileBytes: 0 }),
    /expected number >= 1/u,
  );
  assert.deepEqual(ShellConfig({ maxProcesses: 32 }), { maxProcesses: 32 });
  assert.throws(
    () => ShellConfig({ maxProcesses: 0 }),
    /expected number >= 1/u,
  );
  assert.throws(
    () => PermissionsConfig({ defaultProfile: "unrestricted" }),
    /expected "read-only"/u,
  );
  assert.deepEqual(TmuxConfig({
    socketPath: "/tmp/wish.sock",
    sessionPrefix: "wish-agent",
    captureLines: 200,
  }), {
    socketPath: "/tmp/wish.sock",
    sessionPrefix: "wish-agent",
    captureLines: 200,
  });
  assert.deepEqual(SubagentsConfig({
    backendId: "file",
    maxRecords: 100,
    maxConcurrent: 4,
    maxConcurrentPerRun: 2,
  }), {
    backendId: "file",
    maxRecords: 100,
    maxConcurrent: 4,
    maxConcurrentPerRun: 2,
  });
  assert.deepEqual(PlanConfig({ backendId: "file" }), { backendId: "file" });
  assert.deepEqual(CoordinatorConfig({ backendId: "file" }), { backendId: "file" });
  assert.throws(() => TmuxConfig({ captureLines: 0 }), /expected number >= 1/u);
  assert.throws(() => SubagentsConfig({ maxConcurrent: 0 }), /expected number >= 1/u);
  assert.deepEqual(SubagentLauncherConfig({ childExecutable: "/opt/node" }), {
    childExecutable: "/opt/node",
  });
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
  assert.deepEqual(FileStorage.Config({
    id: "file",
    journalTornTailRecovery: "truncate",
  }), {
    id: "file",
    journalTornTailRecovery: "truncate",
  });
  assert.deepEqual(RuntimeLifecycleConfig({ backendId: "file" }), {
    backendId: "file",
  });
  assert.deepEqual(ModelAttemptLedgerConfig({
    backendId: "file",
    currency: "CNY",
  }), {
    backendId: "file",
    currency: "CNY",
  });
  assert.deepEqual(WorkspaceConfig({
    instructionFiles: ["AGENTS.md"],
    repositoryMarkers: [".git"],
    maxInstructionBytes: 128,
    maxInstructionFileBytes: 64,
  }), {
    instructionFiles: ["AGENTS.md"],
    repositoryMarkers: [".git"],
    maxInstructionBytes: 128,
    maxInstructionFileBytes: 64,
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
  assert.throws(
    () => FileStorage.Config({ journalTornTailRecovery: "guess" }),
    /expected/u,
  );
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
    await root.plugin(StorageHub);
    await root.plugin(FileStorage, {
      id: "file",
      rootDirectory: "./storage",
    });
    await root.plugin(JournalRuntimeLifecycleProvider, { backendId: "file" });
    await root.plugin(StorageModelAttemptLedger, { backendId: "file" });
    await root.plugin(BlobToolResultArchiveProvider, { backendId: "file" });
    await root.plugin(FileSessionPersistence);
    await root.plugin(Sessions, { dataDirectory: "./session-state" });
    await root.plugin(LocalWorkspace);
    await root.plugin(ApprovalHub);
    await root.plugin(StorageApprovalRules, { backendId: "file" });
    await root.plugin(LocalFilesystem);
    await root.plugin(LinuxNativeShell);
    await root.plugin(DefaultSandboxPolicy);
    await root.plugin(DefaultPermissions);
    await root.plugin(Models);
    await root.plugin(ContextEngine);
    await root.plugin(Compaction);
    await root.plugin(AgentLoop);
    await root.plugin(Runtime);
    const provider = await root.plugin(Agents, {
      agentId: "first-agent",
      permissionProfile: "read-only",
      availableTools: ["read", "grep"],
      allowedCapabilities: ["filesystem.read"],
    });
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
    assert.deepEqual(root.agents.permissions, {
      profile: "read-only",
      availableTools: ["read", "grep"],
      allowedCapabilities: ["filesystem.read"],
    });
    assert.equal(configurations[0].modelEnvironment, environment);

    await provider.update({
      agentId: "second-agent",
      permissionProfile: "approval-required",
    });
    await consumerFiber.await();
    assert.equal(disposals, 1);
    assert.equal(configurations.length, 2);
    assert.equal(
      configurations[1].dataDirectory,
      join(directory, "session-state"),
    );
    assert.equal(configurations[1].agentId, "second-agent");
    assert.deepEqual(root.agents.permissions, {
      profile: "approval-required",
    });
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
    WISH_STORAGE_FILE_ROOT: join(directory, "configured-storage"),
    WISH_MODEL: "deepseek/deepseek-v4-pro",
    WISH_FALLBACK_MODELS: "openai/gpt-5.2, anthropic/claude-opus-4-6",
    WISH_MODEL_MAX_RETRIES: "3",
    WISH_MODEL_PRICING_CURRENCY: "CNY",
    WISH_AGENT_ID: "configured-agent",
    WISH_AGENT_INSTRUCTIONS: "Follow the configured instructions.",
    WISH_PERMISSION_PROFILE: "read-only",
    WISH_PERMISSION_POLICY_VERSION: "configured-policy-v1",
    WISH_AVAILABLE_TOOLS: "read, grep",
    WISH_ALLOWED_CAPABILITIES: "filesystem.read, runtime.read",
    WISH_WORKSPACE_INSTRUCTION_FILES: "package.json",
    WISH_WORKSPACE_REPOSITORY_MARKERS: ".git",
    WISH_WORKSPACE_MAX_INSTRUCTION_BYTES: "131072",
    WISH_WORKSPACE_MAX_INSTRUCTION_FILE_BYTES: "65536",
    WISH_FILESYSTEM_MAX_FILE_BYTES: "1048576",
    WISH_FILESYSTEM_PROTECTED_DIRECTORIES: ".git,.private",
    WISH_FILESYSTEM_PROTECTED_FILES: ".env,secrets.json",
    WISH_FILESYSTEM_PROTECTED_PREFIXES: ".env.,secret-",
    WISH_FILESYSTEM_PROTECTED_EXCEPTIONS: ".env.example",
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
    assert.equal(
      application.surfaceContext.get("storage").backend("file").rootDirectory,
      join(directory, "configured-storage"),
    );
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
    assert.equal(
      application.surfaceContext.get("modelAttemptLedger").currency,
      "CNY",
    );
    assert.equal(configuration.agentId, "configured-agent");
    assert.equal(
      configuration.agentInstructions[0].content,
      "Follow the configured instructions.",
    );
    assert.deepEqual(application.surfaceContext.get("agents").permissions, {
      profile: "read-only",
      availableTools: ["read", "grep"],
      allowedCapabilities: ["filesystem.read", "runtime.read"],
    });
    assert.equal(
      application.surfaceContext.get("permissions").policyVersion,
      "configured-policy-v1",
    );
    assert.equal(
      application.surfaceContext.get("filesystem").policy.maxFileBytes,
      1_048_576,
    );
    assert.deepEqual(
      application.surfaceContext.get("filesystem").policy.protectedDirectoryNames,
      [".git", ".private"],
    );
    assert.deepEqual(
      application.surfaceContext.get("filesystem").policy.protectedFileNames,
      [".env", "secrets.json"],
    );
    assert.equal(configuration.reservedOutputTokens, 1_024);
    assert.equal(configuration.keepRecentTokens, 2_048);
    assert.equal(configuration.summaryMaxOutputTokens, 512);
    const workspace = await application.surfaceContext.get("workspace").resolve({
      root: repositoryRoot,
    });
    assert.equal(workspace.repository.root, repositoryRoot);
    assert.deepEqual(
      workspace.instructions.map((instruction) => instruction.source),
      [join(repositoryRoot, "package.json")],
    );
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

test("unmanaged API embedding preserves external Loader row precedence and stable-id reload", async () => {
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
  // HMR belongs to the generic unmanaged embedding contract, not the product WebUI.
  const entry = join(directory, "api-embedding.mjs");
  await writeFile(entry, `import { bootstrap } from ${JSON.stringify(new URL("../dist/boot/bootstrap.js", import.meta.url).href)};
const booted = await bootstrap({ surface: "webui" });
try { process.exitCode = await booted.completion; } finally { await booted.dispose(); }
`);
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry],
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

    const listeningLine = `Wish WebUI API listening at http://127.0.0.1:${firstPort}`;
    const startsBeforeInvalid = occurrenceCount(stderr, listeningLine);
    await replaceProfile(profile, webProfile({
      port: firstPort,
      dataDirectory: "./profile-state",
      maxSteps: 0,
    }));
    await waitFor(
      () => stderr.includes("Cordis config reload failed at"),
      () => `invalid shared configuration was not reported:\n${stderr}`,
    );
    await waitFor(
      () => occurrenceCount(stderr, listeningLine) > startsBeforeInvalid,
      () => `last-known-good WebUI generation did not reactivate:\n${stderr}`,
    );
    await waitForHealthy(
      firstPort,
      () => `last-known-good WebUI configuration was not restored:\n${stderr}`,
    );
    // Group rollback reactivates the surface before the watcher has necessarily
    // finished its transaction. Keep the next edit in a distinct HMR generation.
    await delay(500);

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
    - id: storage
      name: 'cordis:storage'
    - id: storage-file
      name: 'cordis:storage-file'
      config:
        id: file
        rootDirectory: ${JSON.stringify(join(dataDirectory, "storage"))}
    - id: runtime-lifecycle-journal
      name: 'cordis:runtime-lifecycle-journal'
      config:
        backendId: file
    - id: model-attempt-ledger-storage
      name: 'cordis:model-attempt-ledger-storage'
      config:
        backendId: file
        currency: USD
    - id: tool-result-archive
      name: 'cordis:tool-result-archive-blob'
      config:
        backendId: file
    - id: tool-output-artifacts
      name: 'cordis:tool-output-artifacts-blob'
      config:
        backendId: file
    - id: session-persistence
      name: 'cordis:session-file'
    - id: sessions
      name: 'cordis:sessions'
      config:
        dataDirectory: ${JSON.stringify(dataDirectory)}

    - id: workspace-local
      name: 'cordis:workspace-local'

    - id: approval-hub
      name: 'cordis:approval-hub'
    - id: approval-rules-storage
      name: 'cordis:approval-rules-storage'
      config:
        backendId: file
    - id: filesystem-local
      name: 'cordis:filesystem-local'
    - id: filesystem-search-local
      name: 'cordis:filesystem-search-local'
    - id: shell-linux-native
      name: 'cordis:shell-linux-native'
    - id: sandbox-policy-default
      name: 'cordis:sandbox-policy-default'
    - id: permissions-default
      name: 'cordis:permissions-default'

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
    - id: system-prompt
      name: 'cordis:system-prompt'
    - id: system-prompt-context
      name: 'cordis:system-prompt-context'
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

function occurrenceCount(value, expected) {
  return value.split(expected).length - 1;
}
