import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { ClientApiError } from "../dist/apps/webui/client/connection.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { ContextOccupancyClientUi } from "../dist/context/consumers/webui/index.js";
import { ContextOccupancyClientModel } from "../dist/context/consumers/webui/model.js";
import { ContextOccupancyStatus, contextOccupancy } from "../dist/context/consumers/webui/view.js";

const view = (sessionId = "session-a", patch = {}) => ({
  schemaVersion: 1, sessionId, status: "estimated", source: "estimated", usedTokens: 32_000, contextWindow: 128_000,
  breakdown: { systemTokens: 1_000, toolsTokens: 3_000, messageTokens: 28_000 },
  model: { provider: "example", model: "fixture-model" }, capturedAt: "2026-10-20T00:00:00.000Z", ...patch,
});
function fixture(request = async path => ({ value: view(path.includes("session-b") ? "session-b" : "session-a") })) {
  const requests = [], invalidations = new Set();
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a", error: null });
  connection.onInvalidation = listener => { invalidations.add(listener); return () => invalidations.delete(listener); };
  connection.request = path => { requests.push(path); return request(path); };
  const sessions = new SnapshotStore({ selectedId: "session-a", sessions: [{ sessionId: "session-a", historyRevision: "r1" }] });
  sessions.run = new SnapshotStore({ runId: "run-a", events: [], terminal: false });
  return { connection, sessions, requests, invalidations };
}
const streamEvent = (sequence, type) => ({ sequence, type: "model.stream", payload: { type } });
const transition = (sequence, type) => ({ sequence, type: "runtime.transition", payload: { type } });

test("Context display distinguishes unknown counts from a measured zero and bounds only the gauge", () => {
  assert.equal(contextOccupancy(null), null);
  for (const patch of [{ status: "unknown" }, { usedTokens: undefined }, { contextWindow: undefined },
    { contextWindow: 0 }, { usedTokens: NaN }, { usedTokens: -1 }]) {
    assert.equal(contextOccupancy(view("session-a", patch)), null);
  }
  assert.deepEqual(contextOccupancy(view("session-a", { usedTokens: 0 })), { usedTokens: 0, contextWindow: 128_000, percent: 0 });
  assert.deepEqual(contextOccupancy(view("session-a", { usedTokens: 160_000 })), { usedTokens: 160_000, contextWindow: 128_000, percent: 100 });
});

test("Context status exposes approximate counts, a native dialog popover, and localized composition", () => {
  const store = new SnapshotStore({ sessionId: "session-a", view: view(), loading: false, error: null });
  const html = renderToStaticMarkup(createElement(ContextOccupancyStatus, { model: store, sessionId: "session-a" }));
  assert.match(html, /上下文约已用 25%/u);
  assert.match(html, /~25%/u);
  assert.match(html, /popover="auto" role="dialog"/u);
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/u);
  assert.match(html, /系统提示词/u); assert.match(html, /工具定义/u); assert.match(html, /对话消息/u);
  assert.match(html, /分项为近似值/u);
  assert.match(html, /fixture-model/u);
  assert.equal(renderToStaticMarkup(createElement(ContextOccupancyStatus, { model: store, sessionId: "session-b" })), "");
  store.publish({ ...store.getSnapshot(), view: view("session-a", { status: "unknown", usedTokens: undefined }) });
  assert.equal(renderToStaticMarkup(createElement(ContextOccupancyStatus, { model: store, sessionId: "session-a" })), "");
  store.publish({ ...store.getSnapshot(), view: view("session-a", { usedTokens: 0 }) });
  assert.match(renderToStaticMarkup(createElement(ContextOccupancyStatus, { model: store, sessionId: "session-a" })), /~0%/u);
});

test("Context observer refreshes after request projection and Step completion without fetching per text token", async () => {
  const f = fixture(), observer = new ContextOccupancyClientModel(f.connection, f.sessions);
  try {
    await observer.refresh();
    const initial = f.requests.length;
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [streamEvent(1, "start")] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.requests.length, initial + 1);
    const beforeText = f.requests.length;
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [streamEvent(1, "start"), streamEvent(2, "text"), streamEvent(3, "text")] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.requests.length, beforeText);
    f.sessions.run.publish({ runId: "run-a", terminal: false, events: [streamEvent(1, "start"), streamEvent(2, "text"), streamEvent(3, "text"), transition(4, "step.completed")] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.requests.length, beforeText + 1);
    const beforeHistory = f.requests.length;
    f.sessions.publish({ ...f.sessions.getSnapshot(), sessions: [{ sessionId: "session-a", historyRevision: "r2" }] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.requests.length, beforeHistory + 1);
    assert.match(f.requests.at(-1), /\/api\/sessions\/session-a\/controls\/context-occupancy$/u);
  } finally { observer.close(); }
});

test("a stale Session read and an old Host generation cannot restore a previous meter", async () => {
  let release;
  const f = fixture(path => path.includes("session-a")
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ value: view("session-b") }));
  const observer = new ContextOccupancyClientModel(f.connection, f.sessions);
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

test("mismatched or failed reads hide the meter and lifecycle removal releases observers and the seat", async () => {
  const f = fixture(async () => ({ value: view("other-session") }));
  const slots = new UiSlots(), disposers = [];
  ContextOccupancyClientUi.apply({ wishConnection: f.connection, wishSession: f.sessions, wishUiSlots: slots,
    effect: register => { const remove = register(); disposers.push(remove); } });
  assert.deepEqual(slots.getSnapshot().sessionStatusItems.map(item => item.id), ["context-occupancy"]);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(f.invalidations.size, 0);
  assert.deepEqual(slots.getSnapshot().sessionStatusItems, []);

  const observer = new ContextOccupancyClientModel(f.connection, f.sessions);
  await observer.refresh();
  assert.equal(observer.getSnapshot().view, null);
  assert.ok(observer.getSnapshot().error);
  observer.close();
  const before = f.requests.length;
  f.sessions.publish({ selectedId: "session-b", sessions: [] });
  f.sessions.run.publish({ runId: "run-b", events: [streamEvent(1, "start")], terminal: false });
  await observer.refresh();
  assert.equal(f.requests.length, before);
});

test("background read failures retain a verified estimate while newer unknown readings and revocation still apply", async () => {
  let response = view(), failure;
  const f = fixture(async () => { if (failure) throw failure; return { value: response }; });
  const observer = new ContextOccupancyClientModel(f.connection, f.sessions);
  try {
    await observer.refresh();
    const verified = observer.getSnapshot().view;
    failure = new ClientApiError("context_occupancy_unavailable", 503);
    await observer.refresh();
    assert.equal(observer.getSnapshot().view, verified);
    assert.equal(observer.getSnapshot().error, "context_occupancy_unavailable");
    failure = undefined;
    response = view("other-session");
    await observer.refresh();
    assert.equal(observer.getSnapshot().view, verified);
    assert.ok(observer.getSnapshot().error);
    response = view("session-a", { usedTokens: 16_000 });
    await observer.refresh();
    assert.equal(observer.getSnapshot().view.usedTokens, 16_000);
    assert.equal(observer.getSnapshot().error, null);
    response = view("session-a", { status: "unknown", usedTokens: undefined });
    await observer.refresh();
    assert.equal(contextOccupancy(observer.getSnapshot().view), null);
    response = view();
    for (const [code, status] of [["control_not_found", 404], ["session_not_found", 404], ["forbidden", 403], ["unauthorized", 401]]) {
      failure = undefined;
      await observer.refresh();
      assert.equal(observer.getSnapshot().view.sessionId, "session-a");
      failure = new ClientApiError(code, status);
      await observer.refresh();
      assert.equal(observer.getSnapshot().view, null);
    }
  } finally { observer.close(); }
});
