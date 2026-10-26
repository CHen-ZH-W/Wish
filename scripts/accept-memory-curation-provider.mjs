import { memoryConsolidationEvents } from "./support/memory-model.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/service.js";
import { StorageBackendService } from "../dist/storage/binding.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import StorageMemory from "../dist/memory/providers/storage.js";
import StorageMemoryCuration from "../dist/memory/providers/curation.js";
import { bootstrap } from "../dist/boot/bootstrap.js";

test("bare Cordis provider waits for its Host trigger, reloads durable queue, and releases leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-curation-provider-"));
  const root = new Context();
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  class SelectedBackend extends StorageBackendService {
    static inject = ["storage"];
    id = "file";
  }
  try {
    root.provide("models", { async load() { return {}; }, open() { return {
      configuredModel: { getDefaultModel: () => ({ provider: "fixture", model: "memory" }) },
      measuredModel: { async *stream(request) {
        yield { type: "start", model: request.model };
        yield* memoryConsolidationEvents(request);
      } },
    }; } });
    root.provide("sessions", { dataDirectory: directory, manager: { async get() { throw new Error("No sessions"); } } });
    root.provide("runEngine", { lifecycleSnapshot: () => ({ activeRuns: 0 }) });
    await root.plugin(StorageHub); root.storage.register(backend);
    await root.plugin(SelectedBackend); await root.plugin(StorageMemory);
    let provider = await root.plugin(StorageMemoryCuration, { extractor: "recap" });
    const scheduler = root.memoryCuration.scheduler;
    scheduler.registerSource({ id: "fixture", scan: async () => [{ id: "fixture-1", sourceId: "fixture", outcome: "unknown",
      text: "untrusted execution result", appliesTo: "fixture", references: [{ kind: "operator", id: "fixture", revision: "1", digest: "a".repeat(64) }] }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await scheduler.state()).jobs.length, 0);
    await scheduler.scan();
    assert.equal((await scheduler.state()).jobs[0].status, "queued");
    await provider.dispose();
    assert.throws(() => scheduler.scan(), /closed/);
    provider = await root.plugin(StorageMemoryCuration, { extractor: "recap" });
    assert.equal((await root.memoryCuration.scheduler.state()).jobs.length, 1);
    await root.memoryCuration.scheduler.tick();
    assert.equal((await root.memory.state()).candidates.length, 0);
    assert.ok((await root.memory.query()).length, JSON.stringify(await root.memoryCuration.scheduler.state()));
    await provider.dispose();
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("shipped profile triggers measured model extraction through normal Application Runs while foreground work continues and later Runs retrieve the result", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-curation-cordis-"));
  const release = Promise.withResolvers(), started = Promise.withResolvers();
  let booted, foreground = 0, memoryCalls = 0, consolidationCalls = 0, citedSource, noteCalled = false;
  const requests = [];
  const configuration = JSON.stringify({ schemaVersion: 1, defaultModel: "fixture/main", fallbackModels: [], maxRetries: 0,
    providers: [{ id: "fixture", protocol: "curation-fixture", baseUrl: "https://unused.example.test", auth: { type: "none" }, developerRoleMode: "native",
      models: ["main", "memory"].map(id => ({ id, status: "active", contextWindowTokens: 100000, maxOutputTokens: 4096,
        input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true })) }] });
  try {
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_MODELS_JSON: configuration, CORDIS_HMR: "0", WISH_SKILLS_ENABLED: "0",
        WISH_SESSION_TITLE_ENABLED: "0", WISH_MEMORY_CURATION_MIN_IDLE_MS: "0", WISH_MEMORY_CURATION_MODEL: "fixture/memory" } });
    assert.equal(await booted.completion, 0);
    const ctx = booted.surfaceContext;
    ctx.get("models").registry.register("curation-fixture", () => ({ async *stream(request) {
      requests.push(request);
      yield { type: "start", model: request.model };
      if (request.metadata?.purpose === "memory-curation") {
        memoryCalls++; assert.equal(request.model.model, "memory");
        yield { type: "text_delta", text: JSON.stringify({ memories: [{ title: "项目验证", content: "修改后先执行项目验收脚本，并记录验证层次。", keywords: ["验证", "项目"] }] }) };
      } else if (request.metadata?.purpose === "memory-consolidation") {
        consolidationCalls++;
        yield* memoryConsolidationEvents(request); return;
      } else {
        if (++foreground === 2) { started.resolve(); await release.promise; }
        if (!noteCalled && request.messages.some(item => item.role === "user" && item.content.includes("记住：使用 pnpm"))) {
          noteCalled = true;
          yield { type: "tool_call", call: { id: "explicit-note", name: "memory_write", argumentsJson: JSON.stringify({ note: "Remember: use pnpm for this workspace." }) } };
          yield { type: "done", finishReason: "tool_calls" }; return;
        }
        yield { type: "text_delta", text: "Main work completed." + (citedSource ? `\n<wish-memory-citation>rollout_summaries/${citedSource}.md</wish-memory-citation>` : "") };
      }
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38, source: "provider" } };
    } }));
    const application = await ctx.get("application").open();
    const past = await application.createSession({ workspaceRoot: directory });
    const first = await application.startRun({ sessionId: past.sessionId, inputSource: "user", payload: { text: "修改后先执行项目验收脚本，区分源码、测试和实际运行结果。" } });
    assert.equal((await first.completion).status, "completed");
    await new Promise(resolve => setTimeout(resolve, 20));
    const current = await application.createSession({ workspaceRoot: directory });
    const handle = await application.startRun({ sessionId: current.sessionId, inputSource: "user", payload: { text: "继续另一个任务" } });
    await started.promise;
    const scheduler = ctx.get("memoryCuration").scheduler;
    const until = async predicate => {
      const deadline = Date.now() + 5000;
      while (!await predicate()) {
        if (Date.now() > deadline) assert.fail("Background memory did not reach expected state");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await until(async () => (await scheduler.state()).jobs[0]?.status === "completed");
    assert.equal(memoryCalls, 1); assert.ok(consolidationCalls >= 3);
    assert.equal(ctx.get("runEngine").lifecycleSnapshot().activeRuns, 1, "memory does not wait for foreground idleness");
    const memory = ctx.get("memory");
    assert.equal((await memory.state()).candidates.length, 0);
    assert.ok((await memory.state()).documents.some(item => item.path === "MEMORY.md" && item.status === "accepted"));
    citedSource = (await scheduler.state()).jobs[0].id;
    release.resolve(); await handle.completion;
    const auxiliary = requests.find(request => request.metadata?.purpose === "memory-curation");
    assert.deepEqual(auxiliary.tools, []); assert.equal(auxiliary.invocationScope, undefined);
    const history = await application.readSessionHistory({ sessionId: current.sessionId });
    const third = await application.startRun({ sessionId: current.sessionId, inputSource: "user", payload: { text: "项目验证" } });
    await third.completion;
    const lastMain = requests.filter(item => !item.metadata?.purpose).at(-1);
    assert.match(JSON.stringify(lastMain), /Project validation/);
    assert.ok(!history.records.some(record => record.kind === "message" && record.message.content.includes('"memories"')));
    await until(async () => (await scheduler.state()).jobs.find(job => job.id === citedSource)?.usageCount > 0);
    await application.sessionPermissions.select(current.sessionId, "workspace-write");
    const noteRun = await application.startRun({ sessionId: current.sessionId, inputSource: "user", payload: { text: "记住：使用 pnpm。" } });
    assert.equal((await noteRun.completion).status, "completed");
    await until(async () => (await scheduler.state()).jobs.some(job => job.evidence.sourceId === "memory-notes" && job.status === "completed"));
    assert.equal((await memory.state()).candidates.length, 0);
    assert.ok((await memory.state()).documents.some(item => item.status === "accepted" && item.path?.startsWith("extensions/ad_hoc/notes/") && item.content.includes("pnpm")));
  } finally { release.resolve(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
