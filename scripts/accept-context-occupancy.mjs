import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { ContextOccupancyStore } from "../dist/context/occupancy-store.js";
import { captureContextOccupancy, estimateContextMessage, projectContextOccupancy } from "../dist/context/occupancy.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import { calculateModelCost } from "../dist/models/usage.js";

const model = { provider: "fixture", model: "primary" };
const capturedAt = "2026-10-20T00:00:00.000Z";
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
function facts(overrides = {}) {
  return { sessionId: "session-a", runId: "run-a", userTurnId: "turn-a", stepId: "step-a", model,
    workspace: { cwd: "/workspace", fingerprint: "workspace", revision: "revision", instructions: [] },
    runtime: { capturedAt, stateVersion: 1, stepOrdinal: 1, userTurnOrdinal: 1 }, ...overrides };
}
function request(overrides = {}) {
  return { model, instructions: [{ role: "system", content: "private system text" }],
    messages: [{ role: "user", content: "question" }],
    tools: [{ name: "lookup", description: "private Tool description", inputSchemaJson: '{"type":"object"}' }], ...overrides };
}
function history(records = [], sessionId = "session-a") { return { sessionId, historyRevision: String(records.length), records }; }
function projection(source = request(), budget = {}) {
  return { status: "ready", request: source, budget: { status: "unknown", inputLimitTokens: 900,
    details: { contextWindowTokens: 1000, reservedOutputTokens: 100 }, ...budget } };
}
function snapshot({ input = facts(), source = request(), budget = {}, records = [], prior = [], at = capturedAt } = {}) {
  return captureContextOccupancy(input, projection(source, budget), history(records, input.sessionId), prior, at);
}
function attempt(id = "attempt-a", overrides = {}) {
  return { schemaVersion: 1, ...facts(), attemptId: id, requestedModel: model, status: "completed",
    requestedAt: "2026-10-20T00:00:01.000Z", endedAt: "2026-10-20T00:00:02.000Z",
    usage: { inputTokens: 400, cachedInputTokens: 300, outputTokens: 10, totalTokens: 410, source: "provider" }, ...overrides };
}
function message(sequence, content, overrides = {}) {
  return { schemaVersion: 1, kind: "message", sequence, recordId: `record-${sequence}`, idempotencyKey: `message-${sequence}`,
    runId: "run-a", userTurnId: "turn-a", stepId: "step-a", origin: "assistant", createdAt: capturedAt,
    message: { role: "assistant", content }, ...overrides };
}

test("the meter is a labeled heuristic with model window and separate component estimates", () => {
  const first = snapshot(), view = projectContextOccupancy("session-a", [first], [], history());
  assert.equal(view.source, "estimated");
  assert.equal(view.usedTokens, first.breakdown.systemTokens + first.breakdown.toolsTokens + first.breakdown.messageTokens);
  assert.equal(view.contextWindow, 1000); assert.equal(view.inputLimitTokens, 900);
  assert.equal(view.ratio, view.usedTokens / 1000); assert.equal(view.remainingTokens, 1000 - view.usedTokens);
  assert.deepEqual(view.model, model); assert.match(view.countMethod, /character-estimate/u);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /private system text|private Tool description|question/u);
});

test("provider calibration uses this request's normalized input once and estimates later message growth or shrinkage", () => {
  const first = snapshot();
  const initial = projectContextOccupancy("session-a", [first], [attempt()], history());
  assert.equal(initial.source, "provider-anchored"); assert.equal(initial.usedTokens, 400, "cache read is already included");
  const second = snapshot({ input: facts({ stepId: "step-b" }), source: request({ messages: [
    { role: "user", content: "question" }, { role: "assistant", content: "answer text" }, { role: "tool", content: "result" },
  ] }), at: "2026-10-20T00:00:03.000Z" });
  const view = projectContextOccupancy("session-a", [first, second], [attempt()], history());
  assert.equal(view.source, "provider-anchored");
  assert.equal(view.usedTokens, 400 + second.breakdown.messageTokens - first.breakdown.messageTokens);
  const shorter = snapshot({ input: facts({ stepId: "step-c" }), source: request({ messages: [] }), at: "2026-10-20T00:00:04.000Z" });
  assert.equal(projectContextOccupancy("session-a", [first, shorter], [attempt()], history()).usedTokens,
    400 + shorter.breakdown.messageTokens - first.breakdown.messageTokens);
});

test("model, billed model, system, tools and budget configuration changes invalidate old anchors", () => {
  const first = snapshot();
  for (const source of [request({ model: { provider: "other", model: "primary" } }), request({ instructions: [] }), request({ tools: [] }), request({ maxOutputTokens: 123 })]) {
    const next = snapshot({ input: facts({ stepId: "step-b" }), source });
    assert.equal(projectContextOccupancy("session-a", [first, next], [attempt()], history()).source, "estimated");
  }
  const changedBudget = snapshot({ input: facts({ stepId: "step-b" }), budget: { details: { contextWindowTokens: 2000, reservedOutputTokens: 100 } } });
  assert.equal(projectContextOccupancy("session-a", [first, changedBudget], [attempt()], history()).source, "estimated");
  assert.equal(projectContextOccupancy("session-a", [first], [attempt("alias", { billedModel: { provider: "fixture", model: "other" } })], history()).source, "estimated");
  for (const overrides of [{ sessionId: "session-b" }, { stepId: "other" }, { status: "failed" }, { usage: { inputTokens: 999, source: "estimated" } }]) {
    assert.equal(projectContextOccupancy("session-a", [first], [attempt("ineligible", overrides)], history()).source, "estimated");
  }
});

test("same-Step auxiliary/compaction attempts existing at projection cannot become its Provider anchor", () => {
  const prior = attempt("summary");
  const first = snapshot({ prior: [prior], at: "2026-10-20T00:00:03.000Z" });
  assert.equal(projectContextOccupancy("session-a", [first], [prior], history()).source, "estimated");
  const dispatched = attempt("main", { requestedAt: "2026-10-20T00:00:04.000Z", endedAt: "2026-10-20T00:00:05.000Z" });
  assert.equal(projectContextOccupancy("session-a", [first], [prior, dispatched], history()).usedTokens, 400);
});

test("new assistant/Tool results are counted once; already projected current user input is not duplicated", () => {
  const first = snapshot();
  const answer = message(2, "answer"), result = message(3, "result", { origin: "tool", message: { role: "tool", content: "result", toolCallId: "lookup-1" } });
  const records = [message(1, "question", { origin: "user_input", message: { role: "user", content: "question" } }), answer, result];
  const view = projectContextOccupancy("session-a", [first], [attempt()], history(records));
  assert.equal(view.usedTokens, 400 + estimateContextMessage(answer.message) + estimateContextMessage(result.message));
  const next = snapshot({ input: facts({ stepId: "step-b" }), source: request({ messages: records.map(record => record.message) }), records });
  const nextAttempt = attempt("second", { stepId: "step-b", requestedAt: "2026-10-20T00:00:03.000Z", endedAt: "2026-10-20T00:00:04.000Z" });
  assert.equal(projectContextOccupancy("session-a", [first, next], [attempt(), nextAttempt], history(records)).usedTokens, 400);
});

test("missing projections, rejected requests, post-projection compaction and unknown image sizes never fabricate zero", () => {
  const absent = projectContextOccupancy("session-a", [], [], history());
  assert.equal(absent.status, "unknown"); assert.equal(absent.usedTokens, undefined); assert.equal(absent.ratio, undefined);
  const first = snapshot();
  const checkpoint = { kind: "checkpoint", sequence: 1 };
  assert.equal(projectContextOccupancy("session-a", [first], [attempt()], history([checkpoint])).reason, "context_changed_after_projection");
  const rejected = captureContextOccupancy(facts(), { status: "rejected", candidateRequest: request(), budget: projection().budget }, history(), [], capturedAt);
  assert.equal(projectContextOccupancy("session-a", [first, rejected], [attempt()], history()).reason, "context_request_rejected");
  const image = snapshot({ source: request({ messages: [{ role: "user", content: "question", contentParts: [
    { type: "text", text: "question" }, { type: "image_url", imageUrl: { url: "https://private.invalid/image" } },
  ] }] }) });
  assert.equal(projectContextOccupancy("session-a", [image], [], history()).usedTokens, undefined);
  assert.equal(projectContextOccupancy("session-a", [image], [attempt()], history()).usedTokens, 400);
  assert.doesNotMatch(JSON.stringify(image), /private.invalid/u);
  const missingWindow = snapshot({ budget: { details: {}, inputLimitTokens: undefined } });
  const view = projectContextOccupancy("session-a", [missingWindow], [], history());
  assert.equal(view.source, "estimated"); assert.equal(view.contextWindow, undefined); assert.equal(view.ratio, undefined);
});

test("a preflight count takes precedence without changing the hard budget object", () => {
  const budget = { status: "within_budget", estimatedInputTokens: 150, inputLimitTokens: 900,
    details: { contextWindowTokens: 1000, reservedOutputTokens: 100, countMethod: "fixture-counter" } };
  const before = JSON.stringify(budget), first = snapshot({ budget });
  const view = projectContextOccupancy("session-a", [first], [attempt()], history());
  assert.equal(view.source, "preflight"); assert.equal(view.usedTokens, 150); assert.equal(view.countMethod, "fixture-counter");
  assert.equal(JSON.stringify(budget), before);
});

test("File KV survives replacement and keeps Session identity, bounded snapshots and deletion separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-occupancy-store-"));
  const backend = new FileStorageBackend({ rootDirectory: directory });
  const resolver = { backend(id) { assert.equal(id, "file"); return backend; } };
  try {
    let store = new ContextOccupancyStore(resolver, "file");
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.record(snapshot({ input: facts({ stepId: `step-${index}` }) }))));
    await store.record(snapshot({ input: facts({ sessionId: "session-b" }) }));
    store = new ContextOccupancyStore(resolver, "file");
    assert.equal((await store.get("session-a")).length, 20); assert.equal((await store.get("session-a"))[0].stepId, "step-5");
    assert.equal((await store.get("session-b")).length, 1);
    await store.clear("session-a"); assert.deepEqual(await store.get("session-a"), []);
    assert.equal((await store.get("session-b")).length, 1);
  } finally { await backend.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the product Cordis graph observes requests, persists through reload/restart and purges with its Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-occupancy-product-"));
  const configurationFile = join(directory, "cordis.yml"), modelsFile = join(directory, "models.json");
  await writeFile(configurationFile, await readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"));
  await writeFile(modelsFile, JSON.stringify({ schemaVersion: 1, defaultModel: "fixture/primary", maxRetries: 0,
    providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid/v1", auth: { type: "none" }, developerRoleMode: "native",
      models: [{ id: "primary", status: "active", contextWindowTokens: 1000, maxOutputTokens: 100,
        input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] }));
  let booted, bundle;
  const boot = () => bootstrap({ surface: "cli", argv: ["--version"], cwd: repositoryRoot, homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data") }, configurationFile });
  try {
    booted = await boot(); assert.equal(await booted.completion, 0);
    let ctx = booted.surfaceContext;
    const application = await ctx.get("application").open({ modelsConfigurationPath: modelsFile });
    const session = await application.createSession({ sessionId: "occupancy-session", workspaceRoot: directory });
    const input = facts({ sessionId: session.sessionId });
    bundle = ctx.get("contextEngine").open({ dataDirectory: ctx.get("sessions").dataDirectory,
      models: { configuredModel: { getContextWindowTokens: () => 1000 }, requestCounter: { count: () => undefined } },
      configuration: { reservedOutputTokens: 100 } });
    await bundle.projector.projectFromProviders({ request: request(), providers: [], providerInput: input, currentUserMessageIndex: 0 });
    const initial = await ctx.get("contextOccupancy").inspect(session.sessionId);
    assert.equal(initial.source, "estimated"); assert.ok(initial.usedTokens > 0);
    const ledger = ctx.get("modelAttemptLedger");
    await ledger.start({ attemptId: "occupancy-attempt", sessionId: session.sessionId,
      runId: input.runId, userTurnId: input.userTurnId, stepId: input.stepId,
      requestedAt: new Date().toISOString(), requestedModel: model });
    const usage = { inputTokens: 400, cachedInputTokens: 300, outputTokens: 10, totalTokens: 410, source: "provider" };
    await ledger.finish({ attemptId: "occupancy-attempt", status: "completed", endedAt: new Date().toISOString(), billedModel: model,
      usage, cost: calculateModelCost({ model, usage }) });
    const before = await ctx.get("contextOccupancy").inspect(session.sessionId);
    assert.equal(before.source, "provider-anchored"); assert.equal(before.usedTokens, 400);
    assert.equal((await ctx.get("contextOccupancy").inspect((await application.createSession({ sessionId: "occupancy-other", workspaceRoot: directory })).sessionId)).status, "unknown");
    const oldService = ctx.get("contextOccupancy");
    await booted.context.loader.update("include:context-occupancy", { disabled: true });
    assert.equal(ctx.get("contextOccupancy"), undefined);
    await assert.rejects(() => oldService.inspect(session.sessionId), /closed/u);
    await booted.context.loader.update("include:context-occupancy", { disabled: false });
    await booted.context.loader.resolve("include:context-occupancy").fiber.await();
    assert.equal((await ctx.get("contextOccupancy").inspect(session.sessionId)).usedTokens, before.usedTokens);
    bundle.release(); bundle = undefined;
    await booted.dispose(); booted = await boot(); assert.equal(await booted.completion, 0);
    ctx = booted.surfaceContext;
    assert.equal((await ctx.get("contextOccupancy").inspect(session.sessionId)).usedTokens, before.usedTokens);
    const restarted = await ctx.get("application").open({ modelsConfigurationPath: modelsFile });
    await restarted.deleteSession({ sessionId: session.sessionId });
    const kv = ctx.get("storageBackend").resolve(ctx.get("storageBackend").id, "kv");
    assert.equal((await kv.list({ namespace: "context-occupancy" })).some(item => item.key === session.sessionId), false);
    assert.equal((await ctx.get("contextOccupancy").inspect("occupancy-other")).status, "unknown");
  } finally { bundle?.release(); await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
