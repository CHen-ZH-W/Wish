import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/service.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";
import { hash } from "../dist/memory/validation.js";
import { MemoryCurationScheduler } from "../dist/memory/curation/scheduler.js";
import { DomainCurationStore } from "../dist/memory/curation/store.js";
import { ModelMemoryExtractor } from "../dist/memory/curation/extractor.js";
import { MemoryWorkspace } from "../dist/memory/curation/workspace.js";
import { WorkspaceMemoryConsolidator } from "../dist/memory/curation/workspace-consolidator.js";
import { MemoryContextProvider } from "../dist/memory/consumers/context.js";
import { createCurationTrigger } from "../dist/memory/consumers/curation-trigger.js";
import { memoryConsolidationEvents } from "./support/memory-model.mjs";

const ref = { provider: "fixture", model: "memory" };
const skill = "---\nname: verify-project\ndescription: Verify changes to this project\n---\nRead the project scripts, run relevant checks, and distinguish source inspection from live verification.\n";
const origin = { kind: "operator", id: "fixture", revision: "1", digest: hash("fixture") };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-workspace-")), ctx = new Context();
  await ctx.plugin(StorageHub); ctx.storage.register(new FileStorageBackend({ id: "file", rootDirectory: join(directory, "store") }));
  const memory = new MemoryRuntime(new InMemoryStateStore()), store = new DomainCurationStore(ctx.storage, "file", memory.libraryId);
  const workspace = new MemoryWorkspace(join(directory, "memories"));
  const requests = [], controls = { available: true, output: { files: { "skills/verify-project/SKILL.md": skill, "skills/verify-project/scripts/check.sh": "printf verification\n" } }, fail: false, delaySteps: 0 };
  const model = { async *stream(request) {
    requests.push(request); yield { type: "start", model: request.model };
    if (controls.fail) throw new Error("provider offline");
    if (request.metadata.purpose === "memory-curation") {
      yield { type: "text_delta", text: JSON.stringify(controls.extraction ?? { raw_memory: "# Project\n\nUser preference: verify changes and report verification layers.", rollout_summary: "# Verification\n\nThe user corrected an unsupported success claim.", rollout_slug: "verification" }) };
      yield { type: "done", finishReason: "stop" }; return;
    }
    const step = request.messages.filter(item => item.role === "tool").length;
    if (step < controls.delaySteps) {
      yield { type: "tool_call", call: { id: `inspect-${step}`, name: "memory_read_file", argumentsJson: JSON.stringify({ path: "raw_memories.md" }) } };
      yield { type: "done", finishReason: "tool_calls" }; return;
    }
    yield* memoryConsolidationEvents(request, controls.output);
  } };
  const consolidator = new WorkspaceMemoryConsolidator(workspace, async () => ({ model, ref }));
  const base = { memory, store, maintenance: true, extractor: new ModelMemoryExtractor(model, ref), consolidator,
    sourceAvailable: async () => controls.available, ...options };
  const scheduler = new MemoryCurationScheduler(base);
  const evidence = { id: "source-1", sourceId: options.sourceId ?? "fixture", outcome: "completed", text: "User: distinguish tests from live verification.", appliesTo: "/project", occurredAt: new Date().toISOString(), references: [origin] };
  scheduler.registerSource({ id: evidence.sourceId, scan: async () => [evidence] });
  t.after(async () => { await scheduler.close(); await memory.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, memory, store, workspace, scheduler, controls, requests, evidence, base };
}

test("full extraction artifacts feed an uncapped AgentLoop, create reusable Skills, and inject the summary", async t => {
  const f = await fixture(t); f.controls.delaySteps = 12;
  await f.scheduler.scan(); await f.scheduler.tick();
  const state = await f.scheduler.state();
  assert.equal(state.jobs[0].status, "completed", state.jobs[0].error);
  assert.match(state.jobs[0].rawMemories[0].rolloutSummary, /unsupported success/);
  const files = await f.workspace.files();
  assert.ok(files["MEMORY.md"]); assert.match(files["memory_summary.md"], /^v1\n/u);
  assert.equal(files["skills/verify-project/SKILL.md"], skill);
  assert.equal(files["skills/verify-project/scripts/check.sh"], "printf verification\n");
  assert.ok(files[`rollout_summaries/${state.jobs[0].id}.md`]);
  assert.ok(f.requests.filter(request => request.metadata.purpose === "memory-consolidation").length > 12);
  assert.ok(f.requests.every(request => request.maxOutputTokens === undefined));
  assert.equal((await f.memory.state()).candidates.length, 0);
  const projection = await new MemoryContextProvider(f.memory).provide({ request: { currentMessage: { content: "unrelated new task" }, availableTools: ["memory_read"] } });
  assert.match(projection[0].message.content, /Project validation/);
  const count = f.requests.length;
  await f.scheduler.recordUsage([state.jobs[0].id]); await f.scheduler.tick();
  assert.equal((await f.scheduler.state()).jobs[0].usageCount, 1);
  assert.equal(f.requests.length, count, "unchanged inputs and usage ranking do not regenerate memory");
});

test("forgetting a source invokes consolidation without new extraction and cleans dependent Skills", async t => {
  const f = await fixture(t); await f.scheduler.scan(); await f.scheduler.tick();
  const old = (await f.scheduler.state()).jobs[0].id;
  f.controls.available = false;
  f.controls.output = { memory: "No supported project lessons remain.", citeSources: false, remove: ["skills/verify-project"] };
  await f.scheduler.tick();
  const files = await f.workspace.files();
  assert.equal(files[`rollout_summaries/${old}.md`], undefined);
  assert.equal(files["skills/verify-project/SKILL.md"], undefined);
  assert.doesNotMatch(files["MEMORY.md"], /curation-/);
  assert.equal(f.requests.filter(request => request.metadata.purpose === "memory-curation").length, 1);
  assert.equal((await f.scheduler.state()).jobs.length, 0);
  assert.deepEqual((await f.scheduler.state()).retiredEvidenceIds, ["source-1"]);
  assert.ok(!(await f.memory.state()).documents.some(item => item.path?.startsWith("skills/") && item.status === "accepted"));
});

test("explicit notes automatically update and forget memory, remain idempotent, and need no review", async t => {
  const f = await fixture(t);
  const note = { operationId: "remember-1", text: "Remember: use project-specific verification.", evidence: [origin] };
  const receipt = await f.scheduler.addNote(note); assert.equal(receipt.status, "recorded");
  assert.deepEqual(await f.scheduler.addNote(note), receipt);
  await assert.rejects(f.scheduler.addNote({ ...note, text: "different" }), /idempotency/);
  await f.scheduler.tick();
  assert.equal(f.requests.filter(request => request.metadata.purpose === "memory-curation").length, 0);
  assert.equal((await f.workspace.files())[`extensions/ad_hoc/notes/${receipt.noteId}.md`], note.text);
  await f.scheduler.addNote({ ...note, operationId: "forget-1", text: "Forget the previous project verification procedure." });
  f.controls.output = { memory: "Previous procedure forgotten at user request.", citeSources: false, remove: ["skills/verify-project"] };
  await f.scheduler.tick();
  assert.equal((await f.memory.state()).candidates.length, 0);
  assert.match((await f.workspace.files())["MEMORY.md"], /forgotten at user request/);
  assert.equal((await f.workspace.files())["skills/verify-project/SKILL.md"], undefined);
});

test("user workspace edits are consolidated even with no new rollout, including a fresh library", async t => {
  const f = await fixture(t);
  await f.workspace.publish({ "extensions/ad_hoc/notes/manual.md": "Remember the new user preference." }, new AbortController().signal);
  await writeFile(join(f.workspace.directory, "extensions/ad_hoc/notes/manual.md"), "Update: use the corrected preference.");
  await f.scheduler.tick();
  assert.ok((await f.workspace.files())["MEMORY.md"]);
  assert.equal(f.requests.filter(request => request.metadata.purpose === "memory-curation").length, 0);
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes("corrected preference")));
});

test("a committed plan recovers file publication without repeating model work", async t => {
  const f = await fixture(t); let fail = true;
  const real = f.base.consolidator;
  const scheduler = new MemoryCurationScheduler({ ...f.base, consolidator: {
    consolidate: (...args) => real.consolidate(...args), inputFingerprint: () => real.inputFingerprint(),
    publish: (...args) => { if (fail) { fail = false; throw new Error("crash before mirror publication"); } return real.publish(...args); },
  } });
  scheduler.registerSource({ id: "fixture", scan: async () => [f.evidence] });
  await scheduler.scan(); await scheduler.tick();
  assert.ok((await f.store.read()).consolidation); assert.ok((await f.memory.state()).documents.length);
  const calls = f.requests.length; await scheduler.close();
  await f.scheduler.recover(); await f.scheduler.tick();
  assert.equal(f.requests.length, calls);
  assert.equal((await f.scheduler.state()).consolidation, undefined);
  assert.ok((await f.workspace.files())["MEMORY.md"]);
});

test("only citations to exact source paths update usage after a foreground Run", async () => {
  const id = `curation-${"a".repeat(64)}`, used = [], done = Promise.withResolvers();
  const feature = createCurationTrigger({ wake() {}, async recordUsage(ids) { used.push(...ids); } }, {});
  await feature.runStarted({ async readSessionHistory() { return { records: [
    { kind: "message", runId: "run", message: { role: "assistant", content: `<wish-memory-citation>rollout_summaries/${id}.md</wish-memory-citation>` } },
    { kind: "message", runId: "other", message: { role: "assistant", content: `<wish-memory-citation>rollout_summaries/curation-${"b".repeat(64)}.md</wish-memory-citation>` } },
  ] }; } }, { scope: "session", runId: "run", completion: done.promise }, { inputSource: "user", text: "Continue" });
  done.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(used, [id]);
});

test("workspace rejects path escapes and symlinks", async t => {
  const f = await fixture(t); await f.workspace.publish({ "MEMORY.md": "safe" }, new AbortController().signal);
  await symlink(join(f.directory, "store"), join(f.workspace.directory, "escape"));
  await assert.rejects(f.workspace.files(), /symlink/);
  await rm(join(f.workspace.directory, "escape"));
  await assert.rejects(f.workspace.publish({ "../outside": "bad" }, new AbortController().signal), /workspace path/);
  assert.equal(await readFile(join(f.workspace.directory, "MEMORY.md"), "utf8"), "safe");
  await rm(join(f.workspace.directory, ".baseline.json"));
  await symlink(join(f.workspace.directory, "MEMORY.md"), join(f.workspace.directory, ".baseline.json"));
  await assert.rejects(f.workspace.baseline(), /symlink/);
});

test("cited memories survive the unused window and later expire without new rollouts", async t => {
  const start = Date.now(); let now = start;
  const f = await fixture(t, { now: () => new Date(now) });
  await f.scheduler.scan(); await f.scheduler.tick();
  const id = (await f.scheduler.state()).jobs[0].id;
  now += 29 * 86_400_000; await f.scheduler.recordUsage([id]);
  now += 2 * 86_400_000; await f.scheduler.tick();
  assert.ok((await f.workspace.files())[`rollout_summaries/${id}.md`]);
  now += 29 * 86_400_000;
  f.controls.output = { memory: "No currently retained source.", citeSources: false, remove: ["skills/verify-project"] };
  await f.scheduler.tick();
  assert.equal((await f.workspace.files())[`rollout_summaries/${id}.md`], undefined);
  assert.equal((await f.scheduler.state()).jobs.length, 0);
});

test("publication recovery preserves edits made after the memory commit", async t => {
  const f = await fixture(t); await f.scheduler.scan(); await f.scheduler.tick();
  const baseline = await f.workspace.files(), next = { ...baseline, "MEMORY.md": "Prepared automatic revision" };
  await writeFile(join(f.workspace.directory, "MEMORY.md"), "New user edit made after the commit");
  await f.workspace.publish(next, new AbortController().signal, baseline);
  assert.equal((await f.workspace.files())["MEMORY.md"], "New user edit made after the commit");
  assert.notEqual(await f.workspace.inputFingerprint(), hash({}), "the preserved edit remains work for the next consolidation");
});

test("new session snapshots replace older ones at equal timestamps, including empty extraction", async t => {
  const f = await fixture(t, { sourceId: "runtime-sessions" });
  f.evidence.sessionId = "session";
  f.evidence.references = [{ kind: "session", id: "session", revision: "1", digest: hash("one"), throughSequence: 1 }];
  await f.scheduler.scan(); await f.scheduler.tick();
  const first = (await f.scheduler.state()).jobs[0].id;
  f.evidence.id = "source-2"; f.evidence.text += "\nUser: another task.";
  f.evidence.references = [{ ...f.evidence.references[0], revision: "2", digest: hash("two"), throughSequence: 2 }];
  await f.scheduler.scan(); await f.scheduler.tick();
  const second = (await f.scheduler.state()).jobs[0].id;
  assert.notEqual(second, first);
  assert.equal((await f.workspace.files())[`rollout_summaries/${first}.md`], undefined);
  assert.ok((await f.workspace.files())[`rollout_summaries/${second}.md`]);
  f.evidence.id = "source-3"; f.evidence.text += "\nUser: nothing reusable.";
  f.evidence.references = [{ ...f.evidence.references[0], revision: "3", digest: hash("three"), throughSequence: 3 }];
  f.controls.extraction = { raw_memory: "", rollout_summary: "", rollout_slug: "" };
  f.controls.output = { memory: "No reusable source remains.", citeSources: false, remove: ["skills/verify-project"] };
  await f.scheduler.scan(); await f.scheduler.tick();
  const state = await f.scheduler.state();
  assert.equal(state.jobs.length, 1); assert.deepEqual(state.jobs[0].rawMemories, []);
  assert.deepEqual(state.selectedJobIds, []);
  assert.equal((await f.workspace.files())[`rollout_summaries/${second}.md`], undefined);
  assert.deepEqual(state.retiredEvidenceIds, ["source-1", "source-2"]);
});

test("manual edits and deletion of explicit notes remain authoritative across later consolidations", async t => {
  const f = await fixture(t);
  const receipt = await f.scheduler.addNote({ operationId: "original", text: "Original preference", evidence: [origin] });
  await f.scheduler.tick();
  const path = `extensions/ad_hoc/notes/${receipt.noteId}.md`;
  await writeFile(join(f.workspace.directory, path), "Corrected preference");
  await f.scheduler.tick();
  assert.equal((await f.workspace.files())[path], "Corrected preference");
  assert.match((await f.workspace.files())["raw_memories.md"], /Corrected preference/);
  await rm(join(f.workspace.directory, path));
  await f.scheduler.tick();
  await f.scheduler.addNote({ operationId: "another", text: "An unrelated later preference", evidence: [origin] });
  await f.scheduler.tick();
  assert.equal((await f.workspace.files())[path], undefined);
  assert.doesNotMatch((await f.workspace.files())["raw_memories.md"], /Original preference|Corrected preference/);
});
