import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/service.js";
import { StorageBackendService } from "../dist/storage/binding.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import StorageMemory from "../dist/memory/providers/storage.js";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";
import { createMemoryTools } from "../dist/memory/consumers/model-tools.js";
import { MemoryContextProvider } from "../dist/memory/consumers/context.js";
import { searchMemoryFiles } from "../dist/memory/retrieval.js";
import { parseMemoryCitations } from "../dist/memory/citations.js";
import { content, document, hash } from "../dist/memory/validation.js";
import { MemoryCurationScheduler } from "../dist/memory/curation/scheduler.js";
import { DomainCurationStore } from "../dist/memory/curation/store.js";
import { ModelMemoryExtractor } from "../dist/memory/curation/extractor.js";
import { EXTRACTION_PROMPT, CONSOLIDATION_PROMPT, memoryReadInstructions } from "../dist/memory/curation/prompts.js";
import { workspaceDiff, pruneExtensionResources } from "../dist/memory/curation/workspace.js";
import { BackgroundMemoryCuration } from "../dist/memory/curation/background.js";
import { createCurationTrigger } from "../dist/memory/consumers/curation-trigger.js";
import { tryMemoryLock } from "../dist/memory/file-lock.js";
import { redactMemorySecrets } from "../dist/memory/secrets.js";
import { issueToolAuthorizationGrant, withActiveToolAuthorizationGrant } from "../dist/core/tools/authorization.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";
import { mapOpenAIResponsesRequest } from "../dist/models/providers/openai-responses-request.js";
import { mapOpenAIRequest } from "../dist/models/providers/openai-compatible-request.js";

const ref = { provider: "fixture", model: "memory" };
const evidenceRef = { kind: "operator", id: "fixture", revision: "1", digest: hash("fixture") };
function file(path, value) {
  const body = content({ path, title: path, content: value, appliesTo: "/project", keywords: [], evidence: [evidenceRef] });
  return document({ ...body, id: `file-${hash(path)}`, version: 1, status: "accepted", digest: hash(body), updatedAt: "2026-10-26T00:00:00Z" });
}
function evidence(id = "first", sequence = 1) {
  return { id, sourceId: "runtime-sessions", sessionId: "session-1", outcome: "completed", text: "User prefers pnpm.", appliesTo: "/project", cwd: "/project",
    occurredAt: "2026-10-26T00:00:00Z", references: [{ kind: "session", id: "session-1", revision: `r${sequence}`, digest: hash(sequence), throughSequence: sequence }] };
}
function schedulerFixture(options = {}) {
  let state = { schemaVersion: 1, libraryId: "default", revision: 0, jobs: [] };
  const store = { async read() { return structuredClone(state); }, async commit(value, expected) { assert.equal(state.revision, expected); state = structuredClone(value); }, async close() {} };
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const extractor = { async extract(item) { return [{ title: "Preference", content: item.text, appliesTo: item.appliesTo, keywords: [], evidence: item.references }]; } };
  const consolidator = { async consolidate() { return { upserts: [], retirements: [] }; } };
  return { store, memory, scheduler: new MemoryCurationScheduler({ memory, store, extractor, consolidator, maintenance: true, ...options }) };
}
async function execute(tool, input) {
  const parsed = tool.parse(input); assert.equal(parsed.ok, true, parsed.message);
  const context = basicToolContext("/project");
  const grant = issueToolAuthorizationGrant({ grantId: "grant", call: { status: "ready", id: "call-1", name: tool.name, input: parsed.input },
    capabilities: tool.resolveCapabilities(parsed.input, context), snapshot: { schemaVersion: 1, registryVersion: 1, authorityVersion: context.permissions.authorityVersion, availableTools: [tool.name] },
    policyVersion: "fixture", clock: { now: () => new Date(1000) }, issuedAtEpochMs: 1000, ttlMs: 60000 });
  const result = await withActiveToolAuthorizationGrant(grant, () => tool.execute(parsed.input, context, grant));
  return JSON.parse(result.content[0].text.split("\n").slice(1).join("\n"));
}

test("memory search returns exact lines/context and supports Codex multi-query/window semantics", () => {
  const files = [file("MEMORY.md", "# Task Group: Wish\nRun pnpm test\nCheck the result\nRun npm test\n"), file("skills/verify/SKILL.md", "Use pnpm_test after edits")];
  const found = searchMemoryFiles(files, { queries: ["pnpm"], path: "MEMORY.md", contextLines: 1 });
  assert.equal(found.matches.length, 1); assert.equal(found.matches[0].matchLineNumber, 2);
  assert.equal(found.matches[0].contentStartLineNumber, 1); assert.match(found.matches[0].content, /Check the result/);
  assert.equal(searchMemoryFiles(files, { queries: ["pnpm", "result"], matchMode: "all_on_same_line" }).matches.length, 0);
  assert.equal(searchMemoryFiles(files, { queries: ["pnpm", "result"], matchMode: { type: "all_within_lines", lineCount: 2 } }).matches.length, 1);
  assert.equal(searchMemoryFiles(files, { queries: ["PNPM-TEST"], path: "skills", normalized: true, caseSensitive: false }).matches[0].path, "skills/verify/SKILL.md");
  const page = searchMemoryFiles(files, { queries: ["test"], limit: 1 });
  assert.equal(page.nextOffset, 1); assert.equal(page.totalMatches, 3);
  assert.throws(() => searchMemoryFiles(files, { queries: ["---"], normalized: true }), /empty after normalization/);
});

test("foreground tools read numbered ranges and search matching content instead of the document header", async () => {
  const memory = { libraryId: "default", files: async () => [file("MEMORY.md", "# Handbook\n\nUse pnpm test\nKeep the output\n")], state: async () => ({ documents: [], revision: 0 }) };
  const tools = createMemoryTools(memory);
  const found = await execute(tools.find(tool => tool.name === "memory_search"), { queries: ["pnpm"], contextLines: 1 });
  assert.equal(found.matches[0].matchLineNumber, 3); assert.match(found.entries[0].preview, /Use pnpm test/);
  const read = await execute(tools.find(tool => tool.name === "memory_read"), { path: "MEMORY.md", lineOffset: 3, maxLines: 1 });
  assert.equal(read.content, "Use pnpm test\n"); assert.equal(read.startLineNumber, 3); assert.equal(read.nextLineOffset, 4);
  assert.equal(read.numberedContent, "3\tUse pnpm test");
});

test("full writing and reading specifications keep task evidence, forgetting, Skills and citation contracts", () => {
  assert.match(EXTRACTION_PROMPT, /TASK OUTCOME TRIAGE/); assert.match(EXTRACTION_PROMPT, /Preference signals:/);
  assert.match(CONSOLIDATION_PROMPT, /Incremental update and forgetting mechanism/); assert.match(CONSOLIDATION_PROMPT, /efficiency plan/i);
  assert.match(CONSOLIDATION_PROMPT, /User edits shown in the diff/);
  const read = memoryReadInstructions("v1\n\nWish project");
  assert.match(read, /Decision boundary/); assert.match(read, /citation_entries/); assert.match(read, /memory_write/);
  assert.doesNotMatch(read, /\{\{ |<oai-mem-citation>|\.codex|ideally <= 4-6/);
  assert.doesNotMatch(CONSOLIDATION_PROMPT, /<= 350 words|under 500 lines|\{\{ /);
});

test("structured citations preserve line evidence and legacy paths remain readable", () => {
  const source = `curation-${"a".repeat(64)}`;
  const citation = parseMemoryCitations(`<wish-memory-citation>\n<citation_entries>\nMEMORY.md:3-8|note=[pnpm command]\nMEMORY.md:0-1|note=[invalid]\n</citation_entries>\n<rollout_ids>session-1\n${source}</rollout_ids>\nrollout_summaries/${source}.md\n</wish-memory-citation>`);
  assert.deepEqual(citation.entries, [{ path: "MEMORY.md", lineStart: 3, lineEnd: 8, note: "pnpm command" }]);
  assert.deepEqual(citation.sourceIds, ["session-1", source]);
});

test("Wish continuations record each assistant message's memory use without waking learning", async () => {
  const used = [], wakes = [], done = Promise.withResolvers(), recorded = Promise.withResolvers();
  const feature = createCurationTrigger({ wake(id) { wakes.push(id); }, async recordUsage(ids) { used.push(ids); if (used.length === 2) recorded.resolve(); } }, {});
  const citation = "<wish-memory-citation><rollout_ids>session-1</rollout_ids></wish-memory-citation>";
  await feature.runStarted({ async readSessionHistory() { return { records: [
    { kind: "message", runId: "goal-run", message: { role: "assistant", content: citation } },
    { kind: "message", runId: "goal-run", message: { role: "assistant", content: citation } },
    { kind: "message", runId: "older-run", message: { role: "assistant", content: citation } },
  ] }; } }, { scope: "session", runId: "goal-run", completion: done.promise }, { inputSource: "continuation", text: "Continue the Goal" });
  done.resolve(); await recorded.promise;
  assert.deepEqual(used, [["session-1"], ["session-1"]]); assert.deepEqual(wakes, []);
});

test("re-extraction inherits use history and late citations remain routable after source pruning", async () => {
  const f = schedulerFixture(); let current = evidence();
  f.scheduler.registerSource({ id: "runtime-sessions", scan: async () => [current] });
  try {
    await f.scheduler.scan(); await f.scheduler.tick();
    const old = (await f.scheduler.state()).jobs[0];
    await f.scheduler.recordUsage([old.id, "session-1"]);
    current = evidence("second", 2); current.text = "User confirms pnpm.";
    await f.scheduler.scan(); await f.scheduler.tick();
    let state = await f.scheduler.state();
    assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].usageCount, 1);
    assert.ok(state.jobs[0].lastUsedAt); assert.equal(state.sourceAliases[old.id], "session-1");
    await f.scheduler.recordUsage([old.id]);
    state = await f.scheduler.state(); assert.equal(state.jobs[0].usageCount, 2);
  } finally { await f.scheduler.close(); await f.memory.close(); }
});

test("failed extraction retains a durable retry time without an attempt quota", async () => {
  let now = Date.parse("2026-10-26T00:00:00Z"), calls = 0;
  const f = schedulerFixture({ now: () => new Date(now), retryDelayMs: 3600000, extractor: { async extract() { calls++; throw new Error("offline"); } } });
  f.scheduler.registerSource({ id: "runtime-sessions", scan: async () => [evidence()] });
  try {
    await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs[0].retryAt, "2026-10-26T01:00:00.000Z");
    await f.scheduler.recover(); await f.scheduler.tick(); assert.equal(calls, 1);
    now += 3600000; await f.scheduler.tick(); assert.equal(calls, 2);
  } finally { await f.scheduler.close(); await f.memory.close(); }
});

test("Session generation opt-out stops selection and can be re-enabled without losing source evidence", async () => {
  const f = schedulerFixture();
  f.scheduler.registerSource({ id: "runtime-sessions", scan: async () => [evidence()] });
  try {
    await f.scheduler.setSessionMode("session-1", "disabled"); await f.scheduler.scan(); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).jobs[0].attempts, 0);
    await f.scheduler.setSessionMode("session-1", "enabled"); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).selectedJobIds.length, 1);
    await f.scheduler.setSessionMode("session-1", "disabled"); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).selectedJobIds.length, 0); assert.equal((await f.scheduler.state()).jobs.length, 1);
    await f.scheduler.setSessionMode("session-1", "enabled"); await f.scheduler.tick();
    assert.equal((await f.scheduler.state()).selectedJobIds.length, 1); assert.equal((await f.scheduler.state()).jobs[0].attempts, 1);
  } finally { await f.scheduler.close(); await f.memory.close(); }
});

test("extraction redacts both uploaded evidence and generated memory", async () => {
  const key = "sk-" + "A".repeat(24), requests = [];
  const model = { async *stream(request) { requests.push(request); yield { type: "text_delta", text: JSON.stringify({ raw_memory: `API key: ${key}`, rollout_summary: `Bearer ${"B".repeat(24)}`, rollout_slug: "keys" }) }; yield { type: "done", finishReason: "stop" }; } };
  const result = await new ModelMemoryExtractor(model, ref).extract({ ...evidence(), text: `User pasted ${key}` }, new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(key)); assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  assert.match(result[0].content, /REDACTED_SECRET/); assert.match(result[0].rolloutSummary, /REDACTED_SECRET/);
  assert.ok(requests[0].responseSchema.schema.additionalProperties === false);
  assert.equal(redactMemorySecrets('"password":"abcdefghijk"'), '"password":"[REDACTED_SECRET]"');
});

test("model context overflow splits evidence without dropping its beginning or end", async () => {
  const original = "first-" + "汉字🙂".repeat(100) + "-last"; let calls = 0;
  const model = { async *stream(request) {
    calls++; const value = JSON.parse(request.messages[0].content).untrustedRollout;
    if ([...value].length > 100) { yield { type: "error", error: { code: "context_overflow", message: "window", retryable: false } }; return; }
    yield { type: "text_delta", text: JSON.stringify({ raw_memory: value, rollout_summary: value, rollout_slug: "part" }) };
    yield { type: "done", finishReason: "stop" };
  } };
  const output = await new ModelMemoryExtractor(model, ref).extract({ ...evidence(), text: original }, new AbortController().signal);
  assert.ok(calls > 1); assert.equal(output.map(item => item.content).join(""), original);
});

test("native Responses schema and compatible JSON mode survive protocol mapping", () => {
  const schema = { name: "memory_extraction", schema: { type: "object", properties: { raw_memory: { type: "string" } }, required: ["raw_memory"], additionalProperties: false } };
  const request = { model: ref, instructions: [{ role: "system", content: "Return JSON" }], messages: [{ role: "user", content: "JSON" }], tools: [], responseSchema: schema };
  const adapter = { model: { developerRoleMode: "native", spec: { reasoning: false, developerRole: true }, request: { extraBody: {}, supportsTemperature: true } } };
  const responses = mapOpenAIResponsesRequest(request, adapter).body;
  assert.deepEqual(responses.text.format, { type: "json_schema", name: schema.name, strict: true, schema: schema.schema });
  assert.deepEqual(mapOpenAIRequest(request, adapter).body.response_format, { type: "json_object" });
});

test("workspace diff shows changed hunks rather than replacing every unchanged line", () => {
  const before = Array.from({ length: 1000 }, (_, index) => `unchanged-${index}`).join("\n");
  const after = before.replace("unchanged-500", "updated command");
  const diff = workspaceDiff({ "MEMORY.md": before }, { "MEMORY.md": after });
  assert.match(diff, /@@/); assert.match(diff, /-unchanged-500/); assert.match(diff, /\+updated command/);
  assert.doesNotMatch(diff, /unchanged-20\n/); assert.ok(diff.length < 1000);
});

test("extension resource expiry creates a forgetting diff while explicit notes remain durable", () => {
  const old = "extensions/research/resources/2026-10-01T12-00-00-result.md";
  const note = "extensions/ad_hoc/notes/2026-10-01T12-00-00-note.md";
  const files = { "extensions/research/instructions.md": "Research evidence", [old]: "obsolete source", [note]: "User correction" };
  const pruned = pruneExtensionResources(files, Date.parse("2026-10-26T00:00:00Z"));
  assert.equal(pruned[old], undefined); assert.equal(pruned[note], "User correction");
  assert.match(workspaceDiff(files, pruned), /-obsolete source/);
});

test("a new foreground wake releases the old trigger exclusion while a background pass is running", async () => {
  const scans = [], first = Promise.withResolvers(), release = Promise.withResolvers();
  const scheduler = { async state() { return { jobs: [] }; }, async scan(_signal, context) {
    scans.push({ past: await context.acceptsSession("past"), current: await context.acceptsSession("current") });
    if (scans.length === 1) { first.resolve(); await release.promise; }
  }, async tick() {} };
  const background = new BackgroundMemoryCuration({ scheduler, minIdleMs: 0, getSession: async () => ({ status: "active", updatedAt: new Date(Date.now() - 1000).toISOString() }) });
  try {
    background.resume(); background.wake("past");
    const keepAlive = setInterval(() => {}, 100);
    try {
      await first.promise; background.wake("current"); release.resolve();
      const deadline = Date.now() + 3000;
      while (scans.length < 2) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    } finally { clearInterval(keepAlive); }
    assert.deepEqual(scans[0], { past: false, current: true });
    assert.deepEqual(scans[1], { past: true, current: false });
  } finally { background.stop(); await background.drain(); }
});

async function temporary(t, prefix) { const directory = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function storageHost(directory) {
  const root = new Context();
  class SelectedBackend extends StorageBackendService { static inject = ["storage"]; id = "file"; }
  root.provide("sessions", { dataDirectory: directory });
  await root.plugin(StorageHub); root.storage.register(new FileStorageBackend({ id: "file", rootDirectory: join(directory, "storage") }));
  await root.plugin(SelectedBackend); await root.plugin(StorageMemory);
  return root;
}

test("Host memory sees direct file edits immediately while Journal receipts remain unchanged", async t => {
  const directory = await temporary(t, "wish-memory-live-files-"), root = await storageHost(directory);
  t.after(() => root.fiber.dispose());
  const path = join(directory, "memories", "default"); await mkdir(path, { recursive: true });
  await writeFile(join(path, "MEMORY.md"), "# Task Group: Project\nUse pnpm test\n");
  await writeFile(join(path, "memory_summary.md"), "v1\n\nProject uses pnpm; see MEMORY.md.");
  assert.equal((await root.memory.state()).revision, 0);
  assert.equal((await execute(createMemoryTools(root.memory)[0], { queries: ["pnpm"] })).matches.length, 2);
  await writeFile(join(path, "MEMORY.md"), "# Task Group: Project\nUse bun test\n");
  assert.match((await execute(createMemoryTools(root.memory)[1], { path: "MEMORY.md" })).content, /bun test/);
  assert.equal((await root.memory.state()).revision, 0);
  const projection = await new MemoryContextProvider(root.memory).provide({ request: { availableTools: ["memory_read"] } });
  assert.equal(projection[0].message.role, "developer"); assert.match(projection[0].message.content, /Decision boundary/);
});

test("two independent Host stores serialize curation updates without losing either note", async t => {
  const directory = await temporary(t, "wish-memory-shared-state-"), roots = await Promise.all([storageHost(directory), storageHost(directory)]);
  t.after(() => Promise.all(roots.map(root => root.fiber.dispose())));
  const schedulers = roots.map(root => new MemoryCurationScheduler({ memory: root.memory,
    store: new DomainCurationStore(root.storageBackend, "file", "default", join(directory, "memories", "default")),
    extractor: { async extract() { return []; } }, consolidator: { async consolidate() { return { upserts: [], retirements: [] }; } } }));
  t.after(() => Promise.all(schedulers.map(scheduler => scheduler.close())));
  await Promise.all(schedulers.map((scheduler, index) => scheduler.addNote({ operationId: `note-${index}`, text: `User note ${index}`, evidence: [evidenceRef] })));
  const state = await schedulers[0].state(); assert.equal(state.jobs.length, 2); assert.equal(state.revision, 2);
  await Promise.all(roots.map((root, index) => root.memory.propose({ operationId: `host-proposal-${index}`, targetId: `host-${index}`, expectedDocumentVersion: 0,
    title: `Host ${index}`, content: "Legacy Host integration", keywords: [], appliesTo: "/project", evidence: [evidenceRef], actor: { kind: "agent", id: `host-${index}` }, reason: "Verify shared Journal commits" })));
  const library = await roots[0].memory.state(); assert.equal(library.revision, 2); assert.equal(library.candidates.length, 2);
});

test("OS memory lock excludes another process and recovers after its owner is killed", async t => {
  const directory = await temporary(t, "wish-memory-process-lock-");
  const module = new URL("../dist/memory/file-lock.js", import.meta.url).href;
  const source = `import { writeSync } from "node:fs"; import { tryMemoryLock } from ${JSON.stringify(module)}; await tryMemoryLock(${JSON.stringify(directory)}, "curation-pipeline", async () => { writeSync(1, "held\\n"); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(() => { child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error(`lock owner exited: ${code}`)); }); });
  assert.equal((await tryMemoryLock(directory, "curation-pipeline", async () => "wrong owner")).acquired, false);
  child.kill("SIGKILL"); await closed;
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await tryMemoryLock(directory, "curation-pipeline", async () => "recovered");
    if (result.acquired) { assert.equal(result.value, "recovered"); break; }
    assert.ok(Date.now() < deadline, "OS lock must release after owner death");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});
