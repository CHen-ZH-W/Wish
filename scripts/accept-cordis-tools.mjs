import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import { bootstrap } from "../dist/boot/bootstrap.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import LocalFilesystemSearch from
  "../dist/filesystem/search/providers/local.js";
import HostShell from "../dist/shell/providers/host.js";
import * as FilesystemToolPlugins from
  "../dist/filesystem/consumers/model-tools/plugin.js";
import { Grep as GrepTool } from
  "../dist/filesystem/search/consumers/plugin.js";
import { Bash as BashTool } from "../dist/shell/consumers/plugin.js";
import { ToolOutputArtifactsService } from
  "../dist/tools/results/artifacts/service.js";
import Tools from "../dist/tools/service.js";

const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });
const basicNames = ["read", "write", "edit", "grep", "bash"];
const subagentNames = [
  "spawn_agent",
  "list_agents",
  "capture_agent",
  "send_agent",
  "stop_agent",
  "collect_agent",
];
const planNames = [
  "enter_plan_mode",
  "read_plan",
  "update_plan",
  "exit_plan_mode",
];
const coordinatorNames = [
  "enter_coordinator_mode",
  "read_coordinator",
  "exit_coordinator_mode",
];
const taskNames = ["tasks_read", "tasks_update"];
const workflowNames = ["workflow_read", "workflow_start", "workflow_cancel", "workflow_retry"];
const skillNames = ["list_skills", "read_skill"];
const memoryNames = ["memory_search", "memory_read", "memory_write"];
const productNames = [
  ...basicNames,
  ...planNames,
  ...subagentNames,
  ...coordinatorNames,
  ...taskNames,
  ...workflowNames,
  ...skillNames,
  ...memoryNames,
];
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

class MemoryToolOutputArtifacts extends ToolOutputArtifactsService {
  async put() {
    return Object.freeze({ kind: "test", locator: "test:artifact" });
  }

  async get() {
    return undefined;
  }
}

test("Tool plugins follow the tools service and own their registrations", async () => {
  const root = new Context();
  let artifactProvider = await root.plugin(MemoryToolOutputArtifacts);
  const read = root.plugin(FilesystemToolPlugins.Read);
  assert.equal(read.state, fiberState.pending);

  let toolsProvider;
  const fibers = [read];
  let registry;
  try {
    toolsProvider = await root.plugin(Tools);
    registry = root.tools.registry;
    await root.plugin(LocalFilesystem);
    await root.plugin(LocalFilesystemSearch);
    await root.plugin(HostShell);
    await read.await();
    for (const plugin of [
      FilesystemToolPlugins.Write,
      FilesystemToolPlugins.Edit,
      GrepTool,
      BashTool,
    ]) {
      fibers.push(await root.plugin(plugin));
    }

    assert.deepEqual(toolNames(registry), basicNames);
    assert.deepEqual(read.getEffects().map((effect) => effect.label), [
      'tools.register("read")',
      'Read Consumer admission',
    ]);

    const bash = fibers.at(-1);
    await bash.dispose();
    assert.deepEqual(toolNames(registry), basicNames.slice(0, -1));
    assert.deepEqual(bash.getEffects(), []);

    fibers[fibers.length - 1] = await root.plugin(BashTool);
    assert.deepEqual(toolNames(registry), basicNames);

    await artifactProvider.dispose();
    assert.equal(fibers.at(-1).state, fiberState.pending);
    assert.deepEqual(toolNames(registry), basicNames.slice(0, -1));
    artifactProvider = await root.plugin(MemoryToolOutputArtifacts);
    await fibers.at(-1).await();
    assert.deepEqual(toolNames(registry), basicNames);

    await toolsProvider.dispose();
    assert.equal(root.get("tools"), undefined);
    assert.deepEqual(toolNames(registry), []);
    for (const fiber of fibers) {
      assert.equal(fiber.state, fiberState.pending);
      assert.deepEqual(fiber.getEffects(), []);
    }
  } finally {
    await root.fiber.dispose();
  }

  for (const fiber of fibers) {
    assert.equal(fiber.state, fiberState.disposed);
  }
});

test("feature result renderers share the Tool plugin lifecycle", async () => {
  const root = new Context();
  await root.plugin(Tools);
  const fallbackCalls = [];
  const renderer = root.tools.createResultRenderer({
    render(input) {
      fallbackCalls.push(input.result.toolName);
      return {
        role: "tool",
        content: "fallback",
        toolCallId: input.result.callId,
      };
    },
  });
  const plugin = root.plugin({
    inject: ["tools"],
    apply(ctx) {
      ctx.tools.register({
        name: "custom",
        description: "custom",
        inputSchemaJson: '{"type":"object"}',
        executionMode: "parallel",
        recoveryPolicy: "retry-safe",
        parse: (input) => ({ ok: true, input }),
        resolveCapabilities: () => ({ requirements: [] }),
        execute: () => ({ value: 1 }),
      }, {
        render({ result }) {
          return {
            role: "tool",
            content: `custom:${result.ok}`,
            toolCallId: result.callId,
          };
        },
      });
    },
  });
  try {
    await plugin.await();
    const input = {
      call: { status: "ready", id: "call-custom", name: "custom", input: {} },
      result: {
        ok: true,
        callId: "call-custom",
        toolName: "custom",
        output: { value: 1 },
        phase: "completed",
      },
      snapshot: {},
      signal: new AbortController().signal,
    };
    assert.equal((await renderer.render(input)).content, "custom:true");
    assert.deepEqual(fallbackCalls, []);

    await plugin.dispose();
    assert.equal((await renderer.render(input)).content, "fallback");
    assert.deepEqual(fallbackCalls, ["custom"]);
  } finally {
    await root.fiber.dispose();
  }
});

test("the built-in Loader can disable and restore one Tool by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-loader-tools-"));
  const configurationFile = join(directory, "cordis.yml");
  await writeFile(
    configurationFile,
    await readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
  );
  let defaultBoot;
  let booted;
  try {
    defaultBoot = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: repositoryRoot,
      homeDirectory: directory,
      environment: { WISH_SUBAGENT_TOOLS_ENABLED: "0" },
      configurationFile,
    });
    assert.equal(await defaultBoot.completion, 0);
    assertBootTools(
      defaultBoot,
      [...basicNames, ...planNames, ...taskNames, ...workflowNames, ...skillNames, ...memoryNames],
      "Subagent model Tools must be independently disableable",
    );
    assert.notEqual(defaultBoot.surfaceContext.get("tmux"), undefined);
    assert.notEqual(defaultBoot.surfaceContext.get("subagents"), undefined);
    assert.notEqual(defaultBoot.surfaceContext.get("coordinator"), undefined);
    assert.notEqual(defaultBoot.surfaceContext.get("workflowScheduler"), undefined);
    assert.notEqual(defaultBoot.surfaceContext.get("skills"), undefined);
    assert.notEqual(defaultBoot.surfaceContext.get("memory"), undefined);
    await defaultBoot.dispose();
    defaultBoot = undefined;

    booted = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: repositoryRoot,
      homeDirectory: directory,
      environment: {},
      configurationFile,
    });
    assert.equal(await booted.completion, 0);
    assertBootTools(booted, productNames);

    const id = "include:tool-bash";
    const entry = booted.context.loader.resolve(id);
    await booted.context.loader.update(id, { disabled: true });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, true);
    assertBootTools(booted, productNames.filter((name) => name !== "bash"));

    await booted.context.loader.update(id, { disabled: false });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, false);
    assertBootTools(booted, productNames);

    // The default graph exposes the Workflow-aware adapter, never both aliases.
    const subagentsId = "include:tool-workflow-subagents";
    assert.equal(booted.context.loader.resolve("include:tool-subagents").disabled, true);
    assert.equal(booted.context.loader.resolve(subagentsId).disabled, false);
    await booted.context.loader.update(subagentsId, { disabled: true });
    assertBootTools(booted, productNames.filter((name) => !subagentNames.includes(name)));
    assert.notEqual(booted.surfaceContext.get("subagents"), undefined);
    assert.notEqual(booted.surfaceContext.get("tmux"), undefined);
    await booted.context.loader.update(subagentsId, { disabled: false });
    assertBootTools(booted, productNames);

    const memoryProvider = booted.context.loader.resolve("include:memory-storage").fiber;
    await booted.context.loader.update("include:memory-write-tool", { disabled: true });
    assertBootTools(booted, productNames.filter(name => name !== "memory_write"));
    assert.equal(booted.context.loader.resolve("include:memory-storage").fiber, memoryProvider);
    assert.equal((await booted.surfaceContext.get("memory").state()).revision, 0);
    await booted.context.loader.update("include:memory-write-tool", { disabled: false });
    assertBootTools(booted, productNames);
  } finally {
    await defaultBoot?.dispose();
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("tools"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

function toolNames(registry) {
  return registry.list().map((tool) => tool.name);
}

function assertBootTools(booted, expected, message) {
  assert.deepEqual(toolNames(booted.surfaceContext.get("tools").registry).sort(), [...expected].sort(), message);
}
