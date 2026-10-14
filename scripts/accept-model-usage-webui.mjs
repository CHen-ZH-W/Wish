import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { WebUiControlError } from "../dist/apps/webui/controls.js";
import { projectSessionModelUsage } from "../dist/models/pricing/consumers/webui-control.js";
import { ModelUsageClientModel } from "../dist/models/pricing/consumers/webui/model.js";
import { ModelUsageStatus, formatPercent } from "../dist/models/pricing/consumers/webui/view.js";

const model = Object.freeze({ provider: "deepseek", model: "deepseek-chat" });
function attempt(id, usage, status = "completed") {
  return Object.freeze({ schemaVersion: 1, attemptId: id, sessionId: "session-a", runId: "run-a",
    userTurnId: "turn-a", stepId: `step-${id}`, requestedAt: "2026-10-10T00:00:00.000Z",
    requestedModel: model, status, ...(status === "running" ? {} : { endedAt: "2026-10-10T00:00:01.000Z" }),
    ...(usage === undefined ? {} : { usage }) });
}
const usage = (inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens = 10) => ({ inputTokens,
  ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  outputTokens, totalTokens: inputTokens + outputTokens, source: "provider" });

test("Models projects a complete Session cache rate from durable completed attempts", () => {
  const view = projectSessionModelUsage("session-a", [
    attempt("one", usage(1_000, 700, 100, 50)),
    attempt("two", usage(500, 300, 50, 25)),
    attempt("running", undefined, "running"),
  ]);
  assert.equal(view.coverage, "complete");
  assert.equal(view.cacheHitRatio, 2 / 3);
  assert.deepEqual(view.attempts, { completed: 2, usageReported: 2, cacheReadReported: 2, cacheWriteReported: 2 });
  assert.deepEqual(view.tokens, { input: 1_500, output: 75, total: 1_575,
    cachedInput: 1_000, cacheWriteInput: 150, uncachedInput: 350 });
  assert.equal(Object.isFrozen(view.tokens), true);
});

test("missing Provider cache fields stay partial or unavailable instead of becoming zero", () => {
  const partial = projectSessionModelUsage("session-a", [
    attempt("known", usage(100, 80, undefined)),
    attempt("unknown-cache", usage(100, undefined, undefined)),
    attempt("unknown-usage", undefined),
  ]);
  assert.equal(partial.coverage, "partial");
  assert.equal(partial.cacheHitRatio, 0.8);
  assert.equal(partial.tokens.cachedInput, 80);
  assert.equal(partial.tokens.cacheWriteInput, undefined);
  assert.deepEqual(partial.attempts, { completed: 3, usageReported: 2, cacheReadReported: 1, cacheWriteReported: 0 });

  const unavailable = projectSessionModelUsage("session-a", [attempt("unknown", usage(200, undefined, undefined))]);
  assert.equal(unavailable.coverage, "unavailable");
  assert.equal(unavailable.cacheHitRatio, undefined);
  assert.equal(unavailable.tokens.cachedInput, undefined);
});

test("inconsistent or unsafe aggregates fail closed", () => {
  assert.throws(() => projectSessionModelUsage("session-a", [attempt("bad-read", usage(10, 11, undefined))]),
    error => error instanceof WebUiControlError && error.code === "model_usage_unavailable");
  assert.throws(() => projectSessionModelUsage("session-a", [attempt("bad", usage(10, 8, 4))]),
    error => error instanceof WebUiControlError && error.code === "model_usage_unavailable");
  assert.throws(() => projectSessionModelUsage("session-a", [attempt("huge", usage(Number.MAX_SAFE_INTEGER, 0, 0)), attempt("overflow", usage(1, 0, 0))]),
    error => error instanceof WebUiControlError && error.code === "model_usage_unavailable");
});

test("usage observer refreshes on Session selection and terminal model events", async () => {
  const requests = [];
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a", error: null });
  connection.onInvalidation = () => () => {};
  connection.request = async path => { requests.push(path); return { value: projectSessionModelUsage("session-a", [attempt("one", usage(100, 75, undefined))]) }; };
  const sessions = new SnapshotStore({ selectedId: "session-a" });
  sessions.run = new SnapshotStore({ runId: "run-a", events: [], terminal: false });
  const observer = new ModelUsageClientModel(connection, sessions);
  try {
    await observer.refresh();
    assert.equal(observer.getSnapshot().view.cacheHitRatio, 0.75);
    const before = requests.length;
    sessions.run.publish({ runId: "run-a", terminal: false, events: [{ type: "model.stream", payload: { type: "done" } }] });
    await observer.refresh();
    assert.ok(requests.length > before);
    assert.match(requests.at(-1), /\/api\/sessions\/session-a\/controls\/model-usage$/u);
    sessions.publish({ selectedId: "session-b" });
    assert.equal(observer.getSnapshot().sessionId, "session-b");
    assert.equal(observer.getSnapshot().view, null);
  } finally { observer.close(); }
});

test("Session status seat unplugs cleanly and compact UI exposes partial coverage", () => {
  const slots = new UiSlots();
  const remove = slots.sessionStatus({ id: "model-usage", View: () => null });
  assert.deepEqual(slots.getSnapshot().sessionStatusItems.map(item => item.id), ["model-usage"]);
  remove();
  assert.deepEqual(slots.getSnapshot().sessionStatusItems, []);

  const view = projectSessionModelUsage("session-a", [attempt("known", usage(100, 80, undefined)), attempt("unknown", usage(100, undefined, undefined))]);
  const store = new SnapshotStore({ sessionId: "session-a", view, loading: false, error: null });
  const html = renderToStaticMarkup(createElement(ModelUsageStatus, { model: store, sessionId: "session-a" }));
  assert.match(html, /缓存命中 80% · 部分/u);
  assert.match(html, /缓存明细/u);
  assert.equal(formatPercent(1, "zh-CN"), "100%");
  assert.equal(formatPercent(2 / 3, "zh-CN"), "67%");
  assert.notEqual(formatPercent(0.99999, "zh-CN"), "100%");
});
