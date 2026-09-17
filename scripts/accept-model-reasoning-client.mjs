import assert from "node:assert/strict";
import test from "node:test";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { ReasoningClientModel } from "../dist/models/consumers/webui/reasoning-model.js";
import { NewSessionReasoningClientModel } from "../dist/models/consumers/webui/new-session-reasoning-model.js";

test("Models client selection follows Session and connection, without owning the conversation", async () => {
  const requests = [];
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a", error: null });
  const invalidations = new Set();
  connection.onInvalidation = listener => { invalidations.add(listener); return () => invalidations.delete(listener); };
  connection.request = async (path, body) => {
    requests.push({ path, body });
    const sessionId = path.split("/")[3];
    const selected = body ? body.effort ?? undefined : choices.get(sessionId);
    if (body) choices.set(sessionId, selected);
    return { selection: {
      model: { provider: "deepseek", model: "deepseek-flash" },
      control: { format: "deepseek-chat", efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
      ...(selected == null ? {} : { selected }),
    } };
  };
  const choices = new Map();
  const sessions = new SnapshotStore({ selectedId: "session-a" });
  const reasoning = new ReasoningClientModel(connection, sessions);
  try {
    await reasoning.refresh();
    assert.equal(reasoning.getSnapshot().sessionId, "session-a");
    assert.equal(reasoning.getSnapshot().view.control.defaultEffort, "high");
    await reasoning.select("low");
    assert.equal(choices.get("session-a"), "low");
    assert.equal(reasoning.getSnapshot().view.selected, "low");
    await reasoning.select("high");
    assert.equal(requests.at(-1).body.effort, null, "selecting the visible model default clears the Session override");
    assert.equal(reasoning.getSnapshot().view.selected, undefined);
    await reasoning.select("low");
    sessions.publish({ selectedId: "session-b" });
    await reasoning.refresh();
    assert.equal(reasoning.getSnapshot().view.selected, undefined);
    sessions.publish({ selectedId: "session-a" });
    await reasoning.refresh();
    assert.equal(reasoning.getSnapshot().view.selected, "low");
    connection.publish({ online: false, businessAvailable: false, instanceId: "host-a", error: null });
    assert.equal(reasoning.getSnapshot().sessionId, null);
    assert.equal(reasoning.getSnapshot().view, null);
    connection.publish({ online: true, businessAvailable: true, instanceId: "host-b", error: null });
    await reasoning.refresh();
    assert.equal(reasoning.getSnapshot().view.selected, "low");
    assert.ok(requests.some(request => request.path.endsWith("/session-a/model-reasoning") && request.body?.effort === "low"));
  } finally { reasoning.close(); }
});

test("composer contribution is removed with its owner", () => {
  const slots = new UiSlots();
  const remove = slots.composer({ id: "model-reasoning", View: () => null });
  const removeNew = slots.newSessionComposer({ id: "model-reasoning", View: () => null });
  assert.deepEqual(slots.getSnapshot().composerItems.map(item => item.id), ["model-reasoning"]);
  assert.deepEqual(slots.getSnapshot().newSessionComposerItems.map(item => item.id), ["model-reasoning"]);
  remove(); removeNew();
  assert.deepEqual(slots.getSnapshot().composerItems, []);
  assert.deepEqual(slots.getSnapshot().newSessionComposerItems, []);
});

test("pre-Session reasoning is browser-local until the first message and resets on model change", async () => {
  const requests = [];
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a" });
  const settings = new SnapshotStore({ sections: [] });
  connection.onInvalidation = () => () => {};
  let modelName = "deepseek-flash";
  connection.request = async (path, body) => {
    requests.push({ path, body });
    if (path === "/api/model-reasoning/default") return { selection: { model: { provider: "deepseek", model: modelName },
      control: { format: "deepseek-chat", efforts: ["none", "low", "high", "max"], defaultEffort: "high" } } };
    if (path === "/api/sessions/new/model-reasoning") return { selection: { selected: body.effort } };
    throw Error(`Unexpected ${path}`);
  };
  const reasoning = new NewSessionReasoningClientModel(connection, settings);
  try {
    await reasoning.refresh();
    assert.equal(reasoning.getSnapshot().view.model.model, "deepseek-flash");
    reasoning.select("high");
    assert.equal(reasoning.getSnapshot().selected, null, "the displayed default does not create a first-Run override");
    assert.equal(reasoning.capture(), undefined);
    reasoning.select("low");
    assert.equal(requests.some(request => request.body?.effort === "low"), false, "no Host Session exists yet");
    const prepare = reasoning.capture();
    assert.equal(typeof prepare, "function");
    await prepare("new");
    assert.deepEqual(requests.at(-1), { path: "/api/sessions/new/model-reasoning", body: { model: { provider: "deepseek", model: "deepseek-flash" }, effort: "low" } });
    reasoning.reset();
    assert.equal(reasoning.getSnapshot().selected, null, "a fresh new-Session intent starts from the model default");
    reasoning.select("low");
    modelName = "deepseek-reasoner";
    await reasoning.refresh();
    assert.equal(reasoning.getSnapshot().selected, null);
    assert.equal(reasoning.capture(), undefined);
  } finally { reasoning.close(); }
});
