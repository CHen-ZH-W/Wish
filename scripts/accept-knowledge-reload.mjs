import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repository = dirname(dirname(fileURLToPath(import.meta.url)));

for (const [id, file, from, to, service, surface = "cli"] of [
  ["skills-local", "skills/providers/local.js", '".wish", "skills"', '".wish", "skills-v2"', "skills"],
  ["memory-storage", "memory/providers/storage.js", 'code: "memory"', 'code: "memory_v2"', "memory"],
  ["memory-subagent-resources", "memory/consumers/subagent-resources.js", 'code: "memory_subagent_resources"', 'code: "memory_subagent_resources_v2"'],
  ["memory-curation", "memory/providers/curation.js", '"Memory curation background pass failed"', '"Memory curation v2 background pass failed"', "memoryCuration"],
  ["web-fetch-http", "web/providers/http-fetch.js", '"web_fetch_provider"', '"web_fetch_provider_v2"', "webFetch"],
  ["system-prompt-base", "system-prompt/consumers/base.js", '"You are Wish,', '"You are Wish v2,'],
  ["system-prompt", "system-prompt/service.js", 'code: "system_prompt"', 'code: "system_prompt_v2"', "systemPrompt"],
  ["context-engine", "context/service.js", 'code: "context_engine"', 'code: "context_engine_v2"', "contextEngine"],
  ["compaction", "compaction/service.js", 'code: "compaction"', 'code: "compaction_v2"', "compaction"],
  ["plan-storage", "plan/providers/storage.js", 'code: "plan"', 'code: "plan_v2"', "plan"],
  ["tasks-storage", "tasks/providers/storage.js", 'code: "tasks"', 'code: "tasks_v2"', "tasks"],
  ["coordinator-storage", "coordinator/providers/storage.js", 'code: "coordinator"', 'code: "coordinator_v2"', "coordinator"],
  ["model-openai-chat-completions", "models/providers/openai-compatible.js", '"OpenAI-compatible', '"OpenAI-compatible v2'],
  ["context-engine", "context/service.js", 'code: "context_engine"', 'code: "context_engine_v2"', "contextEngine", "webui"],
]) test(`${surface} native reload replaces ${id}, restores dependents and keeps unrelated owners`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-knowledge-hmr-")); let booted;
  try {
    await cp(join(repository, "dist"), join(directory, "dist"), { recursive: true });
    await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const { bootstrap } = await import(pathToFileURL(join(directory, "dist/boot/bootstrap.js")));
    const { managedWebUi } = await import(pathToFileURL(join(directory, "dist/apps/webui/host/composition.js")));
    booted = await bootstrap({ surface, argv: surface === "cli" ? ["--version"] : [], cwd: directory, homeDirectory: directory,
      environment: { CORDIS_HMR: "1", WISH_DATA_DIR: join(directory, "data"), WISH_WEB_FETCH_ENABLED: "1", WISH_MEMORY_CURATION_ENABLED: "1" },
      ...(surface === "webui" ? { management: managedWebUi({ directory: join(directory, "management"), port: 0 }) } : {}),
    });
    if (surface === "cli") assert.equal(await booted.completion, 0);
    const root = booted.context, ctx = booted.surfaceContext, entry = root.loader.resolve(`include:${id}`), previous = entry.fiber;
    const oldService = service ? ctx.get(service) : undefined;
    const stable = new Map(["runtime", "sessions", "tools", "application"].map(id => [id, root.loader.resolve(`include:${id}`).fiber]));
    const tools = ctx.get("tools").registry.list().map(tool => tool.name).sort();
    const filename = join(directory, "dist", file), source = await readFile(filename, "utf8");
    assert.ok(source.includes(from)); await writeFile(filename, source.replace(from, to));
    const deadline = Date.now() + 8000;
    while (booted.codeReload.snapshot().phase !== "succeeded") {
      if (Date.now() > deadline) throw Error(JSON.stringify(booted.codeReload.snapshot()));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.notEqual(entry.fiber, previous); assert.equal(previous.state, 4);
    assert.deepEqual(previous.getEffects(), []);
    for (const [id, fiber] of stable) assert.equal(root.loader.resolve(`include:${id}`).fiber, fiber);
    assert.deepEqual(ctx.get("tools").registry.list().map(tool => tool.name).sort(), tools);
    if (service) assert.notEqual(ctx.get(service), oldService);
    if (service === "memory") { await assert.rejects(oldService.state(), /memory_closed/); await ctx.get(service).state(); }
    if (service === "skills") { await assert.rejects(oldService.list({ cwd: directory }), /closed/); await ctx.get(service).list({ cwd: directory }); }
    if (service === "memoryCuration") { assert.throws(() => oldService.scheduler.scan(), /closed/); await ctx.get(service).scheduler.scan(); }
    if (service === "plan") { await assert.rejects(oldService.get({ sessionId: "fixture" }), /closed/); await ctx.get(service).get({ sessionId: "fixture" }); }
    if (service === "tasks") { await assert.rejects(oldService.get("fixture"), /closed/); await ctx.get(service).get("fixture"); }
    if (service === "coordinator") { await assert.rejects(oldService.get({ runId: "fixture" }), /closed/); await ctx.get(service).get({ runId: "fixture" }); }
    if (service === "systemPrompt") { assert.throws(() => oldService.assembleInstructions({ availableTools: [] }), /closed/); ctx.get(service).assembleInstructions({ availableTools: [] }); }
    if (service === "contextEngine" || service === "compaction") assert.throws(() => oldService.open({}), /closed/);
    if (id === "system-prompt-base") assert.match(ctx.get("systemPrompt").assembleInstructions({ availableTools: [] })[0].content, /Wish v2/);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
