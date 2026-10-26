import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { ClientApiError } from "../dist/apps/webui/client/connection.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { ModelUsageClientUi } from "../dist/models/pricing/consumers/webui/index.js";
import { ModelUsageClientModel } from "../dist/models/pricing/consumers/webui/model.js";
import { ModelCostStatus, formatCost, periodLabel } from "../dist/models/pricing/consumers/webui/cost-view.js";

const currency = (patch = {}) => ({ currency: "CNY", totalCost: 0.0123, uncachedInputCost: 0.003,
  cachedInputCost: 0.0001, cacheWriteInputCost: 0, outputCost: 0.0092, estimated: false, attempts: 2,
  periods: [{ period: "peak", totalCost: 0.01, attempts: 1, estimated: false },
    { period: "off_peak", totalCost: 0.0023, attempts: 1, estimated: false }], ...patch });
const cost = (patch = {}) => ({ coverage: "complete", settledAttempts: 2, pricedAttempts: 2,
  unavailableAttempts: 0, runningAttempts: 0, currencies: [currency()], ...patch });
const view = (sessionId = "session-a", patch = {}) => ({ schemaVersion: 1, scope: "session", sessionId,
  coverage: "complete", attempts: { completed: 2, usageReported: 2, cacheReadReported: 2, cacheWriteReported: 0 },
  tokens: { input: 10_000_000, output: 200, total: 10_000_200, cachedInput: 1_000_000 },
  cacheHitRatio: 0.1, cost: cost(), ...patch });
const render = (value, sessionId = "session-a") => renderToStaticMarkup(createElement(ModelCostStatus, {
  model: new SnapshotStore({ sessionId: "session-a", view: value, loading: false, error: null }), sessionId,
}));
const stream = (sequence, type) => ({ sequence, type: "model.stream", payload: { type } });
const transition = (sequence, type) => ({ sequence, type: "runtime.transition", payload: { type } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(request = async path => ({ value: view(path.includes("session-b") ? "session-b" : "session-a") })) {
  const requests = [], invalidations = new Set();
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a", error: null });
  connection.onInvalidation = listener => { invalidations.add(listener); return () => invalidations.delete(listener); };
  connection.request = path => { requests.push(path); return request(path); };
  const sessions = new SnapshotStore({ selectedId: "session-a", sessions: [{ sessionId: "session-a", historyRevision: "r1" }] });
  sessions.run = new SnapshotStore({ runId: "run-a", events: [], terminal: false });
  return { connection, sessions, requests, invalidations };
}

test("cost formatting preserves positive sub-unit costs, currencies, known zero and unknown values", () => {
  assert.equal(formatCost(0.0123, "CNY", "zh-CN"), "¥0.0123");
  assert.equal(formatCost(0.00000001, "CNY", "zh-CN"), "<¥0.0001");
  assert.equal(formatCost(0, "CNY", "zh-CN"), "¥0");
  assert.match(formatCost(2.5, "USD", "en-US"), /\$2\.5/u);
  assert.equal(formatCost(NaN, "CNY", "zh-CN"), "—");
  assert.equal(formatCost(-1, "CNY", "zh-CN"), "—");
  assert.equal(periodLabel("peak", "zh-CN"), "峰时");
  assert.equal(periodLabel("off_peak", "en-US"), "Off-peak");
  assert.equal(periodLabel("flat", "zh-CN"), "固定价");
  assert.equal(periodLabel("unknown", "zh-CN"), "时段未记录");
  assert.equal(periodLabel("future-period", "en-US"), "future-period");
});

test("the fee seat renders persisted cost and request-period breakdown through a native popover", () => {
  const html = render(view());
  assert.match(html, /费用 ¥0\.0123/u);
  assert.match(html, /本会话累计费用/u);
  assert.match(html, /popover="auto" role="dialog"/u);
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/u);
  for (const text of ["未缓存输入", "缓存读取", "缓存写入", "输出", "峰时", "谷时", "按请求当时的用量与价格计算", "账户账单以服务商为准"]) {
    assert.ok(html.includes(text), text);
  }
  // Token totals deliberately bear no relationship to the persisted cost fixture.
  assert.doesNotMatch(html, /10,000,000/u);
  assert.equal(render(view(), "session-b"), "");
  assert.equal(render(null), "");
});

test("partial and estimated costs disclose missing/running requests and keep currencies separate", () => {
  const html = render(view("session-a", { cost: cost({ coverage: "partial", settledAttempts: 3,
    unavailableAttempts: 1, runningAttempts: 1, currencies: [currency({ estimated: true }),
      currency({ currency: "USD", totalCost: 0.02, periods: [{ period: "flat", totalCost: 0.02, attempts: 1, estimated: true }] })] }) }));
  for (const text of ["费用 约 ¥0.0123", "部分", "CNY", "USD", "固定价", "含估算费用", "费用缺失", "请求进行中", "不含费用缺失", "结算后计入"]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /0\.0323/u);
});

test("legacy Hosts and absent pricing show an unavailable cost instead of inventing zero", () => {
  const { cost: ignored, ...legacy } = view();
  assert.match(render(legacy), /费用 —/u);
  assert.match(render(legacy), /费用暂不可用/u);
  const empty = render(view("session-a", { cost: cost({ coverage: "unavailable", settledAttempts: 0,
    pricedAttempts: 0, runningAttempts: 1, currencies: [] }) }));
  assert.match(empty, /费用 —/u);
  assert.match(empty, /尚无可计费的已结算请求/u);
  assert.doesNotMatch(empty, /¥0/u);
  assert.match(render(view("session-a", { cost: cost({ currencies: [currency({ totalCost: 0 })] }) })), /费用 ¥0/u);
});

test("usage and fee seats share one observer and release both seats and subscriptions together", () => {
  const f = fixture(), slots = new UiSlots(), disposers = [];
  ModelUsageClientUi.apply({ wishConnection: f.connection, wishSession: f.sessions, wishUiSlots: slots,
    effect: register => { disposers.push(register()); } });
  assert.deepEqual(slots.getSnapshot().sessionStatusItems.map(item => item.id), ["model-usage", "model-cost"]);
  assert.equal(f.invalidations.size, 1);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(f.invalidations.size, 0);
  assert.deepEqual(slots.getSnapshot().sessionStatusItems, []);
});

test("settlement and history refresh fees after stream completion without fetching each text token", async () => {
  const f = fixture(), observer = new ModelUsageClientModel(f.connection, f.sessions);
  try {
    await observer.refresh();
    const initial = f.requests.length;
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [stream(1, "start")] });
    await tick();
    assert.equal(f.requests.length, initial + 1);
    const afterStart = f.requests.length;
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [stream(1, "start"), stream(2, "text"), stream(3, "text")] });
    await tick();
    assert.equal(f.requests.length, afterStart);
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [stream(1, "start"), stream(2, "text"), stream(3, "text"), stream(4, "done")] });
    await tick();
    const afterDone = f.requests.length;
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [stream(1, "start"), stream(2, "text"), stream(3, "text"), stream(4, "done"), transition(5, "step.completed")] });
    await tick();
    assert.equal(f.requests.length, afterDone + 1);
    const afterStep = f.requests.length;
    f.sessions.publish({ ...f.sessions.getSnapshot(), sessions: [{ sessionId: "session-a", historyRevision: "r2" }] });
    await tick();
    assert.equal(f.requests.length, afterStep + 1);
    assert.match(f.requests.at(-1), /\/controls\/model-usage$/u);
  } finally { observer.close(); }
});

test("stale Session responses and Host generations cannot restore a previous fee", async () => {
  let release;
  const f = fixture(path => path.includes("session-a")
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ value: view("session-b") }));
  const observer = new ModelUsageClientModel(f.connection, f.sessions);
  try {
    f.sessions.publish({ selectedId: "session-b", sessions: [{ sessionId: "session-b", historyRevision: "r1" }] });
    assert.equal(observer.getSnapshot().view, null);
    release({ value: view() });
    await observer.refresh();
    assert.equal(observer.getSnapshot().view.sessionId, "session-b");
    f.connection.publish({ ...f.connection.getSnapshot(), instanceId: "host-b" });
    assert.equal(observer.getSnapshot().view, null);
    await observer.refresh();
    assert.equal(observer.getSnapshot().view.sessionId, "session-b");
    f.connection.publish({ ...f.connection.getSnapshot(), online: false });
    assert.equal(observer.getSnapshot().sessionId, null);
    assert.equal(observer.getSnapshot().view, null);
  } finally { observer.close(); }
});

test("failed or mismatched refreshes retain verified fees while explicit revocation clears them", async () => {
  let response = view();
  let failure;
  const f = fixture(async () => { if (failure) throw failure; return { value: response }; }), observer = new ModelUsageClientModel(f.connection, f.sessions);
  await observer.refresh();
  assert.equal(observer.getSnapshot().view.cost.currencies[0].totalCost, 0.0123);
  const verified = observer.getSnapshot().view;
  response = view("other-session");
  await observer.refresh();
  assert.equal(observer.getSnapshot().view, verified);
  assert.ok(observer.getSnapshot().error);
  failure = new ClientApiError("model_usage_unavailable", 503);
  await observer.refresh();
  assert.equal(observer.getSnapshot().view, verified);
  assert.equal(observer.getSnapshot().error, "model_usage_unavailable");
  // Reconciliation can legitimately revise cumulative usage or fees downward.
  failure = undefined;
  response = view("session-a", { cost: cost({ currencies: [currency({ totalCost: 0.001 })] }) });
  await observer.refresh();
  assert.equal(observer.getSnapshot().view.cost.currencies[0].totalCost, 0.001);
  assert.equal(observer.getSnapshot().error, null);
  for (const [code, status] of [["control_not_found", 404], ["session_not_found", 404], ["forbidden", 403], ["unauthorized", 401]]) {
    failure = new ClientApiError(code, status);
    await observer.refresh();
    assert.equal(observer.getSnapshot().view, null);
    failure = undefined;
    await observer.refresh();
    assert.equal(observer.getSnapshot().view.sessionId, "session-a");
  }
  observer.close();
  const before = f.requests.length;
  f.sessions.run.publish({ runId: "run-a", terminal: true, events: [transition(1, "run.completed")] });
  await observer.refresh();
  assert.equal(f.requests.length, before);
});
