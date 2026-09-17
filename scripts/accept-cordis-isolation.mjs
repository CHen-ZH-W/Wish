import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bootstrap } from "../dist/boot/bootstrap.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2 });
const businessServices = Object.freeze([
  "sessionPersistence",
  "sessions",
  "storage",
  "storageBackend",
  "runtimeLifecycle",
  "modelCatalogPersistence",
  "toolResultArchive",
  "toolOutputArtifacts",
  "workspace",
  "filesystem",
  "filesystemSearch",
  "shell",
  "approval",
  "approvalRules",
  "sandboxPolicy",
  "permissions",
  "models",
  "contextEngine",
  "compaction",
  "tools",
  "agentLoop",
  "runEngine",
  "agents",
  "application",
]);

const probeModule = `
export const inject = [
  "launch",
  "sessionPersistence",
  "sessions",
  "storage",
  "storageBackend",
  "runtimeLifecycle",
  "modelCatalogPersistence",
  "toolResultArchive",
  "toolOutputArtifacts",
  "workspace",
  "filesystem",
  "filesystemSearch",
  "shell",
  "approval",
  "approvalRules",
  "sandboxPolicy",
  "permissions",
  "models",
  "contextEngine",
  "compaction",
  "tools",
  "agentLoop",
  "runEngine",
  "agents",
  "application",
];

export function apply(ctx, config) {
  globalThis.__wishCordisG7Snapshots.set(config.realm, Object.freeze({
    sessionPersistence: ctx.sessionPersistence,
    sessions: ctx.sessions.manager,
    storage: ctx.storage,
    storageBinding: ctx.storageBackend,
    storageBackend: ctx.storage.backend("file"),
    runtimeLifecycle: ctx.runtimeLifecycle,
    modelCatalogPersistence: ctx.modelCatalogPersistence,
    toolResultArchive: ctx.toolResultArchive,
    toolOutputArtifacts: ctx.toolOutputArtifacts,
    workspace: ctx.workspace,
    filesystem: ctx.filesystem,
    filesystemSearch: ctx.filesystemSearch,
    shell: ctx.shell,
    approval: ctx.approval,
    approvalRules: ctx.approvalRules,
    sandboxPolicy: ctx.sandboxPolicy,
    permissions: ctx.permissions,
    models: ctx.models.registry,
    tools: ctx.tools.registry,
    agentDefinition: ctx.agents.definition,
    agentId: ctx.agents.agentId,
    maxParallelCalls: ctx.agentLoop.maxParallelCalls,
    maxSteps: ctx.runEngine.maxSteps,
    contextReserved: ctx.contextEngine.reservedOutputTokens,
    compactionRecent: ctx.compaction.keepRecentTokens,
    applicationName: ctx.application.name,
  }));
  globalThis.__wishCordisG7Events.push("apply:" + config.realm);
  if (config.selected) ctx.launch.complete(0);
  return () => {
    globalThis.__wishCordisG7Events.push("dispose:" + config.realm);
  };
}
`;

test("the built-in application graph is private to the selected surface realm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-g7-default-"));
  let booted;
  try {
    booted = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: repositoryRoot,
      homeDirectory: directory,
      environment: {},
    });
    assert.equal(await booted.completion, 0);
    assert.equal(booted.context.root, booted.context);
    assert.equal(booted.surfaceContext.root, booted.context);
    assert.notEqual(booted.surfaceContext, booted.context);
    assert.equal(
      booted.surfaceContext,
      booted.context.loader.resolve("include:cli").ctx,
    );
    assert.notEqual(booted.context.get("launch"), undefined);
    assert.notEqual(booted.context.get("loader"), undefined);
    for (const service of businessServices) {
      assert.equal(
        booted.context.get(service),
        undefined,
        `${service} must not leak into the process Root realm`,
      );
      assert.notEqual(
        booted.surfaceContext.get(service),
        undefined,
        `${service} must resolve from the selected surface realm`,
      );
    }
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two application realms isolate providers, registrations, updates, and disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-g7-realms-"));
  const configurationFile = join(directory, "cordis.yml");
  globalThis.__wishCordisG7Snapshots = new Map();
  globalThis.__wishCordisG7Events = [];
  let booted;

  try {
    await writeFile(join(directory, "probe.mjs"), probeModule);
    await writeFile(
      configurationFile,
      `${applicationGroup({
        id: "left",
        selected: true,
        dataDirectory: join(directory, "left-state"),
        adapter: "model-openai-chat-completions",
        adapterName: "cordis:model-openai-chat-completions",
        tool: "read",
        toolName: "cordis:read",
        agentId: "left-agent",
        maxParallelCalls: 2,
        maxSteps: 3,
      })}\n${applicationGroup({
        id: "right",
        selected: false,
        dataDirectory: join(directory, "right-state"),
        adapter: "model-anthropic-messages",
        adapterName: "cordis:model-anthropic-messages",
        tool: "bash",
        toolName: "cordis:bash",
        agentId: "right-agent",
        maxParallelCalls: 5,
        maxSteps: 7,
      })}`,
    );

    booted = await bootstrap({
      surface: "cli",
      cwd: directory,
      homeDirectory: directory,
      environment: {},
      configurationFile,
    });
    assert.equal(await booted.completion, 0);

    const root = booted.context;
    const leftContext = booted.surfaceContext;
    const rightProbe = root.loader.resolve("include:right-probe");
    const rightContext = rightProbe.ctx;
    assert.equal(rightProbe.fiber.state, fiberState.active);

    for (const service of businessServices) {
      assert.equal(root.get(service), undefined);
      assert.notEqual(leftContext.get(service), undefined);
      assert.notEqual(rightContext.get(service), undefined);
    }

    const firstLeft = globalThis.__wishCordisG7Snapshots.get("left");
    const firstRight = globalThis.__wishCordisG7Snapshots.get("right");
    assert.notEqual(firstLeft.sessionPersistence, firstRight.sessionPersistence);
    assert.notEqual(firstLeft.sessions, firstRight.sessions);
    assert.notEqual(firstLeft.storage, firstRight.storage);
    assert.notEqual(firstLeft.storageBinding, firstRight.storageBinding);
    assert.notEqual(firstLeft.storageBackend, firstRight.storageBackend);
    assert.notEqual(firstLeft.runtimeLifecycle, firstRight.runtimeLifecycle);
    assert.notEqual(
      firstLeft.modelCatalogPersistence,
      firstRight.modelCatalogPersistence,
    );
    assert.notEqual(firstLeft.toolResultArchive, firstRight.toolResultArchive);
    assert.notEqual(firstLeft.workspace, firstRight.workspace);
    assert.notEqual(firstLeft.filesystem, firstRight.filesystem);
    assert.notEqual(firstLeft.approval, firstRight.approval);
    assert.notEqual(firstLeft.approvalRules, firstRight.approvalRules);
    assert.notEqual(firstLeft.sandboxPolicy, firstRight.sandboxPolicy);
    assert.notEqual(firstLeft.permissions, firstRight.permissions);
    assert.notEqual(firstLeft.models, firstRight.models);
    assert.notEqual(firstLeft.tools, firstRight.tools);
    assert.notEqual(firstLeft.agentDefinition, firstRight.agentDefinition);
    assert.deepEqual(firstLeft.models.protocols(), ["openai-chat-completions"]);
    assert.deepEqual(firstRight.models.protocols(), ["anthropic-messages"]);
    assert.deepEqual(toolNames(firstLeft.tools), ["read"]);
    assert.deepEqual(toolNames(firstRight.tools), ["bash"]);
    assert.equal(firstLeft.agentId, "left-agent");
    assert.equal(firstRight.agentId, "right-agent");
    assert.equal(firstLeft.maxParallelCalls, 2);
    assert.equal(firstRight.maxParallelCalls, 5);
    assert.equal(firstLeft.maxSteps, 3);
    assert.equal(firstRight.maxSteps, 7);

    const leftProbe = root.loader.resolve("include:cli");
    const leftTools = root.loader.resolve("include:left-tools");
    await root.loader.update(leftTools.id, { disabled: true });
    assert.equal(leftTools.disabled, true);
    assert.equal(leftContext.get("tools"), undefined);
    assert.equal(leftProbe.fiber.state, fiberState.pending);
    assert.equal(rightProbe.fiber.state, fiberState.active);
    assert.deepEqual(toolNames(firstLeft.tools), []);
    assert.deepEqual(toolNames(firstRight.tools), ["bash"]);
    assert.equal(rightContext.get("agents").agentId, "right-agent");

    await root.loader.update(leftTools.id, { disabled: false });
    await leftProbe.fiber.await();
    const restoredLeft = globalThis.__wishCordisG7Snapshots.get("left");
    assert.equal(leftProbe.fiber.state, fiberState.active);
    assert.notEqual(restoredLeft.tools, firstLeft.tools);
    assert.deepEqual(toolNames(restoredLeft.tools), ["read"]);
    assert.equal(restoredLeft.agentId, "left-agent");
    assert.equal(globalThis.__wishCordisG7Snapshots.get("right"), firstRight);

    await root.loader.update("include:left-agents", {
      config: { agentId: "left-agent-v2" },
    });
    await leftProbe.fiber.await();
    const updatedLeft = globalThis.__wishCordisG7Snapshots.get("left");
    assert.equal(updatedLeft.agentId, "left-agent-v2");
    assert.equal(updatedLeft.tools, restoredLeft.tools);
    assert.equal(globalThis.__wishCordisG7Snapshots.get("right"), firstRight);
  } finally {
    await booted?.dispose();
    delete globalThis.__wishCordisG7Snapshots;
    delete globalThis.__wishCordisG7Events;
    await rm(directory, { recursive: true, force: true });
  }
});

function applicationGroup(options) {
  const probeId = options.selected ? "cli" : `${options.id}-probe`;
  return `- id: ${options.id}
  name: 'cordis:group'
  group: true
  isolate:
${businessServices.map((service) => `    ${service}: true`).join("\n")}
  config:
    - id: ${options.id}-storage
      name: 'cordis:storage'
    - id: ${options.id}-storage-file
      name: 'cordis:storage-file'
      config:
        id: file
        rootDirectory: ${JSON.stringify(join(options.dataDirectory, "storage"))}
    - id: ${options.id}-runtime-lifecycle
      name: 'cordis:runtime-lifecycle-journal'
      config:
        backendId: file
    - id: ${options.id}-tool-result-archive
      name: 'cordis:tool-result-archive-blob'
      config:
        backendId: file
    - id: ${options.id}-tool-output-artifacts
      name: 'cordis:tool-output-artifacts-blob'
      config:
        backendId: file
    - id: ${options.id}-model-catalog-storage
      name: 'cordis:model-catalog-storage'
      config:
        backendId: file
    - id: ${options.id}-session-persistence
      name: 'cordis:session-file'
    - id: ${options.id}-sessions
      name: 'cordis:sessions'
      config:
        dataDirectory: ${JSON.stringify(options.dataDirectory)}
    - id: ${options.id}-workspace
      name: 'cordis:workspace-local'
    - id: ${options.id}-approval
      name: 'cordis:approval-hub'
    - id: ${options.id}-approval-rules
      name: 'cordis:approval-rules-storage'
      config:
        backendId: file
    - id: ${options.id}-filesystem
      name: 'cordis:filesystem-local'
    - id: ${options.id}-filesystem-search
      name: 'cordis:filesystem-search-local'
    - id: ${options.id}-shell
      name: 'cordis:shell-linux-native'
    - id: ${options.id}-sandbox-policy
      name: 'cordis:sandbox-policy-default'
    - id: ${options.id}-permissions
      name: 'cordis:permissions-default'
    - id: ${options.id}-models
      name: 'cordis:models'
    - id: ${options.id}-${options.adapter}
      name: '${options.adapterName}'
    - id: ${options.id}-context
      name: 'cordis:context-engine'
      config:
        reservedOutputTokens: ${options.maxSteps * 100}
    - id: ${options.id}-compaction
      name: 'cordis:compaction'
      config:
        keepRecentTokens: ${options.maxSteps * 200}
        summaryMaxOutputTokens: ${options.maxSteps * 50}
    - id: ${options.id}-tools
      name: 'cordis:tools'
    - id: ${options.id}-tool-${options.tool}
      name: '${options.toolName}'
    - id: ${options.id}-agent-loop
      name: 'cordis:agent-loop'
      config:
        maxParallelCalls: ${options.maxParallelCalls}
    - id: ${options.id}-runtime
      name: 'cordis:runtime'
      config:
        maxSteps: ${options.maxSteps}
    - id: ${options.id}-agents
      name: 'cordis:agents'
      config:
        agentId: ${JSON.stringify(options.agentId)}
    - id: ${options.id}-application
      name: 'cordis:application'
    - id: ${probeId}
      name: './probe.mjs'
      config:
        realm: ${options.id}
        selected: ${String(options.selected)}
`;
}

function toolNames(registry) {
  return registry.list().map((tool) => tool.name);
}
