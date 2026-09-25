import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HOST_PLUGIN_CATALOG,
  HOST_PLUGIN_MANAGEMENT,
  MODEL_TOOL_PLUGIN_CATALOG,
  MODEL_TOOL_PLUGIN_MANAGEMENT,
} from "../dist/boot/plugin-catalog.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("WebUI keeps transport, React-free models, presentation and module adapters separate", async () => {
  for (const path of ["src/apps/webui/client/model/session.ts", "src/apps/webui/client/model/run.ts", "src/apps/webui/client/model/features.ts", "src/apps/webui/client/model/new-session.ts", "src/workspace/consumers/webui/directory-model.ts", "src/settings/consumers/webui/model.ts", "src/approval/consumers/webui/model.ts", "src/models/consumers/webui/reasoning-model.ts"]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /from ["']react|from ["']react-dom/u, path);
  }
  for (const path of ["src/apps/webui/client/ui/shell.tsx", "src/apps/webui/client/ui/conversation.tsx", "src/apps/webui/client/ui/feature.tsx"]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /@deepseek-ai\/cordis|\bfetch\(|new EventSource|toolName === ["'](?:bash|read|write|spawn_agent)/u, path);
  }
  for (const module of ["plan", "skills", "memory", "workflow", "tasks", "context", "tmux", "subagents", "models"]) await access(join(root, "src", module, "consumers/webui/index.tsx"));
  const shell = await readFile(join(root, "src/apps/webui/client/ui/shell.tsx"), "utf8");
  assert.doesNotMatch(shell, /\barchives?\b|\barchived\b|SessionClientModel|wishSession|\.browse\(/u, "Shell renders owned sidebar contracts, never archive or Session dispatch");
  const settings = await readFile(join(root, "src/settings/settings.ts"), "utf8");
  assert.doesNotMatch(settings, /plugin-control|core\/runtime|apps\/webui|models|react/u);
  const models = await readFile(join(root, "src/models/service.ts"), "utf8");
  assert.doesNotMatch(models, /apps\/webui|react/u);
  const client = await readFile(join(root, "src/apps/webui/client/main.tsx"), "utf8");
  assert.doesNotMatch(client, /ModelsClientUi|id: ["']models["']/u, "stable Browser composition does not own the Models panel");
  assert.doesNotMatch(await readFile(join(root, "src/apps/webui/server.ts"), "utf8"), /directory-picker\/local/u, "HTTP adapter consumes the directory browser interface, not its local implementation");
});

test("Host capabilities and model Tool Consumers use disjoint plugin catalogs", () => {
  const host = Object.keys(HOST_PLUGIN_CATALOG);
  const tools = Object.keys(MODEL_TOOL_PLUGIN_CATALOG);
  assert.deepEqual(host.filter((name) => tools.includes(name)), []);
  assert.equal(host.includes("filesystem-local"), true);
  assert.equal(host.includes("subagents-runtime"), true);
  assert.equal(host.includes("plan-storage"), true);
  assert.equal(host.includes("coordinator-storage"), true);
  assert.equal(tools.includes("read"), true);
  assert.equal(tools.includes("subagent-tools"), true);
  assert.equal(tools.includes("plan-tools"), true);
  assert.equal(tools.includes("coordinator-tools"), true);
  assert.deepEqual(Object.keys(HOST_PLUGIN_MANAGEMENT).sort(), host.sort(), "every Host alias has explicit management metadata");
  assert.deepEqual(Object.keys(MODEL_TOOL_PLUGIN_MANAGEMENT).sort(), tools.sort(), "every Tool alias has explicit management metadata");
  assert.deepEqual(Object.entries(HOST_PLUGIN_MANAGEMENT).filter(([, value]) => value !== "managed"), [
    ["include", "kernel"], ["group", "structural"], ["timer", "kernel"], ["hmr", "kernel"],
  ]);
});

test("converged source layout keeps shared contracts with their real owners", async () => {
  for (const path of [
    "src/capabilities",
    "src/presets",
    "src/runtime",
    "src/subprocess",
  ]) {
    await assert.rejects(access(join(root, path)), undefined, path);
  }
  assert.match(
    await readFile(join(root, "src/permissions/authorization.ts"), "utf8"),
    /CapabilityAuthorizationGrant/u,
  );
  assert.match(
    await readFile(join(root, "src/composition/README.md"), "utf8"),
    /Cordis services and lifecycle generations/u,
  );
});

test("generic capability Providers do not depend on Tool authorization", async () => {
  for (const path of [
    "src/filesystem/types.ts",
    "src/filesystem/providers/local.ts",
    "src/filesystem/search/types.ts",
    "src/filesystem/search/providers/local.ts",
    "src/shell/types.ts",
    "src/shell/providers/host.ts",
    "src/shell/providers/linux-native.ts",
    "src/web/types.ts",
    "src/web/providers/http-fetch.ts",
    "src/web/providers/searxng-search.ts",
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(source, /core\/tools\/authorization|ToolAuthorizationGrant/u, path);
  }
});

test("Tmux and Subagents keep transport, domain, and App ownership separate", async () => {
  for (const path of [
    "src/tmux/types.ts",
    "src/tmux/service.ts",
    "src/tmux/providers/local.ts",
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(source, /subagent|parentRunId|childRunId|childSessionId/iu, path);
  }
  assert.doesNotMatch(
    await readFile(join(root, "src/tmux/providers/local.ts"), "utf8"),
    /node:child_process/u,
  );
  for (const path of [
    "src/tmux/command-runner.ts",
    "src/tmux/providers/node-command-runner.ts",
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(source, /@deepseek-ai\/cordis|extends Service/u, path);
  }
  for (const path of [
    "src/subagents/types.ts",
    "src/subagents/service.ts",
    "src/subagents/runtime.ts",
    "src/subagents/store.ts",
    "src/subagents/launcher.ts",
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*(?:tmux|apps)\//u, path);
  }
});

test("Tools and Core do not own concrete feature Consumers", async () => {
  for (const path of [
    "src/tools/index.ts",
    "src/tools/service.ts",
    "src/core/tools/tool.ts",
    "src/core/tools/executor.ts",
    "src/core/tools/registry.ts",
    "src/core/agent-loop/agent-loop.ts",
  ]) {
    const source = await readFile(join(root, path), "utf8");
    assert.doesNotMatch(
      source,
      /(?:filesystem|shell|web|subagents|plan|coordinator|tasks|workflow|skills|memory)\/(?:providers|consumers)|composition\/coding-tools/u,
      path,
    );
  }
});

test("Task definitions and mode capabilities do not import workflow execution", async () => {
  for (const path of ["src/tasks/types.ts", "src/tasks/runtime.ts", "src/tasks/store.ts", "src/tasks/graph.ts", "src/tasks/transition.ts", "src/coordinator/runtime.ts"]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /from ["'][^"']*(?:workflow|tmux|subagents)\//u);
  }
  for (const path of ["src/apps/application.ts", "src/apps/session-features.ts", "src/apps/cli/session-features.ts", "src/apps/webui/server.ts"]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /from ["'][^"']*(?:plan|tasks|workflow|skills|memory)\//u);
  }
});

test("Plan and Coordinator remain independent business modules", async () => {
  const planSources = await Promise.all([
    "src/plan/types.ts",
    "src/plan/runtime.ts",
    "src/plan/store.ts",
    "src/plan/policy.ts",
    "src/plan/service.ts",
  ].map((path) => readFile(join(root, path), "utf8")));
  for (const source of planSources) {
    assert.doesNotMatch(source, /coordinator|taskgraph|workflow/iu);
  }

  const coordinatorSources = await Promise.all([
    "src/coordinator/types.ts",
    "src/coordinator/runtime.ts",
    "src/coordinator/store.ts",
    "src/coordinator/policy.ts",
    "src/coordinator/service.ts",
  ].map((path) => readFile(join(root, path), "utf8")));
  for (const source of coordinatorSources) {
    assert.doesNotMatch(source, /from ["'][^"']*(?:plan|tmux)\//u);
    assert.doesNotMatch(source, /new SubagentRuntime|TmuxSubagentExecution/u);
  }

  for (const path of ["src/tools/plan", "src/tools/coordinator", "src/tools/subagents", "src/tools/skills", "src/tools/memory"]) {
    await assert.rejects(access(join(root, path)), undefined, path);
  }
});

test("Skills and Memory domain capabilities remain independent of optional consumers", async () => {
  for (const path of [
    "src/skills/types.ts", "src/skills/local.ts", "src/skills/service.ts",
    "src/memory/types.ts", "src/memory/memory.ts", "src/memory/store.ts", "src/memory/retrieval.ts", "src/memory/service.ts",
  ]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /from ["'][^"']*(?:context|tools|apps|plan|coordinator|workflow|subagents|models|consumers)\//u, path);
  }
  for (const path of ["src/core/context/projector.ts", "src/context/context.ts", "src/context/service.ts", "src/subagents/resources.ts", "src/storage/service.ts"]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /from ["'][^"']*(?:skills|memory)\//u, path);
  }
});

test("bootstrap delegates profile and catalog ownership", async () => {
  const source = await readFile(join(root, "src/boot/bootstrap.ts"), "utf8");
  assert.match(source, /resolveWishConfiguration/u);
  assert.match(source, /installWishPluginCatalog/u);
  assert.doesNotMatch(
    source,
    /composition\/coding-tools|filesystem\/providers|subagents\/providers|web\/tools/u,
  );
});
